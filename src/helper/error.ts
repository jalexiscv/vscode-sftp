import * as output from '../ui/output';
import logger from '../logger';
import { showErrorMessage } from '../host';

/**
 * Whether an error means "the path is not there", across the three backends.
 *
 * Worth isolating because the distinction drives destructive decisions: a
 * missing path is an expected, ignorable outcome, while a permission or network
 * error must never be mistaken for one — treating the latter as "already gone"
 * is how a failed delete gets reported as success, or a failed rename turns
 * into a duplicate upload.
 */
export function isNotFoundError(error: any): boolean {
  if (!error) {
    return false;
  }

  // sftp maps NO_SUCH_FILE to status 2, node uses ENOENT, ftp replies 550
  if (error.code === 2 || error.code === 'ENOENT') {
    return true;
  }

  // "file not exist" is what this extension's own FTP backend throws
  // (ftpFileSystem.lstat), and it carries no code at all
  const message = String(error.message || '');
  return /no such file|not found|not exist|^550\b|\b550 /i.test(message);
}

/**
 * Flags an error whose content has already been shown to the user, so that
 * {@link reportError} logs it but does not open a second dialog for it.
 *
 * The transfer handlers use it for their aggregated failure: by the time it is
 * thrown, `afterTransfer` has already reported every file it summarises. The
 * flag is non-enumerable so it never leaks into a serialised error, and the
 * call is idempotent because an error can cross several catch blocks.
 */
export function markReported<T extends Error>(err: T): T {
  if (isReported(err)) {
    return err;
  }

  Object.defineProperty(err, 'reported', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
  return err;
}

export function isReported(err: unknown): boolean {
  return err instanceof Error && (err as any).reported === true;
}

export function reportError(err: Error | string, ctx?: string) {
  let errorString: string;
  if (err instanceof Error) {
    errorString = err.message;
    logger.error(`${err.stack}`, ctx);
  } else {
    errorString = err;
    logger.error(errorString, ctx);
  }

  // already on screen, one failure at a time; the summary only goes to the log
  if (isReported(err)) {
    return;
  }

  showErrorMessage(errorString, 'Detail').then(result => {
    if (result === 'Detail') {
      output.show();
    }
  });
  return;
}
