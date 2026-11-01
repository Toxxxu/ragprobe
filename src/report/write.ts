import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunReport } from '../core/types.js';
import type { GateResult } from '../runner/gate.js';
import { renderComparison, type Comparison } from './compare.js';
import { renderMarkdown } from './markdown.js';

export interface WrittenReports {
  readonly json: string;
  readonly markdown: string;
}

export interface ReportExtras {
  readonly gate?: GateResult;
  readonly comparison?: Comparison;
}

export async function writeReports(dir: string, report: RunReport, extras: ReportExtras = {}): Promise<WrittenReports> {
  await mkdir(dir, { recursive: true });
  const json = join(dir, 'report.json');
  const markdown = join(dir, 'report.md');
  const md = [renderMarkdown(report, extras.gate), ...(extras.comparison ? [renderComparison(extras.comparison)] : [])].join('\n');

  await Promise.all([
    writeFile(json, JSON.stringify({ ...report, gate: extras.gate ?? null, comparison: extras.comparison ?? null }, null, 2) + '\n'),
    writeFile(markdown, md),
  ]);

  const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
  if (stepSummary) await appendFile(stepSummary, md + '\n');

  return { json, markdown };
}
