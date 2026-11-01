import { JudgeError } from '../core/errors.js';
import type { JudgeVerdict } from '../core/types.js';
import type { JudgeInput } from './types.js';

/** Maximum number of context characters sent to the judge. */
const MAX_CONTEXT_CHARS = 12_000;

export const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator of retrieval-augmented answers.
Score the ANSWER on two independent integer scales from 1 to 5.

faithfulness: is everything the ANSWER states supported by the CONTEXT?
  5 = every statement is supported, or the answer only says the information is not available;
  3 = some statements are not in the context; 1 = mostly unsupported or contradicts the context.
  Faithfulness is about invented or contradicted content only. A correct but incomplete answer is still 5.

relevance: does the ANSWER fully address the QUESTION?
  5 = answers the question completely and directly; 3 = partially answers it or misses key parts;
  1 = off-topic, or does not answer it. A true statement about a different fact than the one asked is 1.
  A reply that only says "I don't know" is 1; if it hedges but still gives the answer, score the answer it gives.
  Missing or incomplete information lowers relevance, not faithfulness.

Examples:
  CONTEXT: "The museum opens at 9:00 and closes at 17:00. Tickets cost 15 euros."
  QUESTION: "When does the museum close?"
  ANSWER: "The museum opens at 9:00." -> faithfulness 5 (true per context), relevance 1 (does not say when it closes).
  ANSWER: "I don't know." -> faithfulness 5 (claims nothing), relevance 1 (no answer).
  ANSWER: "It closes at 17:00, and parking is free." -> faithfulness 3 (parking is not in the context), relevance 5.

Score each scale separately. Judge only what is written and do not use outside knowledge.
Respond with JSON only: {"faithfulness": int, "relevance": int, "reasoning": "one or two sentences covering both scores"}`;

/** JSON schema used for constrained decoding (e.g. Ollama's `format`). */
export const JUDGE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    faithfulness: { type: 'integer', minimum: 1, maximum: 5 },
    relevance: { type: 'integer', minimum: 1, maximum: 5 },
    reasoning: { type: 'string' },
  },
  required: ['faithfulness', 'relevance', 'reasoning'],
} as const;

export function buildJudgeUserPrompt(input: JudgeInput): string {
  let budget = MAX_CONTEXT_CHARS;
  const blocks: string[] = [];
  for (const [i, doc] of input.contexts.entries()) {
    if (budget <= 0) break;
    const content = doc.content.slice(0, budget);
    budget -= content.length;
    blocks.push(`[${i + 1}] (id: ${doc.id})\n${content}`);
  }

  return [
    `QUESTION:\n${input.question}`,
    `CONTEXT:\n${blocks.length > 0 ? blocks.join('\n\n') : '(no context retrieved)'}`,
    ...(input.referenceAnswer ? [`REFERENCE ANSWER (for relevance only):\n${input.referenceAnswer}`] : []),
    `ANSWER:\n${input.answer}`,
  ].join('\n\n');
}

/** Validates raw judge output and maps 1..5 scores onto 0..1. */
export function parseJudgeResponse(raw: string): JudgeVerdict {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonObject(raw));
  } catch {
    throw new JudgeError(`judge returned invalid JSON: ${raw.slice(0, 120)}`);
  }
  const obj = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  const faithfulness = toScore(obj['faithfulness'], 'faithfulness');
  const relevance = toScore(obj['relevance'], 'relevance');
  const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'].trim() : '';
  return { faithfulness, relevance, reasoning };
}

function toScore(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1 || n > 5) {
    throw new JudgeError(`judge field "${field}" must be a number from 1 to 5, got ${JSON.stringify(value)}`);
  }
  return (Math.round(n) - 1) / 4;
}

/** Extracts the outermost JSON object from text that may include prose or code fences. */
function extractJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start !== -1 && end > start ? raw.slice(start, end + 1) : raw;
}
