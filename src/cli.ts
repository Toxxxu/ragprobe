#!/usr/bin/env node
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { RagprobeError } from './core/errors.js';
import { generateTestCases, loadDocuments, toJsonl } from './dataset/generate.js';
import { loadDataset } from './dataset/load.js';
import { OllamaJudge } from './judge/ollama.js';
import type { Judge } from './judge/types.js';
import { OllamaClient } from './llm/ollama.js';
import { HttpPipeline } from './pipeline/http.js';
import { checkGate, type Thresholds } from './runner/gate.js';
import { runEvaluation } from './runner/runner.js';
import { compareReports, loadReport, renderComparison } from './report/compare.js';
import { renderMarkdown } from './report/markdown.js';
import { writeReports } from './report/write.js';
import { VERSION } from './version.js';

/** Exit codes: 0 = passed, 1 = quality gate or regression check failed, 2 = usage or runtime error. */
const EXIT_GATE_FAILED = 1;
const EXIT_ERROR = 2;

const HELP = `ragprobe ${VERSION} — test a RAG pipeline

Usage:
  ragprobe run       Evaluate a pipeline against a test set
  ragprobe compare   Compare two runs and list what got worse
  ragprobe generate  Write a test set from a folder of documents

Run "ragprobe <command> --help" for the options of a command.
`;

const RUN_HELP = `Usage: ragprobe run --dataset <file.jsonl> --endpoint <url> [options]

Pipeline:
  --dataset <path>          JSONL test set (required)
  --endpoint <url>          RAG service: POST {question} -> {answer, contexts} (required)
  --header <k:v>            Extra request header, repeatable

Evaluation:
  --k <n>                   Rank cutoff for retrieval metrics (default 5)
  --concurrency <n>         Parallel requests (default 4)
  --timeout <ms>            Per-call timeout (default 30000)

Judge (optional, local and free):
  --judge ollama            Score answers with a local Ollama model
  --judge-model <name>      Ollama model (default qwen3:8b)
  --ollama-url <url>        Ollama base URL (default http://localhost:11434)
  --judge-load-timeout <ms> Time allowed to load the model before the run (default 600000)

Quality gate (exit code 1 when any is missed):
  --min-recall <0..1>   --min-mrr <0..1>   --min-ndcg <0..1>
  --min-faithfulness <0..1>   --min-relevance <0..1>   --max-error-rate <0..1>

Regression check:
  --baseline <report.json>  Compare with an earlier run
  --max-drop <0..1>         Fail when any metric worsens by more than this

Output:
  --out <dir>               Write report.json and report.md (default ./reports)
  --quiet                   Only print the summary
`;

const COMPARE_HELP = `Usage: ragprobe compare <baseline.json> <current.json> [options]

  --max-drop <0..1>         Exit with code 1 when any metric worsens by more than this
`;

const GENERATE_HELP = `Usage: ragprobe generate --docs <dir> --out <file.jsonl> [options]

Writes test questions for every .md, .mdx and .txt file under <dir> with a local
Ollama model. Each document's ID is its path relative to <dir> without the
extension (docs/billing/refunds.md -> "billing/refunds"); your pipeline must
return the same IDs in "contexts". Review the questions before relying on them.

  --docs <dir>              Folder of documents (required)
  --out <file>              Output JSONL file (required)
  --per-doc <n>             Questions per document (default 2)
  --model <name>            Ollama model (default qwen3:8b)
  --ollama-url <url>        Ollama base URL (default http://localhost:11434)
  --concurrency <n>         Documents processed in parallel (default 2)
  --load-timeout <ms>       Time allowed to load the model (default 600000)
  --force                   Overwrite the output file if it exists
`;

const COMMON = {
  help: { type: 'boolean', short: 'h', default: false },
  quiet: { type: 'boolean', default: false },
} as const satisfies ParseArgsConfig['options'];

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }
  switch (command) {
    case 'run':
      return runCommand(rest);
    case 'compare':
      return compareCommand(rest);
    case 'generate':
      return generateCommand(rest);
    case undefined:
    case '--help':
    case '-h':
      console.log(HELP);
      return command === undefined ? EXIT_ERROR : 0;
    default:
      throw new UsageError(`unknown command "${command}". Run "ragprobe --help" for usage.`);
  }
}

async function runCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON,
      dataset: { type: 'string' },
      endpoint: { type: 'string' },
      header: { type: 'string', multiple: true },
      k: { type: 'string' },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      judge: { type: 'string' },
      'judge-model': { type: 'string' },
      'ollama-url': { type: 'string' },
      'judge-load-timeout': { type: 'string' },
      'min-recall': { type: 'string' },
      'min-mrr': { type: 'string' },
      'min-ndcg': { type: 'string' },
      'min-faithfulness': { type: 'string' },
      'min-relevance': { type: 'string' },
      'max-error-rate': { type: 'string' },
      baseline: { type: 'string' },
      'max-drop': { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (values.help) return printHelp(RUN_HELP);
  if (!values.dataset || !values.endpoint) throw new UsageError('--dataset and --endpoint are required');
  if (values['max-drop'] !== undefined && !values.baseline) throw new UsageError('--max-drop needs --baseline');

  const k = int(values.k, 'k', 5);
  const cases = await loadDataset(values.dataset);
  const baseline = values.baseline ? await loadReport(values.baseline) : undefined;
  const pipeline = new HttpPipeline({ url: values.endpoint, headers: parseHeaders(values.header ?? []) });
  const judge = makeJudge(values.judge, values['judge-model'], values['ollama-url']);
  const thresholds = pickThresholds(values);

  const log = logger(values.quiet);
  log(`Evaluating ${cases.length} cases against ${values.endpoint}${judge ? ` (judge: ${judge.name})` : ''}\n`);
  const signal = interruptSignal();

  if (judge?.warmUp) {
    log('Loading judge model (the first load can take a few minutes)...\n');
    await judge.warmUp({ signal: withTimeout(signal, int(values['judge-load-timeout'], 'judge-load-timeout', 600_000)) });
  }

  const report = await runEvaluation(cases, {
    pipeline,
    ...(judge ? { judge } : {}),
    k,
    concurrency: int(values.concurrency, 'concurrency', 4),
    timeoutMs: int(values.timeout, 'timeout', 30_000),
    signal,
    onResult: (r, done, total) => {
      log(`\r  ${done}/${total} ${r.status === 'error' ? 'x' : '.'}`);
      if (done === total) log('\n');
    },
  });

  const gate = Object.keys(thresholds).length > 0 ? checkGate(report.summary, thresholds) : undefined;
  const maxDrop = values['max-drop'] === undefined ? undefined : fraction(values['max-drop'], 'max-drop');
  const comparison = baseline ? compareReports(baseline, report, maxDrop === undefined ? {} : { maxDrop }) : undefined;
  const files = await writeReports(values.out ?? 'reports', report, { ...(gate ? { gate } : {}), ...(comparison ? { comparison } : {}) });

  console.log(renderMarkdown(report, gate));
  if (comparison) console.log(renderComparison(comparison));
  log(`Reports written to ${files.json} and ${files.markdown}\n`);
  return (gate && !gate.passed) || (comparison && !comparison.passed) ? EXIT_GATE_FAILED : 0;
}

async function compareCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...COMMON, 'max-drop': { type: 'string' } },
  });
  if (values.help) return printHelp(COMPARE_HELP);
  if (positionals.length !== 2) throw new UsageError('compare needs two report files: <baseline.json> <current.json>');

  const [baseFile = '', headFile = ''] = positionals;
  const [base, head] = await Promise.all([loadReport(baseFile), loadReport(headFile)]);
  const maxDrop = values['max-drop'] === undefined ? undefined : fraction(values['max-drop'], 'max-drop');
  const comparison = compareReports(base, head, maxDrop === undefined ? {} : { maxDrop });
  console.log(renderComparison(comparison));
  return comparison.passed ? 0 : EXIT_GATE_FAILED;
}

async function generateCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON,
      docs: { type: 'string' },
      out: { type: 'string' },
      'per-doc': { type: 'string' },
      model: { type: 'string' },
      'ollama-url': { type: 'string' },
      concurrency: { type: 'string' },
      'load-timeout': { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });
  if (values.help) return printHelp(GENERATE_HELP);
  if (!values.docs || !values.out) throw new UsageError('--docs and --out are required');
  if (!values.force && (await exists(values.out))) throw new UsageError(`${values.out} already exists (use --force to overwrite)`);

  const model = values.model ?? 'qwen3:8b';
  const docs = await loadDocuments(values.docs);
  const log = logger(values.quiet);
  const signal = interruptSignal();
  const ollama = { ...(values['ollama-url'] ? { baseUrl: values['ollama-url'] } : {}) };

  log(`Loading ${model} (the first load can take a few minutes)...\n`);
  await new OllamaClient(ollama).load(model, withTimeout(signal, int(values['load-timeout'], 'load-timeout', 600_000)));

  log(`Writing questions for ${docs.length} documents\n`);
  const result = await generateTestCases(docs, {
    ...ollama,
    model,
    perDoc: int(values['per-doc'], 'per-doc', 2),
    concurrency: int(values.concurrency, 'concurrency', 2),
    signal,
    onDocument: (_doc, done, total) => {
      log(`\r  ${done}/${total}`);
      if (done === total) log('\n');
    },
  });

  for (const f of result.failures) process.stderr.write(`  skipped ${f.id}: ${f.error}\n`);
  if (result.cases.length === 0) throw new RagprobeError('no questions were generated');

  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, toJsonl(result.cases, `Generated by ragprobe ${VERSION} with ${model} from ${values.docs}. Review before use.`));
  console.log(`Wrote ${result.cases.length} test cases from ${docs.length - result.failures.length} documents to ${values.out}`);
  return 0;
}

class UsageError extends RagprobeError {}

function makeJudge(kind: string | undefined, model: string | undefined, baseUrl: string | undefined): Judge | undefined {
  if (kind === undefined || kind === 'none') return undefined;
  if (kind !== 'ollama') throw new UsageError(`unknown judge "${kind}" (supported: ollama, none)`);
  return new OllamaJudge({ ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}) });
}

function pickThresholds(v: Record<string, unknown>): Thresholds {
  const entries: [keyof Thresholds, string][] = [
    ['minRecall', 'min-recall'],
    ['minMrr', 'min-mrr'],
    ['minNdcg', 'min-ndcg'],
    ['minFaithfulness', 'min-faithfulness'],
    ['minRelevance', 'min-relevance'],
    ['maxErrorRate', 'max-error-rate'],
  ];
  const out: Partial<Record<keyof Thresholds, number>> = {};
  for (const [key, flag] of entries) {
    const raw = v[flag];
    if (typeof raw === 'string') out[key] = fraction(raw, flag);
  }
  return out;
}

function parseHeaders(raw: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of raw) {
    const i = h.indexOf(':');
    if (i <= 0) throw new UsageError(`--header must look like "name: value", got "${h}"`);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return headers;
}

function int(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${flag} must be a positive integer, got "${raw}"`);
  return n;
}

function fraction(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new UsageError(`--${flag} must be a number from 0 to 1, got "${raw}"`);
  return n;
}

function printHelp(text: string): number {
  console.log(text);
  return 0;
}

function logger(quiet: boolean | undefined): (msg: string) => void {
  return (msg) => {
    if (!quiet) process.stderr.write(msg);
  };
}

function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('Interrupted')));
  return controller.signal;
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

main(process.argv.slice(2).filter((arg) => arg !== '--')).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const known = err instanceof RagprobeError || (err instanceof Error && 'code' in err && String(err.code).startsWith('ERR_PARSE_ARGS'));
    console.error(known ? `ragprobe: ${(err as Error).message}` : err);
    process.exitCode = EXIT_ERROR;
  },
);
