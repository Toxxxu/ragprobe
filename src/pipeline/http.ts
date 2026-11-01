import { PipelineError } from '../core/errors.js';
import type { PipelineOutput, RetrievedDoc } from '../core/types.js';
import type { RagPipeline } from './types.js';

export interface HttpPipelineOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Adapt a non-standard response body to `PipelineOutput`. */
  readonly mapResponse?: (body: unknown) => PipelineOutput;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * Calls a RAG service over HTTP.
 *
 * Request:  POST { "question": string }
 * Response: { "answer": string, "contexts": [{ "id": string, "content": string, "score"?: number }] }
 */
export class HttpPipeline implements RagPipeline {
  readonly name: string;
  readonly #opts: HttpPipelineOptions;
  readonly #fetch: typeof fetch;

  constructor(opts: HttpPipelineOptions) {
    this.#opts = opts;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.name = `http:${opts.url}`;
  }

  async query(question: string, { signal }: { signal: AbortSignal }): Promise<PipelineOutput> {
    let res: Response;
    try {
      res = await this.#fetch(this.#opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...this.#opts.headers },
        body: JSON.stringify({ question }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      // Node's fetch reports every network failure as "fetch failed"; the cause says why.
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const reason = cause?.code ?? cause?.message ?? (err as Error).message;
      throw new PipelineError(`cannot reach pipeline at ${this.#opts.url} (${reason})`);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new PipelineError(`pipeline responded ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new PipelineError('pipeline response is not valid JSON');
    }

    return this.#opts.mapResponse ? this.#opts.mapResponse(body) : parsePipelineOutput(body);
  }
}

export function parsePipelineOutput(body: unknown): PipelineOutput {
  if (typeof body !== 'object' || body === null) {
    throw new PipelineError('pipeline response must be a JSON object');
  }
  const { answer, contexts } = body as Record<string, unknown>;
  if (typeof answer !== 'string') throw new PipelineError('pipeline response is missing string "answer"');
  if (!Array.isArray(contexts)) throw new PipelineError('pipeline response is missing array "contexts"');

  return {
    answer,
    contexts: contexts.map((c, i): RetrievedDoc => {
      const doc = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
      if (typeof doc['id'] !== 'string' || typeof doc['content'] !== 'string') {
        throw new PipelineError(`contexts[${i}] must have string "id" and "content"`);
      }
      const score = doc['score'];
      return {
        id: doc['id'],
        content: doc['content'],
        ...(typeof score === 'number' ? { score } : {}),
      };
    }),
  };
}
