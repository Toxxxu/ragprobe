export class RagprobeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface DatasetIssue {
  readonly line: number;
  readonly message: string;
}

/** Raised with every problem found in a dataset, not just the first one. */
export class DatasetError extends RagprobeError {
  constructor(
    readonly file: string,
    readonly issues: readonly DatasetIssue[],
  ) {
    super(
      `Invalid dataset ${file} (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((i) => `  line ${i.line}: ${i.message}`).join('\n'),
    );
  }
}

export class PipelineError extends RagprobeError {}

export class JudgeError extends RagprobeError {}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'TimeoutError' ? 'Timed out' : err.message;
  }
  return String(err);
}
