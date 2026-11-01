/** A single evaluation question with its ground truth. */
export interface TestCase {
  readonly id: string;
  readonly question: string;
  /** IDs of documents a perfect retriever would return. At least one. */
  readonly relevantDocIds: readonly string[];
  /** Optional gold answer, passed to the judge when present. */
  readonly referenceAnswer?: string;
  /** Free-form labels for slicing results (e.g. "multi-hop", "billing"). */
  readonly tags?: readonly string[];
}

export interface RetrievedDoc {
  readonly id: string;
  readonly content: string;
  readonly score?: number;
}

/** What a RAG pipeline returns for one question. */
export interface PipelineOutput {
  readonly answer: string;
  /** Retrieved context, in rank order (best first). */
  readonly contexts: readonly RetrievedDoc[];
}

export interface RetrievalScores {
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly hitRate: number;
  readonly mrr: number;
  readonly ndcgAtK: number;
}

/** Judge scores are normalised to the 0..1 range. */
export interface JudgeVerdict {
  /** Is every claim in the answer supported by the retrieved context? */
  readonly faithfulness: number;
  /** Does the answer actually address the question? */
  readonly relevance: number;
  readonly reasoning: string;
}

export type JudgeOutcome =
  | { readonly status: 'ok'; readonly verdict: JudgeVerdict }
  | { readonly status: 'error'; readonly error: string };

export type CaseResult =
  | {
      readonly status: 'ok';
      readonly testCase: TestCase;
      readonly output: PipelineOutput;
      readonly latencyMs: number;
      readonly retrieval: RetrievalScores;
      readonly judge?: JudgeOutcome;
    }
  | {
      readonly status: 'error';
      readonly testCase: TestCase;
      readonly latencyMs: number;
      readonly error: string;
    };

export interface RunSummary {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errorRate: number;
  readonly k: number;
  readonly retrieval: RetrievalScores;
  /** Present only when a judge was configured and produced at least one verdict. */
  readonly judge?: {
    readonly judged: number;
    readonly errors: number;
    readonly faithfulness: number;
    readonly relevance: number;
  };
  readonly latency: { readonly p50: number; readonly p95: number; readonly mean: number };
}

export interface RunReport {
  readonly meta: {
    readonly tool: 'ragprobe';
    readonly version: string;
    readonly startedAt: string;
    readonly durationMs: number;
    readonly pipeline: string;
    readonly judge: string | null;
  };
  readonly summary: RunSummary;
  readonly results: readonly CaseResult[];
}
