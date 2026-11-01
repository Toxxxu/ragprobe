import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JudgeError, PipelineError } from '../src/core/errors.js';
import { OllamaJudge } from '../src/judge/ollama.js';
import { buildJudgeUserPrompt, parseJudgeResponse } from '../src/judge/prompt.js';
import { HttpPipeline } from '../src/pipeline/http.js';

const signal = new AbortController().signal;

function fakeFetch(handler: (url: string, body: unknown) => Response): typeof fetch & { calls: number } {
  const f = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      f.calls++;
      return handler(String(input), init?.body ? JSON.parse(String(init.body)) : undefined);
    },
    { calls: 0 },
  );
  return f as typeof fetch & { calls: number };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HttpPipeline', () => {
  it('posts the question and parses the response', async () => {
    const fetch = fakeFetch((_url, body) => {
      assert.deepEqual(body, { question: 'hi?' });
      return json({ answer: 'hello', contexts: [{ id: 'd1', content: 'c', score: 0.9 }, { id: 'd2', content: 'c2' }] });
    });
    const out = await new HttpPipeline({ url: 'http://rag/query', fetch }).query('hi?', { signal });
    assert.equal(out.answer, 'hello');
    assert.deepEqual(out.contexts[1], { id: 'd2', content: 'c2' });
  });

  it('raises descriptive errors for bad responses', async () => {
    const bad = (body: unknown, status = 200) =>
      new HttpPipeline({ url: 'http://rag', fetch: fakeFetch(() => json(body, status)) }).query('q', { signal });

    await assert.rejects(bad({ error: 'nope' }, 500), /responded 500/);
    await assert.rejects(bad({ contexts: [] }), /missing string "answer"/);
    await assert.rejects(bad({ answer: 'a', contexts: [{ id: 1 }] }), PipelineError);
  });

  it('names the URL and cause when the service is unreachable', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    }) as typeof globalThis.fetch;
    await assert.rejects(
      new HttpPipeline({ url: 'http://localhost:4010/query', fetch }).query('q', { signal }),
      /cannot reach pipeline at http:\/\/localhost:4010\/query \(ECONNREFUSED\)/,
    );
  });

  it('supports a custom response mapper', async () => {
    const fetch = fakeFetch(() => json({ text: 'x', docs: [{ doc_id: 'd', text: 't' }] }));
    const pipeline = new HttpPipeline({
      url: 'http://rag',
      fetch,
      mapResponse: (b) => {
        const body = b as { text: string; docs: { doc_id: string; text: string }[] };
        return { answer: body.text, contexts: body.docs.map((d) => ({ id: d.doc_id, content: d.text })) };
      },
    });
    assert.equal((await pipeline.query('q', { signal })).contexts[0]?.id, 'd');
  });
});

describe('judge prompt', () => {
  it('maps 1..5 scores onto 0..1 and tolerates surrounding prose', () => {
    const v = parseJudgeResponse('Sure! ```json\n{"faithfulness": 5, "relevance": 3, "reasoning": " fine "}\n```');
    assert.deepEqual(v, { faithfulness: 1, relevance: 0.5, reasoning: 'fine' });
  });

  it('rejects out-of-range and malformed output', () => {
    assert.throws(() => parseJudgeResponse('{"faithfulness": 9, "relevance": 3}'), JudgeError);
    assert.throws(() => parseJudgeResponse('no json here'), JudgeError);
  });

  it('includes the reference answer only when present', () => {
    const base = { question: 'q', answer: 'a', contexts: [{ id: 'd1', content: 'c' }] };
    assert.doesNotMatch(buildJudgeUserPrompt(base), /REFERENCE/);
    assert.match(buildJudgeUserPrompt({ ...base, referenceAnswer: 'r' }), /REFERENCE ANSWER/);
  });
});

describe('OllamaJudge', () => {
  it('sends a schema-constrained, deterministic request', async () => {
    const fetch = fakeFetch((url, body) => {
      assert.equal(url, 'http://ollama:11434/api/chat');
      const b = body as { model: string; stream: boolean; format: unknown; options: { temperature: number } };
      assert.equal(b.model, 'llama3.2:3b');
      assert.equal(b.stream, false);
      assert.equal(b.options.temperature, 0);
      assert.ok(b.format, 'uses structured output');
      return json({ message: { content: '{"faithfulness":4,"relevance":5,"reasoning":"ok"}' } });
    });
    const judge = new OllamaJudge({ model: 'llama3.2:3b', baseUrl: 'http://ollama:11434/', fetch });
    const v = await judge.evaluate({ question: 'q', answer: 'a', contexts: [] }, { signal });
    assert.deepEqual(v, { faithfulness: 0.75, relevance: 1, reasoning: 'ok' });
  });

  it('retries malformed output, then gives up', async () => {
    const fetch = fakeFetch(() => json({ message: { content: 'garbage' } }));
    const judge = new OllamaJudge({ retries: 2, fetch });
    await assert.rejects(judge.evaluate({ question: 'q', answer: 'a', contexts: [] }, { signal }), JudgeError);
    assert.equal(fetch.calls, 3);
  });

  it('warms up the model with the same context size it judges with', async () => {
    const fetch = fakeFetch((url, body) => {
      assert.equal(url, 'http://localhost:11434/api/generate');
      assert.deepEqual(body, { model: 'qwen3:8b', stream: false, options: { num_ctx: 4096 } });
      return json({ done: true });
    });
    await new OllamaJudge({ numCtx: 4096, fetch }).warmUp({ signal });
    assert.equal(fetch.calls, 1);

    const missing = new OllamaJudge({ fetch: fakeFetch(() => json({ error: 'model not found' }, 404)) });
    await assert.rejects(missing.warmUp({ signal }), /could not load qwen3:8b: ollama responded 404/);
  });
});
