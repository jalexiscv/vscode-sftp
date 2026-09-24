import * as vscode from 'vscode';
import app from '../app';
import logger from '../logger';
import fsPromises from '../helper/fsPromises';
import { FileService, ServiceConfig, TransferDirection, FileType } from '../core';
import { isConnectionLostError } from '../core/connectionHealth';
import { SyncIndex, IndexEntry, getSyncIndex, indexKeyFor, toRelPath } from './syncIndex';
import { onDidFinishTransfer, TransferOutcome } from './transferEvents';

/**
 * Keeps the sync index in step with what actually reached the server.
 *
 * The index must reflect verified state, not intent, so it is written from a
 * single place: the outcome of each transfer task, observed through
 * transferEvents. A verified upload records the local size and mtime the file
 * had when it was sent; a failed one keeps the previous entry but flags it
 * `failed` so the next scan plans it again; a download records the file the
 * way it now is on disk, so the next scan does not mistake it for a local
 * edit. Deletions and renames mirrored by localDeleteMonitor update the index
 * through {@link forgetInIndex} / {@link renameInIndex}; a version the user
 * declined to upload is remembered as `skipped` through
 * {@link rememberSkipped}, so the same question is not asked again until the
 * file changes; a version the user declares to be on the server already is
 * recorded as `verified` with the `assumed` mark through
 * {@link rememberAssumedUploaded}.
 *
 * {@link indexFor} is the one way to get the index of a service's current
 * destination (host, port, remote path and active profile), shared with the
 * scanner and the plan runner so all of them agree on the key.
 *
 * Key lifecycle methods:
 * - {@link init} subscribes to transfer outcomes; {@link destroy} unsubscribes.
 * - {@link indexFor} resolves the index of a service.
 */

let subscription: vscode.Disposable | null = null;

/**
 * The sync index of `service` for its current destination.
 *
 * `config` can be passed when the caller already resolved it, which spares a
 * `getConfig()` (validation, profile merge, a log line). Rejects when the
 * config is unusable, e.g. no profile selected yet.
 */
export function indexFor(service: FileService, config?: ServiceConfig): Promise<SyncIndex> {
  const resolved = config || service.getConfig();
  return getSyncIndex(
    indexKeyFor({
      baseDir: service.baseDir,
      host: resolved.host,
      port: resolved.port,
      remotePath: resolved.remotePath,
      profile: app.state.profile,
    })
  );
}

// a path outside the service base dir has no place in its index; toRelPath
// hands those back as "../x" or, across drives on windows, absolute
function isInsideBase(relPath: string): boolean {
  if (relPath === '' || relPath === '..' || relPath.indexOf('../') === 0) {
    return false;
  }
  return relPath.charAt(0) !== '/' && !/^[a-zA-Z]:\//.test(relPath);
}

async function recordUpload(outcome: TransferOutcome, index: SyncIndex, relPath: string) {
  const { task, error } = outcome;
  const verification = task.verification;

  // the connection went away, the file was not judged: its plan item is on
  // hold and will be sent when the server is back, so the entry stays as it
  // was — a `failed` mark here would make the next scan plan the same file
  // again on top of the held plan
  if (error && isConnectionLostError(error)) {
    return;
  }

  if (error || (verification && !verification.ok)) {
    const previous = index.get(relPath);
    const message = error
      ? error.message || String(error)
      : verification!.reason || 'verification failed';
    index.set(relPath, {
      ...(previous || {
        size: task.expectedSize !== undefined ? task.expectedSize : task.sourceSize || 0,
        mtime: task.sourceMtime,
        verifiedAt: 0,
      }),
      status: 'failed',
      error: message,
    });
    return;
  }

  let size = task.expectedSize !== undefined ? task.expectedSize : task.sourceSize;
  if (size === undefined) {
    // neither the collector nor the task measured the source (a caller outside
    // the transfer layer); one stat is the price of an entry
    const stat = await fsPromises.lstat(task.localFsPath);
    size = stat.size;
  }

  const entry: IndexEntry = {
    size,
    mtime: task.sourceMtime,
    verifiedAt: Date.now(),
    status: 'verified',
  };
  if (verification && verification.ok && verification.level === 'stat') {
    // a stat verification passed only because the remote size equalled this one
    entry.remoteSize = size;
  }
  index.set(relPath, entry);
}

async function recordDownload(outcome: TransferOutcome, index: SyncIndex, relPath: string) {
  if (outcome.error) {
    return;
  }

  // after a download local and remote hold the same file; remembering it as
  // verified is what keeps the next scan from uploading it straight back
  const stat = await fsPromises.lstat(outcome.task.localFsPath);
  index.set(relPath, {
    size: stat.size,
    mtime: stat.mtime.getTime(),
    verifiedAt: Date.now(),
    status: 'verified',
  });
}

async function handleOutcome(outcome: TransferOutcome): Promise<void> {
  const { service, task } = outcome;
  if (task.isCancelled()) {
    return;
  }
  if (task.fileType !== FileType.File) {
    // symlinks are neither scanned nor verified; directories never get here
    return;
  }

  const relPath = toRelPath(service.baseDir, task.localFsPath);
  if (!isInsideBase(relPath)) {
    logger.debug(`[sync-index] ${task.localFsPath} is outside ${service.baseDir}; not indexed`);
    return;
  }

  let index: SyncIndex;
  try {
    index = await indexFor(service);
  } catch (error) {
    logger.debug(`[sync-index] no index for ${service.name || service.baseDir}: ${error.message}`);
    return;
  }

  if (task.transferType === TransferDirection.LOCAL_TO_REMOTE) {
    await recordUpload(outcome, index, relPath);
  } else {
    await recordDownload(outcome, index, relPath);
  }
}

/**
 * Drops `localPath` (and, for a directory, everything under it) from the
 * index, after the remote side was deleted. Never throws: the index is
 * bookkeeping, a failure here must not turn a successful deletion into an
 * error.
 */
export async function forgetInIndex(service: FileService, localPath: string): Promise<void> {
  try {
    const relPath = toRelPath(service.baseDir, localPath);
    if (!isInsideBase(relPath)) {
      return;
    }
    const index = await indexFor(service);
    index.remove(relPath);
    const prefix = foldRel(relPath) + '/';
    index.entries().forEach(([entryPath]) => {
      if (foldRel(entryPath).indexOf(prefix) === 0) {
        index.remove(entryPath);
      }
    });
  } catch (error) {
    logger.debug(`[sync-index] cannot forget ${localPath}: ${error.message}`);
  }
}

/**
 * Moves the entry of `fromLocalPath` (and, for a directory, its subtree) to
 * `toLocalPath`, after the remote side was renamed. Never throws.
 */
export async function renameInIndex(
  service: FileService,
  fromLocalPath: string,
  toLocalPath: string
): Promise<void> {
  try {
    const fromRel = toRelPath(service.baseDir, fromLocalPath);
    const toRel = toRelPath(service.baseDir, toLocalPath);
    if (!isInsideBase(fromRel)) {
      return;
    }
    if (!isInsideBase(toRel)) {
      // moved out of the synced tree: as far as the index knows, it is gone
      await forgetInIndex(service, fromLocalPath);
      return;
    }
    const index = await indexFor(service);
    index.rename(fromRel, toRel);
    const prefix = foldRel(fromRel) + '/';
    index.entries().forEach(([entryPath]) => {
      if (foldRel(entryPath).indexOf(prefix) === 0) {
        index.rename(entryPath, toRel + '/' + entryPath.slice(prefix.length));
      }
    });
  } catch (error) {
    logger.debug(`[sync-index] cannot rename ${fromLocalPath}: ${error.message}`);
  }
}

export interface SkippedLocalFile {
  localPath: string;
  /** size and mtime (ms) of the version the user declined */
  localSize: number;
  localMtime: number;
}

/**
 * Remembers that the user declined to upload these versions: each file gets a
 * `skipped` entry with the size and mtime it had, which the next scan treats
 * as "nothing to do" until the file changes. Without this, "Skip" on a scan
 * plan would bring the same dialog back at the next startup. Never throws.
 */
export async function rememberSkipped(
  service: FileService,
  files: SkippedLocalFile[],
  config?: ServiceConfig
): Promise<void> {
  if (files.length === 0) {
    return;
  }
  try {
    const index = await indexFor(service, config);
    files.forEach(file => {
      const relPath = toRelPath(service.baseDir, file.localPath);
      if (!isInsideBase(relPath)) {
        return;
      }
      index.set(relPath, {
        size: file.localSize,
        mtime: file.localMtime,
        verifiedAt: 0,
        status: 'skipped',
      });
    });
    logger.info(
      `[sync-index] ${service.name || service.baseDir}: ${files.length} skipped file(s) remembered`
    );
  } catch (error) {
    logger.debug(`[sync-index] cannot remember skipped files: ${error.message}`);
  }
}

/**
 * Records that the user takes these versions to be on the server already
 * ("mark as uploaded"): each file gets a `verified` entry flagged `assumed`,
 * with the size and mtime it has, so the next scan leaves it alone until it
 * changes — exactly as if it had been uploaded and verified. Nothing is
 * transferred or compared: the assertion is the user's. Resolves with the
 * number of entries written; never throws.
 */
export async function rememberAssumedUploaded(
  service: FileService,
  files: SkippedLocalFile[],
  config?: ServiceConfig
): Promise<number> {
  if (files.length === 0) {
    return 0;
  }
  try {
    const index = await indexFor(service, config);
    const now = Date.now();
    let written = 0;
    files.forEach(file => {
      const relPath = toRelPath(service.baseDir, file.localPath);
      if (!isInsideBase(relPath)) {
        return;
      }
      index.set(relPath, {
        size: file.localSize,
        mtime: file.localMtime,
        verifiedAt: now,
        status: 'verified',
        assumed: true,
      });
      written++;
    });
    logger.info(
      `[sync-index] ${service.name || service.baseDir}: ${written} file(s) marked as uploaded by the user`
    );
    return written;
  } catch (error) {
    logger.debug(`[sync-index] cannot mark files as uploaded: ${error.message}`);
    return 0;
  }
}

// windows and macOS default to case-insensitive filesystems; the index folds
// its keys the same way, so a subtree match must too
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function foldRel(relPath: string): string {
  return CASE_INSENSITIVE_FS ? relPath.toLowerCase() : relPath;
}

/** Starts recording transfer outcomes into the index. Idempotent. */
export function init(): void {
  if (subscription) {
    return;
  }
  subscription = onDidFinishTransfer(outcome => {
    handleOutcome(outcome).catch(error => logger.error(error, 'sync index feeder'));
  });
}

export function destroy(): void {
  if (subscription) {
    subscription.dispose();
    subscription = null;
  }
}

export default {
  init,
  destroy,
};

// exported for tests: lets a test await the outcome instead of racing the bus
export const testHooks = {
  handleOutcome,
};
