import type { PipelineOutput } from '../core/types.js';

/**
 * A RAG system under evaluation. Implement it to evaluate a pipeline
 * in-process, or use `HttpPipeline` for a running service.
 */
export interface RagPipeline {
  readonly name: string;
  query(question: string, options: { signal: AbortSignal }): Promise<PipelineOutput>;
}
