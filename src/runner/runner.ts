import { mapWithConcurrency } from '../core/async.js';
import { errorMessage } from '../core/errors.js';
import type { CaseResult, JudgeOutcome, PipelineOutput, RunReport, RunSummary, TestCase } from '../core/types.js';
import type { Judge } from '../judge/types.js';
import { scoreRetrieval } from '../metrics/retrieval.js';
import { mean, percentile } from '../metrics/stats.js';
import type { RagPipeline } from '../pipeline/types.js';
import { VERSION } from '../version.js';

export interface RunOptions {
  readonly pipeline: RagPipeline;
  readonly judge?: Judge;
  /** Rank cutoff for retrieval metrics. */
  readonly k?: number;
  readonly concurrency?: number;
  /** Per-call timeout, applied separately to the pipeline and the judge. */
  readonly timeoutMs?: number;
  /** Cancels the whole run. */
  readonly signal?: AbortSignal;
  readonly onResult?: (result: CaseResult, done: number, total: number) => void;
  /** Injected for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Runs every test case through the pipeline (and optional judge).
 * A failing case never aborts the run: errors are recorded per case
 * so one flaky request can't hide the results of the other 499.
 */
export async function runEvaluation(cases: readonly TestCase[], opts: RunOptions): Promise<RunReport> {
  const { pipeline, judge, k = 5, concurrency = 4, timeoutMs = 30_000, signal, onResult, now = performance.now.bind(performance) } = opts;
  const startedAt = new Date().toISOString();
  const runStart = now();
  let done = 0;

  const results = await mapWithConcurrency(cases, concurrency, async (testCase) => {
    const result = await evaluateCase(testCase);
    onResult?.(result, ++done, cases.length);
    return result;
  });

  return {
    meta: {
      tool: 'ragprobe',
      version: VERSION,
      startedAt,
      durationMs: now() - runStart,
      pipeline: pipeline.name,
      judge: judge?.name ?? null,
    },
    summary: summarize(results, k),
    results,
  };

  async function evaluateCase(testCase: TestCase): Promise<CaseResult> {
    signal?.throwIfAborted();
    const start = now();
    let output: PipelineOutput;
    try {
      output = await pipeline.query(testCase.question, { signal: callSignal() });
    } catch (err) {
      signal?.throwIfAborted();
      return { status: 'error', testCase, latencyMs: now() - start, error: errorMessage(err) };
    }
    const latencyMs = now() - start;

    const retrieval = scoreRetrieval(
      output.contexts.map((c) => c.id),
      testCase.relevantDocIds,
      k,
    );

    const judgeOutcome = judge ? await runJudge(judge, testCase, output) : undefined;
    return {
      status: 'ok',
      testCase,
      output,
      latencyMs,
      retrieval,
      ...(judgeOutcome ? { judge: judgeOutcome } : {}),
    };
  }

  async function runJudge(j: Judge, testCase: TestCase, output: PipelineOutput): Promise<JudgeOutcome> {
    try {
      const verdict = await j.evaluate(
        {
          question: testCase.question,
          answer: output.answer,
          contexts: output.contexts,
          ...(testCase.referenceAnswer ? { referenceAnswer: testCase.referenceAnswer } : {}),
        },
        { signal: callSignal() },
      );
      return { status: 'ok', verdict };
    } catch (err) {
      signal?.throwIfAborted();
      return { status: 'error', error: errorMessage(err) };
    }
  }

  function callSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
}

export function summarize(results: readonly CaseResult[], k: number): RunSummary {
  const ok = results.filter((r) => r.status === 'ok');
  const verdicts = ok.flatMap((r) => (r.judge?.status === 'ok' ? [r.judge.verdict] : []));
  const judgeErrors = ok.filter((r) => r.judge?.status === 'error').length;
  const latencies = results.map((r) => r.latencyMs);
  const avg = (pick: (r: (typeof ok)[number]) => number) => mean(ok.map(pick));

  return {
    total: results.length,
    succeeded: ok.length,
    failed: results.length - ok.length,
    errorRate: results.length === 0 ? 0 : (results.length - ok.length) / results.length,
    k,
    retrieval: {
      recallAtK: avg((r) => r.retrieval.recallAtK),
      precisionAtK: avg((r) => r.retrieval.precisionAtK),
      hitRate: avg((r) => r.retrieval.hitRate),
      mrr: avg((r) => r.retrieval.mrr),
      ndcgAtK: avg((r) => r.retrieval.ndcgAtK),
    },
    ...(verdicts.length > 0 || judgeErrors > 0
      ? {
          judge: {
            judged: verdicts.length,
            errors: judgeErrors,
            faithfulness: mean(verdicts.map((v) => v.faithfulness)),
            relevance: mean(verdicts.map((v) => v.relevance)),
          },
        }
      : {}),
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), mean: mean(latencies) },
  };
}
