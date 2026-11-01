import type { RetrievalScores } from '../core/types.js';

/**
 * Retrieval metrics with binary relevance. All functions take the
 * retrieved IDs in rank order and only consider the top `k`.
 *
 * Duplicate IDs are collapsed to their first occurrence: many pipelines
 * return several chunks of the same document, and counting each chunk as
 * a separate hit would inflate precision and nDCG.
 */

export function topK(retrievedIds: readonly string[], k: number): string[] {
  assertK(k);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of retrievedIds) {
    if (out.length === k) break;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Fraction of relevant documents found in the top k. */
export function recallAtK(retrievedIds: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  assertRelevant(relevant);
  return countHits(topK(retrievedIds, k), relevant) / relevant.size;
}

/** Fraction of the top k slots filled with relevant documents. */
export function precisionAtK(retrievedIds: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  return countHits(topK(retrievedIds, k), relevant) / k;
}

/** 1 if any relevant document appears in the top k, else 0. */
export function hitRateAtK(retrievedIds: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  return topK(retrievedIds, k).some((id) => relevant.has(id)) ? 1 : 0;
}

/** Reciprocal rank of the first relevant document within the top k (MRR@k). */
export function reciprocalRank(retrievedIds: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  const index = topK(retrievedIds, k).findIndex((id) => relevant.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/** Normalised discounted cumulative gain at k. */
export function ndcgAtK(retrievedIds: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  assertRelevant(relevant);
  const dcg = topK(retrievedIds, k).reduce((sum, id, i) => (relevant.has(id) ? sum + 1 / Math.log2(i + 2) : sum), 0);
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i++) idcg += 1 / Math.log2(i + 2);
  return dcg / idcg;
}

export function scoreRetrieval(
  retrievedIds: readonly string[],
  relevantIds: readonly string[],
  k: number,
): RetrievalScores {
  const relevant = new Set(relevantIds);
  return {
    recallAtK: recallAtK(retrievedIds, relevant, k),
    precisionAtK: precisionAtK(retrievedIds, relevant, k),
    hitRate: hitRateAtK(retrievedIds, relevant, k),
    mrr: reciprocalRank(retrievedIds, relevant, k),
    ndcgAtK: ndcgAtK(retrievedIds, relevant, k),
  };
}

function countHits(ids: readonly string[], relevant: ReadonlySet<string>): number {
  return ids.reduce((n, id) => (relevant.has(id) ? n + 1 : n), 0);
}

function assertK(k: number): void {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k must be a positive integer, got ${k}`);
}

function assertRelevant(relevant: ReadonlySet<string>): void {
  if (relevant.size === 0) throw new RangeError('at least one relevant document id is required');
}
