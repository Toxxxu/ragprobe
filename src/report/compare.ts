import { readFile } from 'node:fs/promises';
import { RagprobeError } from '../core/errors.js';
import type { CaseResult, RunReport } from '../core/types.js';

export interface MetricChange {
  readonly name: string;
  readonly base: number;
  readonly head: number;
  /** Change in the "better" direction: negative means worse. */
  readonly delta: number;
}

export interface CaseChange {
  readonly id: string;
  readonly change: string;
}

export interface Comparison {
  readonly metrics: readonly MetricChange[];
  readonly regressions: readonly CaseChange[];
  readonly improvements: readonly CaseChange[];
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface CompareOptions {
  /** Largest allowed worsening of any summary metric, from 0 to 1. */
  readonly maxDrop?: number;
}

/** Reads a `report.json` written by `ragprobe run`. */
export async function loadReport(file: string): Promise<RunReport> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new RagprobeError(code === 'ENOENT' ? `report not found: ${file}` : `cannot read report ${file}`, { cause: err });
  }
  const report = json as Partial<RunReport> | null;
  if (report?.meta?.tool !== 'ragprobe' || !report.summary || !Array.isArray(report.results)) {
    throw new RagprobeError(`${file} is not a ragprobe report.json`);
  }
  return report as RunReport;
}

/** Compares a run against a baseline run of the same dataset. */
export function compareReports(base: RunReport, head: RunReport, opts: CompareOptions = {}): Comparison {
  if (base.summary.k !== head.summary.k) {
    throw new RagprobeError(`cannot compare runs with different k (${base.summary.k} and ${head.summary.k})`);
  }
  const k = head.summary.k;
  const b = base.summary;
  const h = head.summary;

  const metrics: MetricChange[] = [
    higherIsBetter(`recall@${k}`, b.retrieval.recallAtK, h.retrieval.recallAtK),
    higherIsBetter(`hit rate@${k}`, b.retrieval.hitRate, h.retrieval.hitRate),
    higherIsBetter(`MRR@${k}`, b.retrieval.mrr, h.retrieval.mrr),
    higherIsBetter(`nDCG@${k}`, b.retrieval.ndcgAtK, h.retrieval.ndcgAtK),
  ];
  if (b.judge && h.judge) {
    metrics.push(
      higherIsBetter('faithfulness', b.judge.faithfulness, h.judge.faithfulness),
      higherIsBetter('relevance', b.judge.relevance, h.judge.relevance),
    );
  }
  metrics.push({ name: 'error rate', base: b.errorRate, head: h.errorRate, delta: b.errorRate - h.errorRate });

  const failures =
    opts.maxDrop === undefined
      ? []
      : metrics
          .filter((m) => -m.delta > (opts.maxDrop as number) + 1e-9)
          .map((m) => `${m.name} worsened by ${fmt(-m.delta)} (${fmt(m.base)} → ${fmt(m.head)}), more than the allowed ${fmt(opts.maxDrop as number)}`);

  const baseById = new Map(base.results.map((r) => [r.testCase.id, r]));
  const regressions: CaseChange[] = [];
  const improvements: CaseChange[] = [];
  for (const now of head.results) {
    const before = baseById.get(now.testCase.id);
    if (!before) continue;
    const changes = caseChanges(before, now, k);
    const worse = changes.filter((c) => c.worse).map((c) => c.text);
    const better = changes.filter((c) => !c.worse).map((c) => c.text);
    if (worse.length > 0) regressions.push({ id: now.testCase.id, change: worse.join(', ') });
    if (better.length > 0) improvements.push({ id: now.testCase.id, change: better.join(', ') });
  }

  return { metrics, regressions, improvements, passed: failures.length === 0, failures };
}

export function renderComparison(cmp: Comparison, maxCases = 10): string {
  const lines: string[] = ['## Compared with baseline', ''];
  if (cmp.failures.length > 0) {
    lines.push('**Regression check: failed**', '', ...cmp.failures.map((f) => `- ${f}`), '');
  }

  lines.push('| Metric | Baseline | Now | Change |', '| --- | --- | --- | --- |');
  for (const m of cmp.metrics) {
    lines.push(`| ${m.name} | ${fmt(m.base)} | ${fmt(m.head)} | ${arrow(m)} |`);
  }
  lines.push('');

  for (const [title, list] of [
    ['Cases that got worse', cmp.regressions],
    ['Cases that got better', cmp.improvements],
  ] as const) {
    if (list.length === 0) continue;
    lines.push(`### ${title} (${list.length})`, '');
    for (const c of list.slice(0, maxCases)) lines.push(`- \`${c.id}\`: ${c.change}`);
    if (list.length > maxCases) lines.push(`- …and ${list.length - maxCases} more`);
    lines.push('');
  }
  return lines.join('\n');
}

function caseChanges(before: CaseResult, now: CaseResult, k: number): { worse: boolean; text: string }[] {
  if (before.status === 'error' && now.status === 'error') return [];
  if (now.status === 'error') return [{ worse: true, text: `now fails (${now.error})` }];
  if (before.status === 'error') return [{ worse: false, text: 'no longer fails' }];

  const out: { worse: boolean; text: string }[] = [];
  const recall = now.retrieval.recallAtK - before.retrieval.recallAtK;
  if (Math.abs(recall) > 1e-9) {
    out.push({ worse: recall < 0, text: `recall@${k} ${pct(before.retrieval.recallAtK)} → ${pct(now.retrieval.recallAtK)}` });
  }
  if (before.judge?.status === 'ok' && now.judge?.status === 'ok') {
    for (const field of ['faithfulness', 'relevance'] as const) {
      const was = before.judge.verdict[field];
      const is = now.judge.verdict[field];
      if (Math.abs(is - was) > 1e-9) out.push({ worse: is < was, text: `${field} ${pct(was)} → ${pct(is)}` });
    }
  }
  return out;
}

function higherIsBetter(name: string, base: number, head: number): MetricChange {
  return { name, base, head, delta: head - base };
}

function arrow(m: MetricChange): string {
  if (Math.abs(m.delta) < 0.0005) return '–';
  const raw = m.head - m.base;
  return `${raw > 0 ? '+' : '−'}${fmt(Math.abs(raw))} ${m.delta > 0 ? '▲ better' : '▼ worse'}`;
}

const fmt = (n: number) => n.toFixed(3);
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
