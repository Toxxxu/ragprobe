import { readFile } from 'node:fs/promises';
import { DatasetError, RagprobeError, type DatasetIssue } from '../core/errors.js';
import type { TestCase } from '../core/types.js';

/**
 * Loads a JSONL dataset with one test case per line. Blank lines and lines
 * starting with `#` are ignored. Throws with every invalid line at once.
 */
export async function loadDataset(file: string): Promise<TestCase[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new RagprobeError(code === 'ENOENT' ? `dataset not found: ${file}` : `cannot read dataset ${file}`, { cause: err });
  }
  return parseDataset(text, file);
}

export function parseDataset(text: string, file = '<inline>'): TestCase[] {
  const cases: TestCase[] = [];
  const issues: DatasetIssue[] = [];
  const seenIds = new Map<string, number>();

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      issues.push({ line, message: 'not valid JSON' });
      return;
    }

    const result = parseTestCase(json);
    if (!result.ok) {
      issues.push(...result.errors.map((message) => ({ line, message })));
      return;
    }

    const firstSeen = seenIds.get(result.value.id);
    if (firstSeen !== undefined) {
      issues.push({ line, message: `duplicate id "${result.value.id}" (first seen on line ${firstSeen})` });
      return;
    }
    seenIds.set(result.value.id, line);
    cases.push(result.value);
  });

  if (issues.length > 0) throw new DatasetError(file, issues);
  if (cases.length === 0) throw new DatasetError(file, [{ line: 0, message: 'dataset contains no test cases' }]);
  return cases;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function parseTestCase(input: unknown): ParseResult<TestCase> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['expected a JSON object'] };
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];

  const id = nonEmptyString(obj, 'id', errors);
  const question = nonEmptyString(obj, 'question', errors);

  const relevant = obj['relevantDocIds'];
  if (!isStringArray(relevant) || relevant.length === 0) {
    errors.push('"relevantDocIds" must be a non-empty array of strings');
  }

  const reference = obj['referenceAnswer'];
  if (reference !== undefined && typeof reference !== 'string') {
    errors.push('"referenceAnswer" must be a string when present');
  }

  const tags = obj['tags'];
  if (tags !== undefined && !isStringArray(tags)) {
    errors.push('"tags" must be an array of strings when present');
  }

  if (errors.length > 0 || id === undefined || question === undefined || !isStringArray(relevant)) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      id,
      question,
      relevantDocIds: [...new Set(relevant)],
      ...(typeof reference === 'string' ? { referenceAnswer: reference } : {}),
      ...(isStringArray(tags) ? { tags } : {}),
    },
  };
}

function nonEmptyString(obj: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = obj[key];
  if (typeof value === 'string' && value.trim() !== '') return value;
  errors.push(`"${key}" must be a non-empty string`);
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
