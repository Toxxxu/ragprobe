import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sleep } from '../src/core/async.js';
import type { PipelineOutput, TestCase } from '../src/core/types.js';
import type { Judge } from '../src/judge/types.js';
import type { RagPipeline } from '../src/pipeline/types.js';
import { checkGate } from '../src/runner/gate.js';
import { runEvaluation } from '../src/runner/runner.js';
import { renderMarkdown } from '../src/report/markdown.js';

const cases: TestCase[] = [
  { id: 'good', question: 'good?', relevantDocIds: ['d1'] },
  { id: 'miss', question: 'miss?', relevantDocIds: ['d9'] },
  { id: 'boom', question: 'boom?', relevantDocIds: ['d1'] },
];

function fakePipeline(delayMs = 0): RagPipeline & { maxInFlight: number } {
  let inFlight = 0;
  const p = {
    name: 'fake',
    maxInFlight: 0,
    async query(question: string): Promise<PipelineOutput> {
      inFlight++;
      p.maxInFlight = Math.max(p.maxInFlight, inFlight);
      try {
        await sleep(delayMs);
        if (question === 'boom?') throw new Error('upstream exploded');
        return { answer: `answer to ${question}`, contexts: [{ id: 'd1', content: 'doc one' }] };
      } finally {
        inFlight--;
      }
    },
  };
  return p;
}

const fixedJudge: Judge = {
  name: 'fixed',
  evaluate: async ({ question }) => {
    if (question === 'miss?') throw new Error('judge unavailable');
    return { faithfulness: 1, relevance: 0.5, reasoning: 'ok' };
  },
};

describe('runEvaluation', () => {
  it('records per-case errors without aborting the run', async () => {
    const report = await runEvaluation(cases, { pipeline: fakePipeline(), k: 3 });
    const s = report.summary;

    assert.equal(s.total, 3);
    assert.equal(s.succeeded, 2);
    assert.equal(s.failed, 1);
    assert.equal(report.results[2]?.status, 'error');
    assert.deepEqual(
      report.results.map((r) => r.testCase.id),
      ['good', 'miss', 'boom'],
      'keeps input order',
    );
    assert.equal(s.retrieval.recallAtK, 0.5, 'averages only successful cases');
    assert.equal(s.judge, undefined);
  });

  it('respects the concurrency limit', async () => {
    const pipeline = fakePipeline(10);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, question: 'q', relevantDocIds: ['d1'] }));
    await runEvaluation(many, { pipeline, concurrency: 3 });
    assert.equal(pipeline.maxInFlight, 3);
  });

  it('times out slow pipelines per call', async () => {
    const slow: RagPipeline = {
      name: 'slow',
      query: (_q, { signal }) => sleep(1_000, signal).then(() => ({ answer: '', contexts: [] })),
    };
    const report = await runEvaluation([cases[0] as TestCase], { pipeline: slow, timeoutMs: 20 });
    const r = report.results[0];
    assert.equal(r?.status, 'error');
    assert.equal(r?.status === 'error' && r.error, 'Timed out');
  });

  it('aggregates judge verdicts and counts judge errors separately', async () => {
    const report = await runEvaluation(cases, { pipeline: fakePipeline(), judge: fixedJudge });
    assert.deepEqual(report.summary.judge, { judged: 1, errors: 1, faithfulness: 1, relevance: 0.5 });
    assert.equal(report.meta.judge, 'fixed');
  });
});

describe('checkGate', () => {
  it('passes and fails against thresholds', async () => {
    const report = await runEvaluation(cases, { pipeline: fakePipeline(), k: 3 });

    assert.deepEqual(checkGate(report.summary, { minRecall: 0.5 }), { passed: true, failures: [] });

    const failed = checkGate(report.summary, { minRecall: 0.9, maxErrorRate: 0.1, minFaithfulness: 0.5 });
    assert.equal(failed.passed, false);
    assert.equal(failed.failures.length, 3);
    assert.match(failed.failures.join('\n'), /recall@3 0\.500 is below the minimum of 0\.900/);
    assert.match(failed.failures.join('\n'), /no answers were judged/);
  });
});

describe('renderMarkdown', () => {
  it('lists the gate result and the weakest cases first', async () => {
    const report = await runEvaluation(cases, { pipeline: fakePipeline(), k: 3 });
    const md = renderMarkdown(report, checkGate(report.summary, { minRecall: 0.9 }));
    assert.match(md, /Quality gate: failed/);
    assert.ok(md.indexOf('`boom`') < md.indexOf('`miss`'), 'errors sort before low recall');
    assert.doesNotMatch(md, /`good`/);
  });

  it('counts an off-topic answer as weak even when retrieval is perfect', async () => {
    const offTopic: Judge = { name: 'off-topic', evaluate: async () => ({ faithfulness: 1, relevance: 0, reasoning: 'answers a different question' }) };
    const report = await runEvaluation([cases[0] as TestCase], { pipeline: fakePipeline(), judge: offTopic, k: 3 });
    assert.match(renderMarkdown(report), /\| `good` \| 100\.0% \| 1\.00 \| 100\.0% \| 0\.0% \| answers a different question \|/);
  });
});
