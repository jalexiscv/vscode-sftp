import * as path from 'path';
import * as vscode from 'vscode';
import * as debounce from 'lodash.debounce';
import logger from '../logger';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import { isValidFile, isInWorkspace, isSamePath, fileDepth } from '../helper';
import { FileService, TransferDirection } from '../core';
import { uploadFile } from '../fileHandlers';
import { getFileService, getRunningTransformTasks } from './serviceManager';
import { isPaused, isSuppressed, isGitOperationInProgress, readGitHead } from './syncControl';

/**
 * The single entry point for "this local file changed and must reach the
 * server".
 *
 * uploadOnSave, the per-service watcher and, later, the external-change
 * scanner all observe the same edit through different channels; an in-editor
 * save with the watcher on used to fire both and upload the file twice. Every
 * source now drops its change here: the collector dedupes by path, waits for
 * the burst to settle, applies the admission rules once (pause, suppression,
 * workspace, ignore, in-flight downloads) and hands one batch per service to
 * the batch handler, which by default uploads each file.
 *
 * Git awareness mirrors localDeleteMonitor: the lock state and HEAD are
 * captured when the change is queued, because a checkout finishes well within
 * the batching window, and a batch is flagged `gitDriven` when git was busy
 * then, is busy now, or HEAD moved in between. For now a git-driven batch is
 * only logged and processed like any other; asking first is a later phase.
 *
 * Key lifecycle methods:
 * - {@link enqueueChange} queues a change from one of the sources.
 * - {@link setBatchHandler} replaces what is done with a batch; null restores
 *   the default upload.
 * - {@link flushNow} pushes the pending changes through without waiting.
 * - {@link destroy} drops the queue and the timer on deactivate.
 */

export type ChangeSource = 'save' | 'watcher' | 'scan' | 'poll' | 'command';

export interface PendingChange {
  uri: vscode.Uri;
  fsPath: string;
  source: ChangeSource;
  queuedAt: number;
  /** whether git held a lock when the change was observed */
  gitBusyWhenQueued: boolean;
  /** commit or ref HEAD pointed at when the change was observed */
  gitHeadWhenQueued: string | null;
}

export interface ChangeBatch {
  service: FileService;
  items: PendingChange[];
  /** git, not the user, is the likely author of these changes */
  gitDriven: boolean;
}

export type BatchHandler = (batch: ChangeBatch) => Promise<void>;

// same window as localDeleteMonitor: long enough to swallow the save+watcher
// pair and an editor's write-rename-write dance, short enough to feel instant
const BATCH_INTERVAL = 700;

// windows and macOS default to case-insensitive filesystems, so a save and a
// watcher event that differ only in casing are the same file
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

const pending = new Map<string, PendingChange>();
const pendingListeners: Array<() => void> = [];

function queueKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return CASE_INSENSITIVE_FS ? normalized.toLowerCase() : normalized;
}

function notifyPending() {
  pendingListeners.forEach(listener => {
    try {
      listener();
    } catch (error) {
      logger.error(error, 'changeCollector listener');
    }
  });
}

interface GitState {
  busy: boolean;
  head: string | null;
}

/**
 * One answer per directory for the whole pass: a batch of 500 files would
 * otherwise walk up to the git dir 500 times and read HEAD as many.
 */
function createGitStateCache(): (dir: string) => GitState {
  const byDir = new Map<string, GitState>();
  return dir => {
    let state = byDir.get(dir);
    if (!state) {
      state = { busy: isGitOperationInProgress(dir), head: readGitHead(dir) };
      byDir.set(dir, state);
    }
    return state;
  };
}

/**
 * Whether git, and not the user, changed this file.
 *
 * Three signals, because each covers a different timing: git was mid-operation
 * when the change was seen, git is still mid-operation now (a long rebase), or
 * HEAD moved between the two — which is what a plain `git checkout` leaves
 * behind once its lock is gone.
 */
function isGitDriven(item: PendingChange, gitNow: (dir: string) => GitState): boolean {
  if (item.gitBusyWhenQueued) {
    return true;
  }

  const now = gitNow(path.dirname(item.fsPath));
  if (now.busy) {
    return true;
  }

  return item.gitHeadWhenQueued !== null && item.gitHeadWhenQueued !== now.head;
}

/**
 * Default handler: one uploadFile per item, in parallel. The transfer
 * scheduler caps the real concurrency, and the per-task activity entries come
 * from the service hooks, so nothing is recorded here. Every path of the
 * callback is inside the try, so no rejection escapes as an unhandled one.
 */
async function uploadBatch(batch: ChangeBatch): Promise<void> {
  if (batch.gitDriven) {
    logger.warn(`[change-collector] git-driven batch of ${batch.items.length} file(s)`);
  }

  await Promise.all(
    batch.items.map(async item => {
      const fspath = item.fsPath;
      try {
        logger.info(`[change-collector/${item.source}] ${fspath}`);
        await uploadFile(item.uri);
      } catch (error) {
        logger.error(error, `upload ${fspath}`);
        app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
      }
    })
  );
}

let batchHandler: BatchHandler = uploadBatch;

async function processPending(): Promise<void> {
  const items = Array.from(pending.values());
  pending.clear();
  notifyPending();

  if (items.length === 0) {
    return;
  }

  if (isPaused()) {
    logger.info(`[change-collector] ${items.length} change(s) skipped: auto sync is paused`);
    return;
  }

  if (isSuppressed()) {
    logger.info(
      `[change-collector] ${items.length} change(s) skipped: a transfer is rewriting local files`
    );
    return;
  }

  // a `sync remote ➞ local` is writing these right now; uploading them back
  // would push whatever half-written state is on disk over the download
  const downloading = getRunningTransformTasks().filter(
    task => task.transferType === TransferDirection.REMOTE_TO_LOCAL
  );
  const gitNow = createGitStateCache();

  // one batch per service, keyed by base dir like the delete monitor, so each
  // is judged against its own config and handled in one call
  const byService = new Map<string, ChangeBatch>();

  for (const item of items) {
    if (!isValidFile(item.uri) || !isInWorkspace(item.fsPath)) {
      logger.debug(`[change-collector] ${item.fsPath} skipped: outside the workspace`);
      continue;
    }

    const fileService = getFileService(item.uri);
    if (!fileService) {
      logger.debug(`[change-collector] ${item.fsPath} skipped: no config covers it`);
      continue;
    }

    let config;
    try {
      config = fileService.getConfig();
    } catch (error) {
      // an invalid config (e.g. no profile selected yet) is reported by the
      // explicit commands; an automatic path only notes it
      logger.debug(`[change-collector] ${item.fsPath} skipped: ${error.message}`);
      continue;
    }

    if (config.ignore && config.ignore(item.fsPath)) {
      logger.debug(`[change-collector] ${item.fsPath} skipped: ignored by config`);
      continue;
    }

    if (downloading.some(task => isSamePath(task.localFsPath, item.fsPath))) {
      logger.info(`[change-collector] ${item.fsPath} skipped: it is being downloaded`);
      continue;
    }

    const key = fileService.baseDir;
    let batch = byService.get(key);
    if (!batch) {
      batch = { service: fileService, items: [], gitDriven: false };
      byService.set(key, batch);
    }
    batch.items.push(item);
    if (isGitDriven(item, gitNow)) {
      batch.gitDriven = true;
    }
  }

  for (const batch of Array.from(byService.values())) {
    // deepest first, as the watcher always ordered its uploads
    batch.items.sort((a, b) => fileDepth(b.fsPath) - fileDepth(a.fsPath));
    try {
      await batchHandler(batch);
    } catch (error) {
      logger.error(error, 'change collector');
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  }
}

// Serialised on purpose, like the delete monitor: a handler may take a while
// (or, in a later phase, wait on a confirmation), and a second pass must not
// overlap it. Anything queued meanwhile stays and is picked up by the
// follow-up run.
let processing: Promise<void> | null = null;

function runProcessing() {
  if (processing) {
    return;
  }

  processing = processPending()
    .catch(error => logger.error(error, 'change collector'))
    .then(() => {
      processing = null;
      if (pending.size > 0) {
        runProcessing();
      }
    });
}

const scheduleProcessing = debounce(runProcessing, BATCH_INTERVAL);

/**
 * Queues a local change. A repeat of the same path within the window replaces
 * the entry (one upload per file, whatever the number of sources) but keeps
 * the earlier git signals: a HEAD comparison needs the oldest snapshot.
 */
export function enqueueChange(uri: vscode.Uri, source: ChangeSource): void {
  const fsPath = uri.fsPath;
  const key = queueKey(fsPath);
  const dir = path.dirname(fsPath);
  const previous = pending.get(key);

  // Captured now, not at processing time: `git checkout` finishes in far less
  // than BATCH_INTERVAL, so by then both the lock and the old HEAD are gone.
  pending.set(key, {
    uri,
    fsPath,
    source,
    queuedAt: Date.now(),
    gitBusyWhenQueued:
      (previous !== undefined && previous.gitBusyWhenQueued) || isGitOperationInProgress(dir),
    gitHeadWhenQueued: previous !== undefined ? previous.gitHeadWhenQueued : readGitHead(dir),
  });
  notifyPending();
  scheduleProcessing();
}

/** Replaces what is done with a batch. `null` restores the default upload. */
export function setBatchHandler(handler: BatchHandler | null): void {
  batchHandler = handler || uploadBatch;
}

/**
 * Processes whatever is pending right away, and resolves once the queue has
 * drained — including changes that arrive while a pass is running.
 */
export async function flushNow(): Promise<void> {
  scheduleProcessing.cancel();
  runProcessing();
  while (processing) {
    await processing;
  }
}

export function pendingCount(): number {
  return pending.size;
}

export function onDidChangePending(listener: () => void): vscode.Disposable {
  pendingListeners.push(listener);
  return {
    dispose() {
      const index = pendingListeners.indexOf(listener);
      if (index !== -1) {
        pendingListeners.splice(index, 1);
      }
    },
  };
}

export function destroy() {
  scheduleProcessing.cancel();
  pending.clear();
  pendingListeners.length = 0;
}

export default {
  destroy,
};

// test seam: the module keeps process-wide state
export function __resetForTest() {
  destroy();
  batchHandler = uploadBatch;
  processing = null;
}

// exported for tests
export const testHooks = {
  queueKey,
  isGitDriven,
  BATCH_INTERVAL,
};
