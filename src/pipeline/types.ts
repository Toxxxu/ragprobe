import type { PipelineOutput } from '../core/types.js';

/**
 * The only thing ragprobe needs from a RAG system. Implement this to
 * evaluate a pipeline in-process, or use `HttpPipeline` for a running service.
 */
export interface RagPipeline {
  readonly name: string;
  query(question: string, options: { signal: AbortSignal }): Promise<PipelineOutput>;
}
