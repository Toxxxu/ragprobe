import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { RunReport, TestCase } from '../src/core/types.js';
import type { RagPipeline } from '../src/pipeline/types.js';
import { compareReports, loadReport, renderComparison } from '../src/report/compare.js';
import { runEvaluation } from '../src/runner/runner.js';

const cases: TestCase[] = [
  { id: 'a', question: 'a?', relevantDocIds: ['d1'] },
  { id: 'b', question: 'b?', relevantDocIds: ['d2'] },
  { id: 'c', question: 'c?', relevantDocIds: ['d3'] },
];

/** A pipeline that retrieves the right document only for the listed questions. */
function pipeline(correctFor: string[], failFor: string[] = []): RagPipeline {
  return {
    name: 'fake',
    async query(question) {
      if (failFor.includes(question)) throw new Error('down');
      const id = { 'a?': 'd1', 'b?': 'd2', 'c?': 'd3' }[question] ?? 'x';
      return { answer: 'ok', contexts: [{ id: correctFor.includes(question) ? id : 'wrong', content: '' }] };
    },
  };
}

const run = (p: RagPipeline) => runEvaluation(cases, { pipeline: p, k: 3 });

describe('compareReports', () => {
  it('reports metric deltas and the cases that changed', async () => {
    const base = await run(pipeline(['a?', 'b?']));
    const head = await run(pipeline(['a?', 'c?']));
    const cmp = compareReports(base, head);

    const recall = cmp.metrics.find((m) => m.name === 'recall@3');
    assert.equal(recall?.delta, 0);
    assert.deepEqual(cmp.regressions, [{ id: 'b', change: 'recall@3 100% → 0%' }]);
    assert.deepEqual(cmp.improvements, [{ id: 'c', change: 'recall@3 0% → 100%' }]);
    assert.equal(cmp.passed, true);
  });

  it('fails when a metric drops more than maxDrop, including a rising error rate', async () => {
    const base = await run(pipeline(['a?', 'b?', 'c?']));
    const head = await run(pipeline(['a?'], ['c?']));

    const strict = compareReports(base, head, { maxDrop: 0.05 });
    assert.equal(strict.passed, false);
    assert.ok(strict.failures.some((f) => f.startsWith('recall@3 worsened by 0.500')));
    assert.ok(strict.failures.some((f) => f.startsWith('error rate worsened by 0.333')));
    assert.deepEqual(strict.regressions, [
      { id: 'b', change: 'recall@3 100% → 0%' },
      { id: 'c', change: 'now fails (down)' },
    ]);

    assert.equal(compareReports(base, head, { maxDrop: 0.5 }).passed, true);
  });

  it('lists each changed case once with all of its changes', async () => {
    const judged = (relevance: number) =>
      runEvaluation(cases, {
        pipeline: pipeline(relevance === 1 ? ['a?'] : []),
        judge: { name: 'fixed', evaluate: async () => ({ faithfulness: 1, relevance, reasoning: '' }) },
        k: 3,
      });
    const cmp = compareReports(await judged(0), await judged(1));
    assert.deepEqual(cmp.improvements[0], { id: 'a', change: 'recall@3 0% → 100%, relevance 0% → 100%' });
    assert.equal(cmp.improvements.length, 3);
  });

  it('refuses to compare runs with different k', async () => {
    const base = await run(pipeline(['a?']));
    const head = await runEvaluation(cases, { pipeline: pipeline(['a?']), k: 5 });
    assert.throws(() => compareReports(base, head), /different k/);
  });

  it('renders a table and the changed cases', async () => {
    const md = renderComparison(compareReports(await run(pipeline(['a?', 'b?'])), await run(pipeline(['a?']))));
    assert.match(md, /\| recall@3 \| 0\.667 \| 0\.333 \| −0\.333 ▼ worse \|/);
    assert.match(md, /### Cases that got worse \(1\)/);
  });
});

describe('loadReport', () => {
  it('loads a report.json and rejects other JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ragprobe-'));
    const good = join(dir, 'report.json');
    const bad = join(dir, 'other.json');
    const report: RunReport = await run(pipeline(['a?']));
    await writeFile(good, JSON.stringify(report));
    await writeFile(bad, '{"hello": 1}');

    assert.equal((await loadReport(good)).summary.total, 3);
    await assert.rejects(loadReport(bad), /not a ragprobe report/);
    await assert.rejects(loadReport(join(dir, 'missing.json')), /report not found/);
  });
});
