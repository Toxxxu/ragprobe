import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hitRateAtK,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  scoreRetrieval,
  topK,
} from '../src/metrics/retrieval.js';
import { mean, percentile } from '../src/metrics/stats.js';

const rel = (...ids: string[]) => new Set(ids);
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);

describe('retrieval metrics', () => {
  it('topK collapses duplicate ids to their first occurrence', () => {
    assert.deepEqual(topK(['a', 'a', 'b', 'a', 'c'], 2), ['a', 'b']);
  });

  it('recall counts relevant docs found within k', () => {
    assert.equal(recallAtK(['a', 'x', 'b'], rel('a', 'b'), 3), 1);
    assert.equal(recallAtK(['a', 'x', 'b'], rel('a', 'b'), 2), 0.5);
    assert.equal(recallAtK([], rel('a'), 5), 0);
  });

  it('precision divides by k, not by the number returned', () => {
    assert.equal(precisionAtK(['a'], rel('a'), 5), 0.2);
  });

  it('hit rate is binary', () => {
    assert.equal(hitRateAtK(['x', 'a'], rel('a'), 2), 1);
    assert.equal(hitRateAtK(['x', 'a'], rel('a'), 1), 0);
  });

  it('reciprocal rank uses the first relevant hit', () => {
    assert.equal(reciprocalRank(['x', 'y', 'a', 'b'], rel('a', 'b'), 5), 1 / 3);
    assert.equal(reciprocalRank(['x', 'y', 'a'], rel('a'), 2), 0);
  });

  it('nDCG is 1 for a perfect ranking and penalises late hits', () => {
    close(ndcgAtK(['a', 'b', 'x'], rel('a', 'b'), 3), 1);
    // single relevant doc at rank 2: (1/log2(3)) / 1
    close(ndcgAtK(['x', 'a'], rel('a'), 3), 1 / Math.log2(3));
  });

  it('duplicates do not inflate scores', () => {
    const s = scoreRetrieval(['a', 'a', 'a'], ['a'], 3);
    close(s.precisionAtK, 1 / 3);
    close(s.ndcgAtK, 1);
  });

  it('rejects invalid input', () => {
    assert.throws(() => topK(['a'], 0), RangeError);
    assert.throws(() => recallAtK(['a'], rel(), 3), RangeError);
    assert.throws(() => recallAtK(['a'], [], 3), RangeError);
  });

  it('accepts relevant ids as an array or a Set', () => {
    const retrieved = ['x', 'a', 'b'];
    assert.equal(recallAtK(retrieved, ['a', 'b', 'c'], 3), recallAtK(retrieved, new Set(['a', 'b', 'c']), 3));
    assert.equal(ndcgAtK(retrieved, ['a'], 3), ndcgAtK(retrieved, new Set(['a']), 3));
  });
});

describe('stats', () => {
  it('mean of empty is 0', () => assert.equal(mean([]), 0));

  it('percentile interpolates between ranks', () => {
    assert.equal(percentile([10, 20, 30, 40], 50), 25);
    assert.equal(percentile([5], 95), 5);
    assert.equal(percentile([3, 1, 2], 100), 3);
  });
});
