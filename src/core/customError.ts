import * as path from 'path';
// type-only on purpose: transferTask.ts imports CustomError as a value (its
// TransferVerificationError extends it), so a value import here would close a
// require() cycle and hand one of the two modules a half-initialised other,
// depending on which file is loaded first. `import type` is erased at
// compile time (TypeScript >= 3.8; ts-loader and the jest transpiler both
// honour it), so no runtime edge exists in this direction.
import type TransferTask from './transferTask';

/**
 * An Error with a machine-readable `code`, so callers can branch on what went
 * wrong without parsing messages. The remote clients raise it for a cancelled
 * connection; the transfer handlers for a failed batch.
 */
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

// a message stands in for a missing code; long ones are cut so the summary
// stays one line
const MAX_REASON_LENGTH = 80;

function reasonOf(error: any): string {
  // only a textual code (EACCES, ECONNRESET) says more than the message: ssh2
  // reports SFTP status codes as bare numbers, and "a.txt (3)" tells nothing
  if (error && typeof error.code === 'string' && error.code !== '') {
    return error.code;
  }

  const message = String(error && error.message ? error.message : error)
    .replace(/\s+/g, ' ')
    .trim();
  return message.length > MAX_REASON_LENGTH
    ? message.slice(0, MAX_REASON_LENGTH - 3) + '...'
    : message;
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
