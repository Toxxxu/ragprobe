import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunReport } from '../core/types.js';
import type { GateResult } from '../runner/gate.js';
import { renderMarkdown } from './markdown.js';

export interface WrittenReports {
  readonly json: string;
  readonly markdown: string;
}

export async function writeReports(dir: string, report: RunReport, gate?: GateResult): Promise<WrittenReports> {
  await mkdir(dir, { recursive: true });
  const json = join(dir, 'report.json');
  const markdown = join(dir, 'report.md');
  const md = renderMarkdown(report, gate);

  await Promise.all([
    writeFile(json, JSON.stringify({ ...report, gate: gate ?? null }, null, 2) + '\n'),
    writeFile(markdown, md),
  ]);

  const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
  if (stepSummary) await appendFile(stepSummary, md + '\n');

  return { json, markdown };
}
