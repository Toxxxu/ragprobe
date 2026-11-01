import { withRetry } from '../core/async.js';
import type { JudgeVerdict } from '../core/types.js';
import { OllamaClient, type OllamaClientOptions } from '../llm/ollama.js';
import { buildJudgeUserPrompt, JUDGE_RESPONSE_SCHEMA, JUDGE_SYSTEM_PROMPT, parseJudgeResponse } from './prompt.js';
import type { Judge, JudgeInput } from './types.js';

export interface OllamaJudgeOptions extends OllamaClientOptions {
  readonly model?: string;
  /** Retries after a transport error or malformed output. */
  readonly retries?: number;
}

/** LLM-as-judge backed by a local Ollama server. */
export class OllamaJudge implements Judge {
  readonly name: string;
  readonly #model: string;
  readonly #retries: number;
  readonly #client: OllamaClient;

  constructor(opts: OllamaJudgeOptions = {}) {
    this.#model = opts.model ?? 'qwen3:8b';
    this.#retries = opts.retries ?? 2;
    this.#client = new OllamaClient(opts);
    this.name = `ollama:${this.#model}`;
  }

  evaluate(input: JudgeInput, { signal }: { signal: AbortSignal }): Promise<JudgeVerdict> {
    return withRetry(() => this.#evaluateOnce(input, signal), { retries: this.#retries, signal });
  }

  /** Loads the model into memory with the context size used for judging. */
  warmUp({ signal }: { signal: AbortSignal }): Promise<void> {
    return this.#client.load(this.#model, signal);
  }

  async #evaluateOnce(input: JudgeInput, signal: AbortSignal): Promise<JudgeVerdict> {
    const content = await this.#client.chat(
      { model: this.#model, system: JUDGE_SYSTEM_PROMPT, user: buildJudgeUserPrompt(input), format: JUDGE_RESPONSE_SCHEMA },
      signal,
    );
    return parseJudgeResponse(content);
  }
}
