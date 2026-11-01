import { readdir, readFile } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { mapWithConcurrency, withRetry } from '../core/async.js';
import { errorMessage, RagprobeError } from '../core/errors.js';
import type { TestCase } from '../core/types.js';
import { OllamaClient, type OllamaClientOptions } from '../llm/ollama.js';

export interface SourceDocument {
  /** Path relative to the docs directory, without extension, using `/`. */
  readonly id: string;
  readonly content: string;
}

export interface GenerateOptions extends OllamaClientOptions {
  readonly model?: string;
  /** Questions to write per document. Defaults to 2. */
  readonly perDoc?: number;
  readonly concurrency?: number;
  readonly retries?: number;
  readonly signal?: AbortSignal;
  readonly onDocument?: (doc: SourceDocument, done: number, total: number) => void;
}

export interface GenerateResult {
  readonly cases: readonly TestCase[];
  readonly failures: readonly { readonly id: string; readonly error: string }[];
}

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const MAX_DOC_CHARS = 12_000;

const SYSTEM_PROMPT = `You write evaluation questions for a document question-answering assistant.
Given a DOCUMENT, write the requested number of questions that a real user might ask and that this document answers.
- Phrase each question the way a user would, in their own words. Do not copy sentences from the document.
- Each question must be answerable from this document alone.
- Cover different facts in the document instead of repeating one.
- Give a short answer for each question, using only information from the document.
Respond with JSON only: {"questions": [{"question": "...", "answer": "..."}]}`;

/** Reads `.md`, `.mdx` and `.txt` files under `dir`, recursively, in a stable order. */
export async function loadDocuments(dir: string): Promise<SourceDocument[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new RagprobeError(code === 'ENOENT' ? `docs directory not found: ${dir}` : `cannot read ${dir}`, { cause: err });
  }

  const files = entries.filter((f) => DOC_EXTENSIONS.has(extname(f).toLowerCase())).sort();
  const docs: SourceDocument[] = [];
  for (const file of files) {
    const content = (await readFile(join(dir, file), 'utf8')).trim();
    if (content === '') continue;
    const id = file.slice(0, -extname(file).length).split(sep).join('/');
    docs.push({ id, content });
  }
  if (docs.length === 0) throw new RagprobeError(`no .md, .mdx or .txt files found in ${dir}`);
  return docs;
}

/** Writes test questions for each document with a local Ollama model. */
export async function generateTestCases(docs: readonly SourceDocument[], opts: GenerateOptions = {}): Promise<GenerateResult> {
  const model = opts.model ?? 'qwen3:8b';
  const perDoc = opts.perDoc ?? 2;
  const signal = opts.signal ?? new AbortController().signal;
  const client = new OllamaClient(opts);
  let done = 0;

  const outcomes = await mapWithConcurrency(docs, opts.concurrency ?? 2, async (doc) => {
    try {
      const questions = await withRetry(
        async () => parseQuestions(await client.chat({ model, system: SYSTEM_PROMPT, user: userPrompt(doc, perDoc), format: schema(perDoc), temperature: 0.2 }, signal)),
        { retries: opts.retries ?? 2, signal },
      );
      return {
        ok: true as const,
        cases: questions.slice(0, perDoc).map(
          (q, i): TestCase => ({ id: `${doc.id}-${i + 1}`, question: q.question, relevantDocIds: [doc.id], referenceAnswer: q.answer, tags: ['generated'] }),
        ),
      };
    } catch (err) {
      if (signal.aborted) throw err;
      return { ok: false as const, id: doc.id, error: errorMessage(err) };
    } finally {
      opts.onDocument?.(doc, ++done, docs.length);
    }
  });

  return {
    cases: outcomes.flatMap((o) => (o.ok ? o.cases : [])),
    failures: outcomes.flatMap((o) => (o.ok ? [] : [{ id: o.id, error: o.error }])),
  };
}

/** Serialises test cases as JSONL, one case per line. */
export function toJsonl(cases: readonly TestCase[], header?: string): string {
  const lines = cases.map((c) => JSON.stringify(c));
  return (header ? [`# ${header}`, ...lines] : lines).join('\n') + '\n';
}

function userPrompt(doc: SourceDocument, perDoc: number): string {
  return `Write ${perDoc} question${perDoc === 1 ? '' : 's'}.\n\nDOCUMENT (${doc.id}):\n${doc.content.slice(0, MAX_DOC_CHARS)}`;
}

function schema(perDoc: number) {
  return {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: perDoc,
        maxItems: perDoc,
        items: {
          type: 'object',
          properties: { question: { type: 'string' }, answer: { type: 'string' } },
          required: ['question', 'answer'],
        },
      },
    },
    required: ['questions'],
  };
}

function parseQuestions(raw: string): { question: string; answer: string }[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new RagprobeError(`model returned invalid JSON: ${raw.slice(0, 120)}`);
  }
  const list = (json as { questions?: unknown } | null)?.questions;
  const valid = Array.isArray(list)
    ? list.flatMap((q) => {
        const { question, answer } = (q ?? {}) as Record<string, unknown>;
        return typeof question === 'string' && question.trim() && typeof answer === 'string' && answer.trim()
          ? [{ question: question.trim(), answer: answer.trim() }]
          : [];
      })
    : [];
  if (valid.length === 0) throw new RagprobeError('model returned no usable questions');
  return valid;
}
