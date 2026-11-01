import type { RunSummary } from '../core/types.js';

export interface Thresholds {
  readonly minRecall?: number;
  readonly minMrr?: number;
  readonly minNdcg?: number;
  readonly minFaithfulness?: number;
  readonly minRelevance?: number;
  readonly maxErrorRate?: number;
}

export interface GateResult {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

/** Compares a run summary against quality thresholds, for use as a CI gate. */
export function checkGate(summary: RunSummary, t: Thresholds): GateResult {
  const failures: string[] = [];
  const k = summary.k;

  atLeast(`recall@${k}`, summary.retrieval.recallAtK, t.minRecall);
  atLeast(`MRR@${k}`, summary.retrieval.mrr, t.minMrr);
  atLeast(`nDCG@${k}`, summary.retrieval.ndcgAtK, t.minNdcg);

  if (t.minFaithfulness !== undefined || t.minRelevance !== undefined) {
    if (!summary.judge || summary.judge.judged === 0) {
      failures.push('judge thresholds were set but no answers were judged');
    } else {
      atLeast('faithfulness', summary.judge.faithfulness, t.minFaithfulness);
      atLeast('relevance', summary.judge.relevance, t.minRelevance);
    }
  }

  if (t.maxErrorRate !== undefined && summary.errorRate > t.maxErrorRate) {
    failures.push(`error rate ${fmt(summary.errorRate)} is above the limit of ${fmt(t.maxErrorRate)}`);
  }

  return { passed: failures.length === 0, failures };

  function atLeast(label: string, actual: number, min: number | undefined): void {
    if (min !== undefined && actual < min) failures.push(`${label} ${fmt(actual)} is below the minimum of ${fmt(min)}`);
  }
}

const fmt = (n: number) => n.toFixed(3);
