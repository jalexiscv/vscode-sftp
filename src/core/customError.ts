import * as path from 'path';
import TransferTask from './transferTask';

class CustomError extends Error {
  code: string;

  constructor(code, message) {
    // Pass remaining arguments (including vendor specific ones) to parent constructor
    super(message);

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CustomError);
    }

    // Custom error properties
    this.code = code;
  }
}

export default CustomError;

/** One file of a transfer batch that did not make it, with the error that stopped it. */
export interface TransferFailure {
  task: TransferTask;
  error: Error;
}

export const ETRANSFER_FAILED = 'ETRANSFER_FAILED';

// how many failed files the aggregated message names before "and N more"
const MAX_NAMED_FAILURES = 5;

function reasonOf(error: any): string {
  if (error && error.code !== undefined && error.code !== null && error.code !== '') {
    return String(error.code);
  }

  return error && error.message ? error.message : String(error);
}

/**
 * Summarises a failed batch in one line, e.g.
 * `2 of 10 file(s) failed to upload: a.txt (EACCES), b.txt (ECONNRESET)`.
 */
export function describeTransferFailures(
  failures: TransferFailure[],
  total: number,
  action: string
): string {
  const named = failures
    .slice(0, MAX_NAMED_FAILURES)
    .map(({ task, error }) => `${path.basename(task.localFsPath)} (${reasonOf(error)})`);
  const rest = failures.length - named.length;
  const more = rest > 0 ? ` and ${rest} more` : '';

  return `${failures.length} of ${total} file(s) failed to ${action}: ${named.join(', ')}${more}`;
}

/**
 * The rejection a transfer handler produces when at least one file of the
 * batch failed.
 *
 * The scheduler keeps running the rest of the batch after a failure, so this
 * is an aggregate: {@link failures} lists every task that did not make it,
 * with its own error, and the message names the first few. Cancelled tasks
 * are not failures and never appear here.
 *
 * Carries `code = 'ETRANSFER_FAILED'` so callers can tell it apart from an
 * error raised while collecting the tasks (lstat, ensureDir...), which still
 * propagates as-is.
 */
export class TransferFailedError extends CustomError {
  readonly failures: TransferFailure[];

  constructor(failures: TransferFailure[], total: number, action: string) {
    super(ETRANSFER_FAILED, describeTransferFailures(failures, total, action));
    this.name = 'TransferFailedError';
    this.failures = failures;
  }
}
