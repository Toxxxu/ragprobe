import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { generateTestCases, loadDocuments, toJsonl } from '../src/dataset/generate.js';
import { parseDataset } from '../src/dataset/load.js';

const reply = (content: string) =>
  new Response(JSON.stringify({ message: { content } }), { headers: { 'content-type': 'application/json' } });

describe('loadDocuments', () => {
  it('reads supported files recursively and uses relative paths as IDs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ragprobe-docs-'));
    await mkdir(join(dir, 'billing'));
    await writeFile(join(dir, 'billing', 'refunds.md'), 'Refunds take 5 days.');
    await writeFile(join(dir, 'faq.txt'), 'Questions and answers.');
    await writeFile(join(dir, 'empty.md'), '   ');
    await writeFile(join(dir, 'image.png'), 'binary');

    const docs = await loadDocuments(dir);
    assert.deepEqual(
      docs.map((d) => d.id),
      ['billing/refunds', 'faq'],
    );
    assert.equal(docs[0]?.content, 'Refunds take 5 days.');
  });

  it('explains a missing or empty directory', async () => {
    await assert.rejects(loadDocuments(join(tmpdir(), 'ragprobe-does-not-exist')), /docs directory not found/);
    await assert.rejects(loadDocuments(await mkdtemp(join(tmpdir(), 'ragprobe-empty-'))), /no \.md, \.mdx or \.txt files/);
  });
});

describe('generateTestCases', () => {
  it('turns model output into valid test cases', async () => {
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[]; format: { properties: { questions: { maxItems: number } } } };
      assert.equal(body.format.properties.questions.maxItems, 2);
      assert.match(body.messages[1]?.content ?? '', /DOCUMENT \(refunds\)/);
      return reply('{"questions":[{"question":"How long do refunds take?","answer":"5 days."},{"question":"Second?","answer":"Yes."}]}');
    }) as typeof globalThis.fetch;

    const result = await generateTestCases([{ id: 'refunds', content: 'Refunds take 5 days.' }], { fetch, perDoc: 2 });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.cases[0], {
      id: 'refunds-1',
      question: 'How long do refunds take?',
      relevantDocIds: ['refunds'],
      referenceAnswer: '5 days.',
      tags: ['generated'],
    });

    const roundTrip = parseDataset(toJsonl(result.cases, 'generated'));
    assert.equal(roundTrip.length, 2);
  });

  it('records documents the model fails on and keeps the rest', async () => {
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = String(init?.body);
      return reply(prompt.includes('DOCUMENT (bad)') ? 'not json' : '{"questions":[{"question":"Q?","answer":"A."}]}');
    }) as typeof globalThis.fetch;

    const docs = [
      { id: 'good', content: 'x' },
      { id: 'bad', content: 'y' },
    ];
    const result = await generateTestCases(docs, { fetch, perDoc: 1, retries: 0 });
    assert.deepEqual(
      result.cases.map((c) => c.id),
      ['good-1'],
    );
    assert.equal(result.failures[0]?.id, 'bad');
    assert.match(result.failures[0]?.error ?? '', /invalid JSON/);
  });
});
