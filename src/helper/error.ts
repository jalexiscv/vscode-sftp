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

export function reportError(err: Error | string, ctx?: string) {
  let errorString: string;
  if (err instanceof Error) {
    errorString = err.message;
    logger.error(`${err.stack}`, ctx);
  } else {
    errorString = err;
    logger.error(errorString, ctx);
  }

  showErrorMessage(errorString, 'Detail').then(result => {
    if (result === 'Detail') {
      output.show();
    }
  });
  return;
}
