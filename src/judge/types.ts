import type { JudgeVerdict, RetrievedDoc } from '../core/types.js';

export interface JudgeInput {
  readonly question: string;
  readonly answer: string;
  readonly contexts: readonly RetrievedDoc[];
  readonly referenceAnswer?: string;
}

/** Scores an answer. Implementations must return values normalised to 0..1. */
export interface Judge {
  readonly name: string;
  evaluate(input: JudgeInput, options: { signal: AbortSignal }): Promise<JudgeVerdict>;
}
