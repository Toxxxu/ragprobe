import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function cli(...args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code) : 0, stdout, stderr });
    });
  });
}

/** Answers every question with document "d1". */
function startServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answer: 'ok', contexts: [{ id: 'd1', content: 'doc one' }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/query` });
    });
  });
}

describe('cli', () => {
  let server: Server;
  let url: string;
  let dir: string;
  let dataset: string;

  before(async () => {
    ({ server, url } = await startServer());
    dir = await mkdtemp(join(tmpdir(), 'ragprobe-cli-'));
    dataset = join(dir, 'dataset.jsonl');
    await writeFile(
      dataset,
      [
        { id: 'found', question: 'q1?', relevantDocIds: ['d1'] },
        { id: 'missed', question: 'q2?', relevantDocIds: ['d2'] },
      ]
        .map((c) => JSON.stringify(c))
        .join('\n'),
    );
  });

  after(() => server.close());

  it('runs an evaluation and writes both reports', async () => {
    const out = join(dir, 'run');
    const result = await cli('run', '--dataset', dataset, '--endpoint', url, '--quiet', '--out', out);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\| recall@5 \| 50\.0% \|/);

    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as { summary: { total: number } };
    assert.equal(report.summary.total, 2);
    assert.match(await readFile(join(out, 'report.md'), 'utf8'), /## ragprobe report/);
  });

  it('exits with 1 when the quality gate fails, also after a stray "--"', async () => {
    const out = join(dir, 'gate');
    const passed = await cli('run', '--dataset', dataset, '--endpoint', url, '--quiet', '--out', out, '--min-recall', '0.5');
    assert.equal(passed.code, 0);

    const failed = await cli('run', '--dataset', dataset, '--endpoint', url, '--quiet', '--out', out, '--', '--min-recall', '0.9');
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /Quality gate: failed/);
  });

  it('compares two runs and fails on a regression', async () => {
    const base = join(dir, 'base');
    const head = join(dir, 'head');
    await cli('run', '--dataset', dataset, '--endpoint', url, '--quiet', '--out', base);
    await cli('run', '--dataset', dataset, '--endpoint', 'http://127.0.0.1:9/query', '--quiet', '--out', head);

    const result = await cli('compare', join(base, 'report.json'), join(head, 'report.json'), '--max-drop', '0.1');
    assert.equal(result.code, 1);
    assert.match(result.stdout, /`found`: now fails/);
  });

  it('exits with 2 and a clear message on usage errors', async () => {
    const cases: [string[], RegExp][] = [
      [['run', '--dataset', dataset], /--dataset and --endpoint are required/],
      [['run', '--dataset', join(dir, 'missing.jsonl'), '--endpoint', url], /dataset not found/],
      [['run', '--dataset', dataset, '--endpoint', url, '--min-recall', '2'], /--min-recall must be a number from 0 to 1/],
      [['frobnicate'], /unknown command "frobnicate"/],
    ];
    for (const [args, message] of cases) {
      const result = await cli(...args);
      assert.equal(result.code, 2, args.join(' '));
      assert.match(result.stderr, message);
    }
  });

  it('prints the version and help', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
    assert.equal((await cli('--version')).stdout.trim(), pkg.version);
    assert.match((await cli('--help')).stdout, /ragprobe generate/);
  });
});
