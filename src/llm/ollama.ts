import { RagprobeError } from '../core/errors.js';

export interface OllamaClientOptions {
  readonly baseUrl?: string;
  /** Context window size in tokens. Defaults to 8192. */
  readonly numCtx?: number;
  /** Custom `fetch` implementation. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

export interface OllamaChatRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  /** JSON schema the reply must follow. */
  readonly format?: unknown;
  readonly temperature?: number;
}

/** Minimal client for the Ollama HTTP API. */
export class OllamaClient {
  readonly baseUrl: string;
  readonly numCtx: number;
  readonly #fetch: typeof fetch;

  constructor(opts: OllamaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.numCtx = opts.numCtx ?? 8192;
    this.#fetch = opts.fetch ?? globalThis.fetch;
  }

  /** Sends one chat turn and returns the reply text. */
  async chat(req: OllamaChatRequest, signal: AbortSignal): Promise<string> {
    const body = await this.#post(
      '/api/chat',
      {
        model: req.model,
        stream: false,
        think: false,
        ...(req.format ? { format: req.format } : {}),
        options: { temperature: req.temperature ?? 0, num_ctx: this.numCtx },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      },
      signal,
    );
    const content = (body as { message?: { content?: unknown } }).message?.content;
    if (typeof content !== 'string') throw new RagprobeError('ollama response has no message content');
    return content;
  }

  /** Loads a model into memory with the configured context size. */
  async load(model: string, signal: AbortSignal): Promise<void> {
    try {
      await this.#post('/api/generate', { model, stream: false, options: { num_ctx: this.numCtx } }, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      throw new RagprobeError(`could not load ${model}: ${(err as Error).message}`, { cause: err });
    }
  }

  async #post(path: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      const cause = (err as { cause?: { code?: string } }).cause;
      throw new RagprobeError(`cannot reach ollama at ${this.baseUrl} (${cause?.code ?? (err as Error).message})`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new RagprobeError(`ollama responded ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
  }
}
