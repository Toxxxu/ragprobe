#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { RagprobeError } from './core/errors.js';
import { loadDataset } from './dataset/load.js';
import { OllamaJudge } from './judge/ollama.js';
import type { Judge } from './judge/types.js';
import { HttpPipeline } from './pipeline/http.js';
import { checkGate, type Thresholds } from './runner/gate.js';
import { runEvaluation } from './runner/runner.js';
import { renderMarkdown } from './report/markdown.js';
import { writeReports } from './report/write.js';
import { VERSION } from './version.js';

/** Exit codes: 0 = passed, 1 = quality gate failed, 2 = usage or runtime error. */
const EXIT_GATE_FAILED = 1;
const EXIT_ERROR = 2;

const HELP = `ragprobe ${VERSION} — evaluate a RAG pipeline

Usage:
  ragprobe run --dataset <file.jsonl> --endpoint <url> [options]

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

Quality gate (exit code 1 when any is missed):
  --min-recall <0..1>   --min-mrr <0..1>   --min-ndcg <0..1>
  --min-faithfulness <0..1>   --min-relevance <0..1>   --max-error-rate <0..1>

Output:
  --out <dir>               Write report.json and report.md (default ./reports)
  --quiet                   Only print the summary
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dataset: { type: 'string' },
      endpoint: { type: 'string' },
      header: { type: 'string', multiple: true },
      k: { type: 'string' },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      judge: { type: 'string' },
      'judge-model': { type: 'string' },
      'ollama-url': { type: 'string' },
      'min-recall': { type: 'string' },
      'min-mrr': { type: 'string' },
      'min-ndcg': { type: 'string' },
      'min-faithfulness': { type: 'string' },
      'min-relevance': { type: 'string' },
      'max-error-rate': { type: 'string' },
      out: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || positionals[0] !== 'run') {
    console.log(HELP);
    return values.help ? 0 : EXIT_ERROR;
  }
  if (!values.dataset || !values.endpoint) throw new UsageError('--dataset and --endpoint are required');

  const k = int(values.k, 'k', 5);
  const cases = await loadDataset(values.dataset);
  const pipeline = new HttpPipeline({ url: values.endpoint, headers: parseHeaders(values.header ?? []) });
  const judge = makeJudge(values.judge, values['judge-model'], values['ollama-url']);
  const thresholds = pickThresholds(values);

  const log = (msg: string) => values.quiet || process.stderr.write(msg);
  log(`Evaluating ${cases.length} cases against ${values.endpoint}${judge ? ` (judge: ${judge.name})` : ''}\n`);

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('Interrupted')));

  const report = await runEvaluation(cases, {
    pipeline,
    ...(judge ? { judge } : {}),
    k,
    concurrency: int(values.concurrency, 'concurrency', 4),
    timeoutMs: int(values.timeout, 'timeout', 30_000),
    signal: controller.signal,
    onResult: (r, done, total) => {
      const mark = r.status === 'error' ? 'x' : '.';
      log(`\r  ${done}/${total} ${mark}`);
      if (done === total) log('\n');
    },
  });

  const gate = Object.keys(thresholds).length > 0 ? checkGate(report.summary, thresholds) : undefined;
  const files = await writeReports(values.out ?? 'reports', report, gate);

  console.log(renderMarkdown(report, gate));
  log(`Reports written to ${files.json} and ${files.markdown}\n`);
  return gate && !gate.passed ? EXIT_GATE_FAILED : 0;
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

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const known = err instanceof RagprobeError || (err instanceof Error && 'code' in err && String(err.code).startsWith('ERR_PARSE_ARGS'));
    console.error(known ? `ragprobe: ${(err as Error).message}` : err);
    process.exitCode = EXIT_ERROR;
  },
);
