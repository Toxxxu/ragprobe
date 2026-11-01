import type { CaseResult, RunReport } from '../core/types.js';
import type { GateResult } from '../runner/gate.js';

/**
 * Renders a run as GitHub-flavoured Markdown. The same output works in a
 * terminal, a PR comment, or `$GITHUB_STEP_SUMMARY`.
 */
export function renderMarkdown(report: RunReport, gate?: GateResult, worstN = 5): string {
  const { summary: s, meta } = report;
  const lines: string[] = [];

  lines.push('## ragprobe report', '');
  if (gate) {
    lines.push(gate.passed ? '**Quality gate: passed**' : '**Quality gate: failed**', '');
    for (const f of gate.failures) lines.push(`- ${f}`);
    if (gate.failures.length > 0) lines.push('');
  }

  lines.push(
    `Pipeline \`${meta.pipeline}\` · judge \`${meta.judge ?? 'none'}\` · ${s.total} cases · ${(meta.durationMs / 1000).toFixed(1)}s`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| recall@${s.k} | ${pct(s.retrieval.recallAtK)} |`,
    `| precision@${s.k} | ${pct(s.retrieval.precisionAtK)} |`,
    `| hit rate@${s.k} | ${pct(s.retrieval.hitRate)} |`,
    `| MRR@${s.k} | ${s.retrieval.mrr.toFixed(3)} |`,
    `| nDCG@${s.k} | ${s.retrieval.ndcgAtK.toFixed(3)} |`,
  );
  if (s.judge) {
    lines.push(
      `| faithfulness | ${pct(s.judge.faithfulness)} (${s.judge.judged} judged, ${s.judge.errors} errors) |`,
      `| relevance | ${pct(s.judge.relevance)} |`,
    );
  }
  lines.push(
    `| errors | ${s.failed} / ${s.total} |`,
    `| latency p50 / p95 | ${ms(s.latency.p50)} / ${ms(s.latency.p95)} |`,
    '',
  );

  const worst = worstCases(report.results, worstN);
  if (worst.length > 0) {
    lines.push('### Weakest cases', '', '| Case | Recall | MRR | Faithfulness | Note |', '| --- | --- | --- | --- | --- |');
    for (const r of worst) lines.push(caseRow(r));
    lines.push('');
  }

  return lines.join('\n');
}

/** Errors first, then lowest recall, then lowest faithfulness. */
export function worstCases(results: readonly CaseResult[], n: number): CaseResult[] {
  const score = (r: CaseResult) => {
    if (r.status === 'error') return -1;
    const faith = r.judge?.status === 'ok' ? r.judge.verdict.faithfulness : 1;
    return r.retrieval.recallAtK + r.retrieval.mrr + faith;
  };
  return [...results]
    .filter((r) => score(r) < 3)
    .sort((a, b) => score(a) - score(b))
    .slice(0, n);
}

function caseRow(r: CaseResult): string {
  const id = `\`${escapeCell(r.testCase.id)}\``;
  if (r.status === 'error') return `| ${id} | – | – | – | error: ${escapeCell(r.error)} |`;
  const judge = r.judge;
  const faith = judge?.status === 'ok' ? pct(judge.verdict.faithfulness) : '–';
  const note = judge?.status === 'ok' ? judge.verdict.reasoning : judge?.status === 'error' ? `judge error: ${judge.error}` : '';
  return `| ${id} | ${pct(r.retrieval.recallAtK)} | ${r.retrieval.mrr.toFixed(2)} | ${faith} | ${escapeCell(note)} |`;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const ms = (n: number) => `${Math.round(n)}ms`;
const escapeCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 160);
