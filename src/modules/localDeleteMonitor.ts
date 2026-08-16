import * as path from 'path';
import * as vscode from 'vscode';
import * as debounce from 'lodash.debounce';
import logger from '../logger';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import {
  isValidFile,
  isInWorkspace,
  isSamePath,
  isNotFoundError,
  reportError,
  simplifyPath,
} from '../helper';
import { removeRemote } from '../fileHandlers';
import { renameRemote } from '../fileHandlers/rename';
import { handleCtxFromUri } from '../fileHandlers/createFileHandler';
import { getFileService, getRunningTransformTasks } from './serviceManager';
import { isPaused, isSuppressed, isGitOperationInProgress, readGitHead } from './syncControl';
import { moveToTrash, isTrashEnabled, trashBatchStamp } from './remoteTrash';
import * as activityLog from './activityLog';
import {
  onDidDeleteFiles,
  onDidRenameFiles,
  showChoiceMessage,
  FileDeleteEvent,
  FileRenameEvent,
} from '../host';

/**
 * Mirrors local deletions, renames and moves to the server.
 *
 * Two event sources feed this, because neither is sufficient alone:
 *
 * - `workspace.onDidDeleteFiles` / `onDidRenameFiles` only fire for operations
 *   performed *through* vscode, but they arrive already grouped and they tell a
 *   rename apart from a delete-then-create.
 * - A `FileSystemWatcher` sees everything, including `rm` in a terminal and
 *   `git checkout`, but reports a rename as two unrelated events.
 *
 * Deletion is the one operation here with no undo at the protocol level, so the
 * defaults lean conservative: batches above a threshold ask first, anything
 * happening while git rewrites the working tree is dropped, and the deletion
 * itself goes through the remote trash when it is enabled.
 */

const BATCH_INTERVAL = 700;

// how long the status bar keeps the "skipped because of git" notice
const GIT_NOTICE_MS = 8000;

interface PendingDeletion {
  uri: vscode.Uri;
  fsPath: string;
  /** whether git held a lock at the moment the deletion was observed */
  gitBusyWhenQueued: boolean;
  /** commit or ref HEAD pointed at when the deletion was observed */
  gitHeadWhenQueued: string | null;
}

const deleteQueue = new Map<string, PendingDeletion>();
const disposables: vscode.Disposable[] = [];

// Paths that are the source side of a rename we already mirrored. The watcher
// reports that rename as a deletion too; without this it would delete the file
// we just moved into place on the server.
const recentlyRenamedAway = new Map<string, number>();
const RENAME_SUPPRESSION_MS = 5000;

// windows and macOS both default to case-insensitive filesystems, so an event
// whose casing differs from the queued parent must still match it
const CASE_INSENSITIVE_FS =
  process.platform === 'win32' || process.platform === 'darwin';

function queueKey(fsPath: string): string {
  return CASE_INSENSITIVE_FS ? fsPath.toLowerCase() : fsPath;
}

function markRenamedAway(fsPath: string) {
  recentlyRenamedAway.set(queueKey(fsPath), Date.now());
}

function unmarkRenamedAway(fsPath: string) {
  recentlyRenamedAway.delete(queueKey(fsPath));
}

function wasRenamedAway(fsPath: string): boolean {
  const at = recentlyRenamedAway.get(queueKey(fsPath));
  if (at === undefined) {
    return false;
  }

  if (Date.now() - at > RENAME_SUPPRESSION_MS) {
    recentlyRenamedAway.delete(queueKey(fsPath));
    return false;
  }

  return true;
}

function pruneRenameMarks() {
  const now = Date.now();
  recentlyRenamedAway.forEach((at, key) => {
    if (now - at > RENAME_SUPPRESSION_MS) {
      recentlyRenamedAway.delete(key);
    }
  });
}

/**
 * Drops paths that live under another queued path.
 *
 * Deleting a directory removes its contents, so mirroring the children as well
 * produces a burst of ENOENT noise and, worse, races the parent's recursive
 * delete.
 */
function collapseDescendants(paths: string[]): string[] {
  const sorted = paths.slice().sort((a, b) => a.length - b.length);
  const kept: string[] = [];

  for (const candidate of sorted) {
    const isCovered = kept.some(parent => {
      const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
      return CASE_INSENSITIVE_FS
        ? candidate.toLowerCase().indexOf(prefix.toLowerCase()) === 0
        : candidate.indexOf(prefix) === 0;
    });

    if (!isCovered) {
      kept.push(candidate);
    }
  }

  return kept;
}

function isBeingTransferred(fsPath: string): boolean {
  return getRunningTransformTasks().some(task => isSamePath(task.localFsPath, fsPath));
}

async function confirmBulkDeletion(items: PendingDeletion[], threshold: number): Promise<boolean> {
  const count = items.length;
  const preview = items
    .slice(0, 12)
    .map(item => `  • ${simplifyPath(item.fsPath)}`)
    .join('\n');
  const more = count > 12 ? `\n  … and ${count - 12} more` : '';

  const choice = await showChoiceMessage(
    `SFTP: ${count} local files were deleted. Delete them on the server too?\n\n${preview}${more}`,
    ['Delete on server', 'Keep on server'],
    { modal: true, warning: true }
  );

  if (choice !== 'Delete on server') {
    logger.info(
      `[delete-monitor] user declined mirroring ${count} deletion(s) (threshold ${threshold})`
    );
    return false;
  }

  return true;
}

async function deleteOne(item: PendingDeletion, batchStamp: string): Promise<void> {
  const ctx = handleCtxFromUri(item.uri);
  const { fileService, config, target } = ctx;

  const activityId = activityLog.record({
    kind: activityLog.ActivityKind.Delete,
    localPath: item.fsPath,
    remotePath: target.remoteFsPath,
    serviceName: fileService.name,
    profile: app.state.profile,
    // routed through deleteOne, not straight to removeRemote: a retry must
    // land in the trash exactly like the original attempt would have
    retry: () => deleteOne(item, batchStamp),
  });

  try {
    if (isTrashEnabled(config)) {
      const entry = await moveToTrash(fileService, config, target.remoteFsPath, {
        localPath: item.fsPath,
        batchStamp,
      });
      if (entry) {
        activityLog.succeed(activityId);
        return;
      }
    }

    await removeRemote(item.uri);
    activityLog.succeed(activityId);
  } catch (error) {
    // A path that is already gone on the server is the expected outcome of a
    // file that was never uploaded; it is not a failure worth alarming about.
    if (isNotFoundError(error)) {
      logger.debug(`[delete-monitor] ${target.remoteFsPath} already absent on the remote`);
      activityLog.update(activityId, { status: activityLog.ActivityStatus.Skipped });
      return;
    }

    activityLog.fail(activityId, error);
    throw error;
  }
}


async function processDeletions() {
  const items = Array.from(deleteQueue.values());
  deleteQueue.clear();
  pruneRenameMarks();

  if (items.length === 0) {
    return;
  }

  if (isPaused()) {
    logger.info(`[delete-monitor] ${items.length} deletion(s) skipped: auto sync is paused`);
    return;
  }

  if (isSuppressed()) {
    logger.info(
      `[delete-monitor] ${items.length} deletion(s) skipped: a transfer is rewriting local files`
    );
    return;
  }

  // Group by service so each batch is judged against its own config, and so
  // the confirmation names one server rather than an unattributed pile.
  const byService = new Map<
    string,
    { items: PendingDeletion[]; service: ReturnType<typeof getFileService> }
  >();

  // Deleting a folder of 500 files would otherwise walk up to the git dir 500
  // times, stat-ing eight marker files at every level; and reading HEAD again
  // per item costs another two reads. One answer per directory is enough.
  const gitNowByDir = new Map<string, { busy: boolean; head: string | null }>();
  const gitNow = (dir: string) => {
    let state = gitNowByDir.get(dir);
    if (!state) {
      state = { busy: isGitOperationInProgress(dir), head: readGitHead(dir) };
      gitNowByDir.set(dir, state);
    }
    return state;
  };

  /**
   * Whether git, and not the user, removed this file.
   *
   * Three signals, because each covers a different timing: git was mid-operation
   * when the deletion was seen, git is still mid-operation now (a long rebase),
   * or HEAD moved between the two — which is what a plain `git checkout` leaves
   * behind once its lock is gone.
   */
  const isGitDriven = (item: PendingDeletion): boolean => {
    if (item.gitBusyWhenQueued) {
      return true;
    }

    const now = gitNow(path.dirname(item.fsPath));
    if (now.busy) {
      return true;
    }

    return item.gitHeadWhenQueued !== null && item.gitHeadWhenQueued !== now.head;
  };

  for (const item of items) {
    if (wasRenamedAway(item.fsPath)) {
      logger.debug(`[delete-monitor] ${item.fsPath} skipped: already mirrored as a rename`);
      continue;
    }

    if (isBeingTransferred(item.fsPath)) {
      logger.debug(`[delete-monitor] ${item.fsPath} skipped: transfer in flight`);
      continue;
    }

    const fileService = getFileService(item.uri);
    if (!fileService) {
      continue;
    }

    let config;
    try {
      config = fileService.getConfig();
    } catch (error) {
      // an invalid config (e.g. no profile selected yet) must not turn into a
      // deletion attempt
      logger.debug(`[delete-monitor] ${item.fsPath} skipped: ${error.message}`);
      continue;
    }

    if (config.deleteRemoteOnLocalDelete === false) {
      continue;
    }

    if (config.ignore && config.ignore(item.fsPath)) {
      logger.debug(`[delete-monitor] ${item.fsPath} skipped: ignored by config`);
      continue;
    }

    if (isGitDriven(item)) {
      logger.warn(`[delete-monitor] ${item.fsPath} dropped: caused by a git operation`);
      // A checkout is frequent enough that a modal would be noise, but the user
      // still needs to know the remote was left untouched — otherwise the two
      // sides silently drift apart.
      app.sftpBarItem.setDetail('$(warning) deletions not mirrored (git)');
      const notice = setTimeout(() => app.sftpBarItem.setDetail(null), GIT_NOTICE_MS);
      if (typeof notice.unref === 'function') {
        notice.unref();
      }
      // skip this one only: a multi-root workspace can have an unrelated
      // service whose deletions are the user's own
      continue;
    }

    const key = fileService.baseDir;
    const bucket = byService.get(key);
    if (bucket) {
      bucket.items.push(item);
    } else {
      byService.set(key, { items: [item], service: fileService });
    }
  }

  for (const { items: bucket, service } of Array.from(byService.values())) {
    if (!service) {
      continue;
    }

    const config = service.getConfig();
    const collapsed = collapseDescendants(bucket.map(i => i.fsPath));
    const targets = bucket.filter(i => collapsed.indexOf(i.fsPath) !== -1);

    const threshold =
      typeof config.deleteRemoteConfirmThreshold === 'number'
        ? config.deleteRemoteConfirmThreshold
        : 10;

    if (targets.length > threshold) {
      const confirmed = await confirmBulkDeletion(targets, threshold);
      if (!confirmed) {
        continue;
      }
    }

    // One timestamp folder per batch, so "restore the last deletion" can bring
    // the whole set back together. Second precision and the same format the
    // trash uses elsewhere: a minute-granular stamp made two deletions of the
    // same file within one minute collide on the same trash path.
    const batchStamp = trashBatchStamp(new Date());

    // sequential: a recursive remote rmdir and its siblings racing each other
    // is how you get half-deleted trees
    for (const item of targets) {
      try {
        logger.info(`[delete-monitor] ${item.fsPath}`);
        await deleteOne(item, batchStamp);
      } catch (error) {
        reportError(error, `when deleting ${item.fsPath} on the remote`);
        app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
      }
    }
  }
}

// Serialised on purpose. A batch can sit for a long time waiting on the modal
// confirmation, and letting the debounce fire again meanwhile would stack a
// second dialog on top of the first. Anything deleted in the meantime stays in
// the queue and is picked up by the follow-up run.
let processing: Promise<void> | null = null;

function runProcessing() {
  if (processing) {
    return;
  }

  processing = processDeletions()
    .catch(error => reportError(error, 'delete monitor'))
    .then(() => {
      processing = null;
      if (deleteQueue.size > 0) {
        runProcessing();
      }
    });
}

const scheduleProcessing = debounce(runProcessing, BATCH_INTERVAL);

function enqueueDeletion(uri: vscode.Uri) {
  if (!isValidFile(uri) || !isInWorkspace(uri.fsPath)) {
    return;
  }

  if (isInsideVcsMetadata(uri.fsPath)) {
    return;
  }

  const dir = path.dirname(uri.fsPath);

  // Captured now, not at processing time. `git checkout` finishes in far less
  // than BATCH_INTERVAL, so by the time the batch runs both index.lock and the
  // old HEAD are gone and the deletion would look like the user's own.
  deleteQueue.set(queueKey(uri.fsPath), {
    uri,
    fsPath: uri.fsPath,
    gitBusyWhenQueued: isGitOperationInProgress(dir),
    gitHeadWhenQueued: readGitHead(dir),
  });
  scheduleProcessing();
}

// Version control internals churn constantly (index.lock on every git command,
// COMMIT_EDITMSG, refs/…). Mirroring those deletions means a round trip per git
// command, and floods both the activity log and the confirmation batch.
const VCS_METADATA_DIRS = ['.git', '.svn', '.hg', 'CVS'];

function isInsideVcsMetadata(fsPath: string): boolean {
  const segments = fsPath.split(/[\\/]/);
  return segments.some(segment => VCS_METADATA_DIRS.indexOf(segment) !== -1);
}

async function handleRename(oldUri: vscode.Uri, newUri: vscode.Uri) {
  if (!isValidFile(oldUri) || !isValidFile(newUri) || !isInWorkspace(newUri.fsPath)) {
    return;
  }

  if (isPaused() || isSuppressed()) {
    return;
  }

  const fileService = getFileService(newUri);
  if (!fileService) {
    return;
  }

  let config;
  try {
    config = fileService.getConfig();
  } catch (error) {
    return;
  }

  if (config.renameRemoteOnLocalRename === false) {
    return;
  }

  // A rename out of an ignored path into a tracked one (or vice versa) isn't a
  // rename as far as the remote is concerned; let the normal upload/delete
  // paths handle those.
  if (config.ignore && (config.ignore(oldUri.fsPath) || config.ignore(newUri.fsPath))) {
    return;
  }

  // claim the deletion before the watcher sees it
  markRenamedAway(oldUri.fsPath);

  const activityId = activityLog.record({
    kind: activityLog.ActivityKind.Rename,
    localPath: newUri.fsPath,
    fromPath: oldUri.fsPath,
    serviceName: fileService.name,
    profile: app.state.profile,
  });

  try {
    logger.info(`[rename-monitor] ${oldUri.fsPath} -> ${newUri.fsPath}`);
    await renameRemote(newUri, { fromLocalPath: oldUri.fsPath });
    activityLog.succeed(activityId);
  } catch (error) {
    // Release the claim on the old path. The watcher also reported this rename
    // as a deletion; leaving the mark set would suppress it, and the remote
    // would keep the old file forever while the new one never arrives.
    unmarkRenamedAway(oldUri.fsPath);

    activityLog.update(activityId, {
      status: activityLog.ActivityStatus.Failed,
      error: error.message,
      retry: () => renameRemote(newUri, { fromLocalPath: oldUri.fsPath }),
    });
    reportError(error, `when renaming ${oldUri.fsPath} on the remote`);
    app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
  }
}

export function init() {
  destroy();

  // vscode-originated operations: grouped, and renames are identifiable
  disposables.push(
    onDidDeleteFiles((event: FileDeleteEvent) => {
      event.files.forEach(enqueueDeletion);
    })
  );

  disposables.push(
    onDidRenameFiles((event: FileRenameEvent) => {
      event.files.forEach(({ oldUri, newUri }) => {
        handleRename(oldUri, newUri).catch(error => reportError(error, 'rename monitor'));
      });
    })
  );

  // everything else: terminal, external tools, git. Create and change events
  // are already covered by uploadOnSave and the per-service watcher.
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    folders.forEach(folder => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '**/*'),
        true,
        true,
        false
      );
      watcher.onDidDelete(enqueueDeletion);
      disposables.push(watcher);
    });
  }
}

export function destroy() {
  disposables.forEach(d => d.dispose());
  disposables.length = 0;
  deleteQueue.clear();
  recentlyRenamedAway.clear();
}

export default {
  init,
  destroy,
};

// exported for tests
export const testHooks = {
  collapseDescendants,
  markRenamedAway,
  wasRenamedAway,
  isNotFound: isNotFoundError,
};
