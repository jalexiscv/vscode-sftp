import * as vscode from 'vscode';
import * as path from 'path';
import * as debounce from 'lodash.debounce';
import logger from '../logger';
import { isValidFile, isInWorkspace, fileDepth, isSamePath } from '../helper';
import { upload, removeRemote } from '../fileHandlers';
import { WatcherService, TransferDirection } from '../core';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import { getRunningTransformTasks, getFileService } from './serviceManager';
import { isPaused, isSuppressed, isGitOperationInProgress } from './syncControl';
import { ActivityKind, record, succeed, fail } from './activityLog';

/**
 * Whether localDeleteMonitor owns this deletion.
 *
 * `watcher.autoDelete` and `deleteRemoteOnLocalDelete` mirror the same event.
 * Running both is not merely redundant: this path deletes outright, ignores the
 * remote trash and never asks for confirmation, and its debounce leads rather
 * than trails — so it would win the race and strip every safeguard off a
 * deletion the monitor was about to handle carefully. The monitor is the one
 * that stays.
 */
function isHandledByDeleteMonitor(uri: vscode.Uri): boolean {
  const fileService = getFileService(uri);
  if (!fileService) {
    return false;
  }

  try {
    return fileService.getConfig().deleteRemoteOnLocalDelete !== false;
  } catch (error) {
    // an unusable config means nothing will be mirrored either way; let the
    // monitor be the one to report it
    return true;
  }
}

const watchers: {
  [x: string]: vscode.FileSystemWatcher;
} = {};

// keyed by path, not by Uri: vscode hands out a fresh Uri object per event, so
// a Set would keep one entry per *event* instead of one per file.
const uploadQueue = new Map<string, vscode.Uri>();
const deleteQueue = new Map<string, vscode.Uri>();

// less than 550 will not work
const ACTION_INTEVAL = 550;

// same criterion as `isSamePath`: windows paths are case-insensitive
function queueKey(fsPath: string) {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function suspendReason(): string | null {
  if (isPaused()) {
    return 'automatic sync is paused';
  }

  if (isSuppressed()) {
    return 'the extension is running a transfer that touches local files';
  }

  return null;
}

/**
 * Drops paths already covered by an ancestor in the same batch.
 *
 * Removing a folder fires one event for the folder and one for every file
 * under it. Deleting the folder on the remote takes the children with it, so
 * the per-child calls can only fail with ENOENT and fill the log with noise.
 */
function dropDescendants(uris: vscode.Uri[]): vscode.Uri[] {
  const keys = uris.map(uri => queueKey(uri.fsPath));
  return uris.filter((_uri, index) =>
    keys.every(
      (other, otherIndex) => otherIndex === index || !keys[index].startsWith(other + path.sep)
    )
  );
}

function serviceNameOf(uri: vscode.Uri): string | undefined {
  const fileService = getFileService(uri);
  return fileService ? fileService.name : undefined;
}

function doUpload() {
  const files = Array.from(uploadQueue.values()).sort(
    (a, b) => fileDepth(b.fsPath) - fileDepth(a.fsPath)
  );
  uploadQueue.clear();
  if (files.length <= 0) {
    return;
  }

  const suspended = suspendReason();
  if (suspended) {
    logger.info(`[watcher/updated] skip ${files.length} file(s), ${suspended}`);
    return;
  }

  const currentDownloadTasks = getRunningTransformTasks().filter(
    task => task.transferType === TransferDirection.REMOTE_TO_LOCAL
  );

  // uploads stay parallel: they are independent writes and the transfer
  // scheduler already caps the real concurrency. Every path of the callback is
  // inside the try, so no rejection escapes as an unhandled one.
  files.forEach(async uri => {
    const fspath = uri.fsPath;
    try {
      // current target is still in downloading, so don't upload it.
      if (currentDownloadTasks.find(task => isSamePath(task.localFsPath, uri.fsPath))) {
        return;
      }

      logger.info(`[watcher/updated] ${fspath}`);
      await upload(uri);
    } catch (error) {
      logger.error(error, `upload ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  });
}

async function doDelete() {
  const files = Array.from(deleteQueue.values()).sort(
    (a, b) => fileDepth(b.fsPath) - fileDepth(a.fsPath)
  );
  deleteQueue.clear();
  if (files.length <= 0) {
    return;
  }

  const suspended = suspendReason();
  if (suspended) {
    logger.info(`[watcher/removed] skip ${files.length} file(s), ${suspended}`);
    return;
  }

  // a checkout, rebase or stash rewrites the working tree and can remove
  // hundreds of files at once. That is git moving between commits, not the
  // user asking for anything to be removed from the server.
  if (files.some(uri => isGitOperationInProgress(path.dirname(uri.fsPath)))) {
    logger.warn(
      `[watcher/removed] skip ${files.length} file(s), a git operation is in progress`
    );
    return;
  }

  // symmetric to doUpload: a `sync remote ➞ local` with `syncOption.delete`
  // removes local files as it goes and a download replaces them, so mirroring
  // those events back would destroy what was just transferred. Both directions
  // matter here, unlike in doUpload.
  const runningTasks = getRunningTransformTasks();
  const targets = dropDescendants(files).filter(uri => {
    if (runningTasks.find(task => isSamePath(task.localFsPath, uri.fsPath))) {
      logger.info(`[watcher/removed] skip ${uri.fsPath}, it belongs to a running transfer`);
      return false;
    }

    return true;
  });

  // sequential: the batch is sorted deepest first so the remote never sees a
  // child removal racing its parent, and that order only means something if it
  // is awaited.
  for (const uri of targets) {
    const fspath = uri.fsPath;
    logger.info(`[watcher/removed] ${fspath}`);
    const activityId = record({
      kind: ActivityKind.Delete,
      localPath: fspath,
      serviceName: serviceNameOf(uri),
    });
    try {
      await removeRemote(uri);
      succeed(activityId);
    } catch (error) {
      fail(activityId, error);
      logger.error(error, `remove ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  }
}

const debouncedUpload = debounce(doUpload, ACTION_INTEVAL, { leading: true, trailing: true });
// doDelete is async and the debounced call site can't await it, so the last
// rejection barrier has to live here
const debouncedDelete = debounce(
  () => {
    doDelete().catch(error => logger.error(error, 'watcher delete'));
  },
  ACTION_INTEVAL,
  { leading: true, trailing: true }
);

function uploadHandler(uri: vscode.Uri) {
  if (!isValidFile(uri)) {
    return;
  }

  uploadQueue.set(queueKey(uri.fsPath), uri);
  debouncedUpload();
}

function addWatcher(id, watcher) {
  watchers[id] = watcher;
}

function getWatcher(id) {
  return watchers[id];
}

function createWatcher(
  watcherBase: string,
  watcherConfig: { files: false | string; autoUpload: boolean; autoDelete: boolean }
) {
  let watcher = getWatcher(watcherBase);
  if (watcher) {
    // clear old watcher
    watcher.dispose();
    // drop it from the map too: the early returns below would otherwise leave
    // the entry pointing at a disposed watcher, which `removeWatcher` then
    // disposes a second time.
    delete watchers[watcherBase];
  }

  if (!watcherConfig) {
    return;
  }

  const shouldAddListenser = watcherConfig.autoUpload || watcherConfig.autoDelete;
  // `files` disables the watcher when it is false, but the schema also accepts
  // null and the property can simply be absent. `undefined == false` is false,
  // so the old loose check let those through into `new RelativePattern(base,
  // undefined)`.
  if (!watcherConfig.files || !shouldAddListenser) {
    return;
  }

  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(watcherBase, watcherConfig.files),
    false,
    false,
    false
  );
  addWatcher(watcherBase, watcher);

  if (watcherConfig.autoUpload) {
    watcher.onDidCreate(uploadHandler);
    watcher.onDidChange(uploadHandler);
  }

  if (watcherConfig.autoDelete) {
    watcher.onDidDelete(uri => {
      // same admission check as fileActivityMonitor: a path outside the
      // workspace has no service to mirror it to
      if (!isValidFile(uri) || !isInWorkspace(uri.fsPath)) {
        return;
      }

      if (isHandledByDeleteMonitor(uri)) {
        return;
      }

      deleteQueue.set(queueKey(uri.fsPath), uri);
      debouncedDelete();
    });
  }
}

function removeWatcher(watcherBase: string) {
  const watcher = getWatcher(watcherBase);
  if (watcher) {
    watcher.dispose();
    delete watchers[watcherBase];
  }
}

const watcherService: WatcherService = {
  create: createWatcher,
  dispose: removeWatcher,
};

export default watcherService;
