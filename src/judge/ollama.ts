import { withRetry } from '../core/async.js';
import { JudgeError } from '../core/errors.js';
import type { JudgeVerdict } from '../core/types.js';
import { buildJudgeUserPrompt, JUDGE_RESPONSE_SCHEMA, JUDGE_SYSTEM_PROMPT, parseJudgeResponse } from './prompt.js';
import type { Judge, JudgeInput } from './types.js';

export interface OllamaJudgeOptions {
  readonly model?: string;
  readonly baseUrl?: string;
  /** Context window. 8k keeps an 8B model fully on an 8 GB GPU. */
  readonly numCtx?: number;
  /** Retries on transport errors and malformed output. */
  readonly retries?: number;
  readonly fetch?: typeof fetch;
}

/** LLM-as-judge backed by a local Ollama server. Free and offline. */
export class OllamaJudge implements Judge {
  readonly name: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #numCtx: number;
  readonly #retries: number;
  readonly #fetch: typeof fetch;

  constructor(opts: OllamaJudgeOptions = {}) {
    this.#model = opts.model ?? 'qwen3:8b';
    this.#baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.#numCtx = opts.numCtx ?? 8192;
    this.#retries = opts.retries ?? 2;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.name = `ollama:${this.#model}`;
  }

  evaluate(input: JudgeInput, { signal }: { signal: AbortSignal }): Promise<JudgeVerdict> {
    return withRetry(() => this.#evaluateOnce(input, signal), { retries: this.#retries, signal });
  }

  /**
   * Loads the model with the same context size the judge uses. A cold load can
   * take minutes, far longer than a per-call timeout, and a different num_ctx
   * would force Ollama to reload the model on the first real request.
   */
  async warmUp({ signal }: { signal: AbortSignal }): Promise<void> {
    const res = await this.#fetch(`${this.#baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({ model: this.#model, stream: false, options: { num_ctx: this.#numCtx } }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new JudgeError(`could not load ${this.#model}: ollama responded ${res.status}${detail ? `: ${detail}` : ''}`);
    }
  }

  async #evaluateOnce(input: JudgeInput, signal: AbortSignal): Promise<JudgeVerdict> {
    const res = await this.#fetch(`${this.#baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: this.#model,
        stream: false,
        think: false,
        format: JUDGE_RESPONSE_SCHEMA,
        options: { temperature: 0, num_ctx: this.#numCtx },
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: buildJudgeUserPrompt(input) },
        ],
      }),
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new JudgeError(`ollama responded ${res.status}${detail ? `: ${detail}` : ''}`);
    }

    const body = (await res.json()) as { message?: { content?: unknown } };
    const content = body.message?.content;
    if (typeof content !== 'string') throw new JudgeError('ollama response has no message content');
    return parseJudgeResponse(content);
  }
}
