import * as path from 'path';
import * as vscode from 'vscode';
import * as debounce from 'lodash.debounce';
import logger from '../logger';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import fsPromises from '../helper/fsPromises';
import { isValidFile, isSamePath, fileDepth, toRemotePath } from '../helper';
import { FileService, ServiceConfig, TransferDirection } from '../core';
import { resolveExternalChangesConfig } from '../core/fileService';
import { getFileService, getRunningTransformTasks } from './serviceManager';
import { isPaused, isSuppressed, isGitRewritingWorkingTree, readGitHeadRef } from './syncControl';
import { indexFor } from './syncIndexFeeder';
import { toRelPath } from './syncIndex';
import { scanLocalTree } from './localScanner';
import { createPlan, PlanSource, UploadPlanItemDraft } from './uploadPlan';
import { confirmAndRunPlan } from './planConfirmation';

/**
 * The single entry point for "this local file changed and must reach the
 * server".
 *
 * uploadOnSave, the per-service watcher and the external-change scanner all
 * observe the same edit through different channels; an in-editor save with
 * the watcher on used to fire both and upload the file twice. Every source
 * now drops its change here: the collector dedupes by path, waits for a burst
 * to settle, applies the admission rules once (pause, suppression, ignore,
 * in-flight transfers), groups the changes per service and hands each batch
 * to the batch handler — which by default turns it into an upload plan and
 * runs it through planRunner, asking first when the batch is large or
 * git-driven.
 *
 * Timing: a save from the editor is processed at once, so uploadOnSave keeps
 * the latency it always had, and the watcher's report of that same write is
 * dropped for a short while afterwards; watcher, scan and poll changes are
 * batched with a trailing window capped by a maximum wait, so a file that is
 * rewritten continuously (a log, a dev-server bundle) can never starve the
 * rest. The cheap guards (scheme, owning service, ignore) run *before* a
 * change enters the queue — an ignored path must not even reset the window —
 * and the config and git state are sampled once per service or directory for
 * the duration of a burst.
 *
 * Git awareness: the HEAD *ref* (not the commit, so a `git commit` changes
 * nothing) and whether git is rewriting the working tree are captured when the
 * change is queued, because a checkout finishes well within the window. A
 * batch is `gitDriven` when git was busy then, is busy now, or HEAD moved to
 * another ref in between; such a batch always asks before uploading.
 *
 * Key lifecycle methods:
 * - {@link enqueueChange} queues a change from one of the sources.
 * - {@link setBatchHandler} replaces what is done with a batch; null restores
 *   the default plan-and-run.
 * - {@link flushNow} pushes the pending changes through without waiting.
 * - {@link destroy} drops the queue and the timer on deactivate.
 */

export type ChangeSource = 'save' | 'watcher' | 'scan' | 'poll' | 'command';

export interface PendingChange {
  uri: vscode.Uri;
  fsPath: string;
  source: ChangeSource;
  queuedAt: number;
  /** whether git was rewriting the working tree when the change was observed */
  gitBusyWhenQueued: boolean;
  /** ref HEAD pointed at when the change was observed (`refs/heads/x`, `detached:<sha>`) */
  gitHeadWhenQueued: string | null;
}

export interface ChangeBatch {
  service: FileService;
  items: PendingChange[];
  /** git, not the user, is the likely author of these changes */
  gitDriven: boolean;
}

export type BatchHandler = (batch: ChangeBatch) => Promise<void>;

// same window as localDeleteMonitor: long enough to swallow an editor's
// write-rename-write dance, short enough to feel instant
const BATCH_INTERVAL = 700;

// a burst that never pauses for BATCH_INTERVAL (a file rewritten every few
// hundred ms) is still processed this often
const MAX_WAIT = 2 * BATCH_INTERVAL;

// how long after a save the watcher's report of the same write is ignored;
// event delivery is well under this, even on slow watchers
const RECENTLY_HANDLED_TTL = 1500;

// windows and macOS default to case-insensitive filesystems, so a save and a
// watcher event that differ only in casing are the same file
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

type ProcessingMode = 'all' | 'saves';

const pending = new Map<string, PendingChange>();
const pendingListeners: Array<() => void> = [];

// keys whose last pass put them back because their upload was in flight; a
// follow-up pass that only finds these waits for the timer instead of spinning
const deferredKeys = new Set<string>();

// keys of saves seen recently, so the watcher's event for the same write is
// dropped before it can queue a second upload
const recentlyHandled = new Map<string, number>();

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

function markHandled(key: string) {
  recentlyHandled.set(key, Date.now());
}

function wasRecentlyHandled(key: string): boolean {
  const at = recentlyHandled.get(key);
  if (at === undefined) {
    return false;
  }
  if (Date.now() - at > RECENTLY_HANDLED_TTL) {
    recentlyHandled.delete(key);
    return false;
  }
  return true;
}

function pruneRecentlyHandled() {
  const now = Date.now();
  recentlyHandled.forEach((at, key) => {
    if (now - at > RECENTLY_HANDLED_TTL) {
      recentlyHandled.delete(key);
    }
  });
}

interface GitState {
  busy: boolean;
  ref: string | null;
}

function sampleGitState(dir: string): GitState {
  return { busy: isGitRewritingWorkingTree(dir), ref: readGitHeadRef(dir) };
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
      state = sampleGitState(dir);
      byDir.set(dir, state);
    }
    return state;
  };
}

// Per-burst caches, dropped when the queue drains. An `npm install` or a
// checkout with `**/*` watched is tens of thousands of events; resolving the
// config (validation, profile merge) and walking up to .git for each of them
// would stall the extension host.
let gitStateOfDir = createGitStateCache();
let configCache = new Map<string, ServiceConfig | Error>();

function resolveConfig(fileService: FileService): ServiceConfig | null {
  const key = `${fileService.id}|${app.state.profile || ''}`;
  const cached = configCache.get(key);
  if (cached !== undefined) {
    return cached instanceof Error ? null : cached;
  }

  let resolved: ServiceConfig | Error;
  try {
    resolved = fileService.getConfig();
  } catch (error) {
    // an invalid config (e.g. no profile selected yet) is reported by the
    // explicit commands; an automatic path only notes it, once per burst
    logger.debug(`[change-collector] ${fileService.name || fileService.baseDir}: ${error.message}`);
    resolved = error;
  }
  configCache.set(key, resolved);
  return resolved instanceof Error ? null : resolved;
}

function dropBurstCaches() {
  gitStateOfDir = createGitStateCache();
  configCache = new Map();
}

/**
 * Whether git, and not the user, changed this file.
 *
 * Three signals, because each covers a different timing: git was rewriting the
 * tree when the change was seen, git is still at it now (a long rebase), or
 * HEAD moved to another ref in between — which is what a plain `git checkout`
 * leaves behind once its lock is gone. A commit on the same branch moves
 * neither the ref nor the tree, so it is not a signal.
 */
function isGitDriven(item: PendingChange, gitNow: (dir: string) => GitState): boolean {
  if (item.gitBusyWhenQueued) {
    return true;
  }

  const now = gitNow(path.dirname(item.fsPath));
  if (now.busy) {
    return true;
  }

  return item.gitHeadWhenQueued !== null && item.gitHeadWhenQueued !== now.ref;
}

function planSourceFor(batch: ChangeBatch): PlanSource {
  if (batch.gitDriven) {
    return 'git';
  }
  const sources = batch.items.map(item => item.source);
  if (sources.indexOf('watcher') !== -1) {
    return 'watcher';
  }
  if (sources.indexOf('poll') !== -1) {
    return 'poll';
  }
  if (sources.indexOf('scan') !== -1) {
    return 'scan';
  }
  return 'command';
}

/**
 * Default handler: the batch becomes one upload plan per service, which is
 * confirmed when large or git-driven and then handed to planRunner — without
 * waiting for the uploads, so a long run never holds the next batch back. A
 * directory in the batch (a folder dropped into the workspace arrives as one
 * event for it, and maybe one per file inside) is expanded into its files, so
 * the plan stays per file and nothing is uploaded twice.
 */
async function planBatch(batch: ChangeBatch): Promise<void> {
  const { service } = batch;
  const config = resolveConfig(service);
  if (!config) {
    return;
  }

  const index = await indexFor(service, config);
  const items: UploadPlanItemDraft[] = [];
  const seen = new Set<string>();

  const addFile = (fsPath: string, size: number, mtime: number) => {
    const key = queueKey(fsPath);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const relPath = toRelPath(service.baseDir, fsPath);
    items.push({
      localPath: fsPath,
      remotePath: toRemotePath(fsPath, service.baseDir, config.remotePath),
      reason: index.get(relPath) ? 'modified' : 'new',
      localSize: size,
      localMtime: mtime,
    });
  };

  for (const item of batch.items) {
    let stat;
    try {
      stat = await fsPromises.lstat(item.fsPath);
    } catch (error) {
      // gone between the event and the batch (a temp file, a rename); the
      // delete monitor owns that side
      logger.debug(`[change-collector] ${item.fsPath} skipped: ${error.message}`);
      continue;
    }

    if (stat.isDirectory()) {
      const scan = await scanLocalTree(item.fsPath, { ignore: config.ignore });
      scan.files.forEach(file => addFile(file.fsPath, file.size, file.mtime));
      continue;
    }

    if (!stat.isFile() && !stat.isSymbolicLink()) {
      continue;
    }
    addFile(item.fsPath, stat.size, stat.mtime.getTime());
  }

  if (items.length === 0) {
    return;
  }

  const plan = createPlan({
    serviceName: service.name,
    profile: app.state.profile,
    source: planSourceFor(batch),
    items,
  });
  logger.info(
    `[change-collector] plan ${plan.id}: ${items.length} file(s) from ${plan.source} for ${service.name}`
  );

  await confirmAndRunPlan(plan, {
    serviceName: service.name,
    host: config.host,
    confirmThreshold: resolveExternalChangesConfig(config).confirmThreshold,
    awaitRun: false,
  });
}

let batchHandler: BatchHandler = planBatch;

function takePending(mode: ProcessingMode): PendingChange[] {
  const taken: PendingChange[] = [];
  pending.forEach((item, key) => {
    if (mode === 'all' || item.source === 'save') {
      taken.push(item);
      pending.delete(key);
    }
  });
  return taken;
}

async function processPending(mode: ProcessingMode): Promise<void> {
  const items = takePending(mode);
  pruneRecentlyHandled();
  if (items.length === 0) {
    return;
  }
  notifyPending();

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

  const runningTasks = getRunningTransformTasks();
  // a `sync remote ➞ local` is writing these right now; uploading them back
  // would push whatever half-written state is on disk over the download
  const downloading = runningTasks.filter(
    task => task.transferType === TransferDirection.REMOTE_TO_LOCAL
  );
  // an upload of the same path is in flight: a second one would race it on
  // the server (two `.new` files, two renames), so the change waits a pass
  const uploading = runningTasks.filter(
    task => task.transferType === TransferDirection.LOCAL_TO_REMOTE
  );
  const gitNow = createGitStateCache();

  // one batch per service, keyed by base dir like the delete monitor, so each
  // is judged against its own config and handled in one call
  const byService = new Map<string, ChangeBatch>();

  for (const item of items) {
    const fileService = getFileService(item.uri);
    if (!fileService) {
      logger.debug(`[change-collector] ${item.fsPath} skipped: no config covers it`);
      continue;
    }

    const config = resolveConfig(fileService);
    if (!config) {
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

    if (uploading.some(task => isSamePath(task.localFsPath, item.fsPath))) {
      const itemKey = queueKey(item.fsPath);
      // unless a newer event for the path arrived meanwhile, which supersedes it
      if (!pending.has(itemKey)) {
        pending.set(itemKey, item);
        deferredKeys.add(itemKey);
        notifyPending();
      }
      logger.debug(`[change-collector] ${item.fsPath} deferred: an upload of it is in flight`);
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

// Serialised on purpose, like the delete monitor: a handler may wait on a
// confirmation, and a second pass must not stack a dialog on top of it.
// Anything queued meanwhile stays and is picked up afterwards: saves at once,
// the rest when their window closes.
let processing: Promise<void> | null = null;

function hasImmediatePending(): boolean {
  let found = false;
  pending.forEach((item, key) => {
    if (item.source === 'save' && !deferredKeys.has(key)) {
      found = true;
    }
  });
  return found;
}

function onlyDeferredPending(): boolean {
  let onlyDeferred = pending.size > 0;
  pending.forEach((_item, key) => {
    if (!deferredKeys.has(key)) {
      onlyDeferred = false;
    }
  });
  return onlyDeferred;
}

function followUp() {
  processing = null;
  if (pending.size === 0) {
    deferredKeys.clear();
    dropBurstCaches();
    return;
  }
  if (hasImmediatePending()) {
    runProcessing('saves');
    return;
  }
  // a pass that was requested while this one ran was a no-op; re-arm the
  // window so those changes (and the deferred ones, after a pause) get their
  // turn
  scheduleProcessing();
}

function runProcessing(mode: ProcessingMode = 'all') {
  if (processing) {
    return;
  }

  processing = processPending(mode)
    .catch(error => logger.error(error, 'change collector'))
    .then(followUp);
}

const scheduleProcessing = debounce(() => runProcessing('all'), BATCH_INTERVAL, {
  maxWait: MAX_WAIT,
});

/**
 * Queues a local change. A repeat of the same path within the window replaces
 * the entry (one upload per file, whatever the number of sources) but keeps
 * the earlier git signals: a ref comparison needs the oldest snapshot.
 *
 * The cheap guards run here, before the queue is touched: an event for a path
 * no service covers, or that the config ignores, must not restart the window
 * nor cost a git probe. Pause and suppression are judged when the batch is
 * processed, which is when they matter.
 */
export function enqueueChange(uri: vscode.Uri, source: ChangeSource): void {
  if (!isValidFile(uri)) {
    return;
  }

  const fsPath = uri.fsPath;
  const key = queueKey(fsPath);
  if (source === 'watcher' && wasRecentlyHandled(key)) {
    logger.debug(`[change-collector] ${fsPath} skipped: the save was just handled`);
    return;
  }

  // the owning service decides admission, not the workspace folder: a
  // `context` outside the folder (absolute, or `../`) is still served
  const fileService = getFileService(uri);
  if (!fileService) {
    logger.debug(`[change-collector] ${fsPath} skipped: no config covers it`);
    return;
  }

  const config = resolveConfig(fileService);
  if (!config) {
    return;
  }

  if (config.ignore && config.ignore(fsPath)) {
    logger.debug(`[change-collector] ${fsPath} skipped: ignored by config`);
    return;
  }

  // Captured now, not at processing time: `git checkout` finishes in far less
  // than BATCH_INTERVAL, so by then both the lock and the old ref are gone.
  const git = gitStateOfDir(path.dirname(fsPath));
  const previous = pending.get(key);
  pending.set(key, {
    uri,
    fsPath,
    source,
    queuedAt: Date.now(),
    gitBusyWhenQueued: (previous !== undefined && previous.gitBusyWhenQueued) || git.busy,
    gitHeadWhenQueued: previous !== undefined ? previous.gitHeadWhenQueued : git.ref,
  });
  deferredKeys.delete(key);
  notifyPending();

  if (source === 'save') {
    // the user is waiting on this one; the watcher's echo of the same write
    // is dropped for a while
    markHandled(key);
    runProcessing('saves');
  } else {
    scheduleProcessing();
  }
}

/** Replaces what is done with a batch. `null` restores the default plan-and-run. */
export function setBatchHandler(handler: BatchHandler | null): void {
  batchHandler = handler || planBatch;
}

/**
 * Processes whatever is pending right away, and resolves once the queue has
 * drained — including changes that arrive while a pass is running. Changes
 * deferred behind an upload in flight are left for the timer.
 */
export async function flushNow(): Promise<void> {
  while (true) {
    scheduleProcessing.cancel();
    if (processing) {
      await processing;
      continue;
    }
    if (pending.size === 0 || onlyDeferredPending()) {
      return;
    }
    runProcessing('all');
    if (processing) {
      await processing;
    }
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
  deferredKeys.clear();
  recentlyHandled.clear();
  pendingListeners.length = 0;
  dropBurstCaches();
}

export default {
  destroy,
};

// test seam: the module keeps process-wide state
export function __resetForTest() {
  destroy();
  batchHandler = planBatch;
  processing = null;
}

// exported for tests
export const testHooks = {
  queueKey,
  isGitDriven,
  planSourceFor,
  wasRecentlyHandled,
  BATCH_INTERVAL,
  MAX_WAIT,
  RECENTLY_HANDLED_TTL,
};
