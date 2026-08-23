import * as path from 'path';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import app from '../app';
import logger from '../logger';
import fsPromises from '../helper/fsPromises';
import { FileService, ServiceConfig, UResource, TransferDirection, FileSystem } from '../core';
import { transfer } from '../fileHandlers/transfer/transfer';
import { handleCtxFromUri } from '../fileHandlers';
import { refreshRemoteExplorer } from '../fileHandlers/shared';
import { getFileService } from './serviceManager';
import {
  UploadPlan,
  UploadPlanItem,
  PlanItemStatus,
  PlanSummary,
  getPlan,
  updateItem,
  summarize,
} from './uploadPlan';

/**
 * Executes an upload plan: the items of a plan become transfer tasks, run
 * through one scheduler per service, and their outcome is written back to the
 * plan item by item (`verified`, `failed`, `skipped`, `stale`).
 *
 * It is the execution engine behind the change collector, the external-change
 * scanner and the actions of the Activity view ("Upload all", "Retry failed",
 * per-item upload). Going through one scheduler per service rather than one
 * `uploadFile()` per item is what keeps a 400-file batch at the configured
 * concurrency instead of 400 concurrent transfers — and, over FTP, at the one
 * connection the protocol allows.
 *
 * Rules:
 * - only `pending`, `stale` and `failed` items run; the caller may narrow the
 *   selection with {@link RunPlanOptions.itemPaths};
 * - a file that vanished locally is `skipped`, one whose size or mtime moved
 *   before the upload just gets its item refreshed (it had not been sent yet);
 * - a file rewritten *during* its upload is `stale` and re-run once; if it
 *   changes again it stays `stale` for a later run;
 * - a plan built under another profile is not run against the active one (its
 *   items fail with a clear message) — the index would otherwise record the
 *   upload under the wrong destination;
 * - {@link runPlan} always resolves with the summary; a second call for a plan
 *   already running waits for that run instead of starting another.
 *
 * Key lifecycle methods:
 * - {@link runPlan} runs (a subset of) a plan.
 * - {@link skipItem} takes an item out of a plan.
 * - {@link isPlanRunning} / {@link onDidChangeRunning} expose the running state
 *   to the view.
 * - {@link whenIdle} resolves once no plan is running (deactivate waits on it).
 */

export interface RunPlanOptions {
  /** local paths to run; by default every pending, stale or failed item */
  itemPaths?: string[];
}

// statuses a run picks up; everything else was settled by an earlier run or
// by the user
const RUNNABLE: PlanItemStatus[] = ['pending', 'stale', 'failed'];

// remote directories are ensured while the tasks are collected, one round trip
// per item; a few in flight at once keeps a big plan from serialising on that
// without flooding the connection
const COLLECT_CONCURRENCY = 4;

// windows and macOS default to case-insensitive filesystems, so a task's path
// must find its item whatever casing either side reports
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

const running = new Map<string, Promise<PlanSummary>>();
const runningListeners: Array<() => void> = [];

function pathKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return CASE_INSENSITIVE_FS ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function notifyRunning() {
  runningListeners.forEach(listener => {
    try {
      listener();
    } catch (error) {
      logger.error(error, 'planRunner listener');
    }
  });
}

function selectItems(plan: UploadPlan, itemPaths?: string[]): UploadPlanItem[] {
  return plan.items.filter(item => {
    if (RUNNABLE.indexOf(item.status) === -1) {
      return false;
    }
    return !itemPaths || itemPaths.some(candidate => samePath(candidate, item.localPath));
  });
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

interface LocalStat {
  size: number;
  mtime: number;
}

async function statLocal(fsPath: string): Promise<LocalStat | null> {
  try {
    const stat = await fsPromises.lstat(fsPath);
    return { size: stat.size, mtime: stat.mtime.getTime() };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function differs(item: UploadPlanItem, stat: LocalStat): boolean {
  return item.localSize !== stat.size || item.localMtime !== stat.mtime;
}

/**
 * The pre-flight check of a run: a missing file is skipped, a file that moved
 * on since the plan was built is refreshed (it was never uploaded, so it is not
 * stale). Returns the items that are still going.
 */
async function prepareItems(plan: UploadPlan, items: UploadPlanItem[]): Promise<UploadPlanItem[]> {
  const ready: UploadPlanItem[] = [];
  for (const item of items) {
    let stat: LocalStat | null;
    try {
      stat = await statLocal(item.localPath);
    } catch (error) {
      updateItem(plan.id, item.localPath, { status: 'failed', error: error.message });
      continue;
    }

    if (!stat) {
      updateItem(plan.id, item.localPath, { status: 'skipped', error: 'missing locally' });
      continue;
    }

    const patch: Partial<UploadPlanItem> = { status: 'uploading', error: undefined };
    if (differs(item, stat)) {
      patch.localSize = stat.size;
      patch.localMtime = stat.mtime;
    }
    updateItem(plan.id, item.localPath, patch);
    ready.push(item);
  }
  return ready;
}

interface ServiceGroup {
  service: FileService;
  items: UploadPlanItem[];
}

function groupByService(items: UploadPlanItem[]): { groups: ServiceGroup[]; orphans: UploadPlanItem[] } {
  const groups = new Map<string, ServiceGroup>();
  const orphans: UploadPlanItem[] = [];
  items.forEach(item => {
    // the registry lookup only; the config (validation, a log line) is
    // resolved once per group by runGroup
    const service: FileService | undefined = getFileService(Uri.file(item.localPath));
    if (!service) {
      orphans.push(item);
      return;
    }
    const group = groups.get(service.baseDir);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(service.baseDir, { service, items: [item] });
    }
  });
  return { groups: Array.from(groups.values()), orphans };
}

function failAll(plan: UploadPlan, items: UploadPlanItem[], message: string) {
  items.forEach(item => updateItem(plan.id, item.localPath, { status: 'failed', error: message }));
}

/**
 * Uploads the items of one service through a single scheduler and writes the
 * result of every task back to its item. Resolves with the items that ended
 * `verified`.
 */
async function runGroup(plan: UploadPlan, group: ServiceGroup): Promise<UploadPlanItem[]> {
  const { items } = group;
  let fileService: FileService;
  let config: ServiceConfig;
  try {
    // the same resolution every file command uses (service, validated config
    // of the active profile), so a plan and a command agree on the destination
    const ctx = handleCtxFromUri(Uri.file(items[0].localPath));
    fileService = ctx.fileService;
    config = ctx.config;
  } catch (error) {
    failAll(plan, items, error.message);
    return [];
  }

  if (fileService.getAvailableProfiles().length > 0 && plan.profile !== app.state.profile) {
    failAll(
      plan,
      items,
      `plan was built for profile "${plan.profile || ''}" but "${app.state.profile || ''}" is active`
    );
    return [];
  }

  let remoteFs: FileSystem;
  try {
    remoteFs = await fileService.getRemoteFileSystem(config);
  } catch (error) {
    failAll(plan, items, error.message);
    return [];
  }

  const localFs = fileService.getLocalFileSystem();
  const scheduler = fileService.createTransferScheduler(config.concurrency);
  const itemsByTaskPath = new Map<string, UploadPlanItem>();
  // the same options uploadFile() derives from the config, so a plan upload
  // and a command upload of the same file behave identically
  const transferOption = {
    perserveTargetMode: config.protocol === 'sftp' && !config.filePerm,
    useTempFile: config.useTempFile,
    openSsh: config.openSsh,
    ignore: config.ignore,
    verifyUpload: config.verifyUpload,
    retries: config.uploadRetries,
  };
  const resourceConfig = {
    localBasePath: fileService.baseDir,
    remoteBasePath: config.remotePath,
    remoteId: fileService.id,
    remote: { host: config.host, port: config.port },
  };

  await mapWithConcurrency(items, COLLECT_CONCURRENCY, async item => {
    try {
      // resolved against the live config: remotePath may have changed since
      // the plan was built, and the item shows where the file really went
      const target = UResource.from(Uri.file(item.localPath), resourceConfig);
      if (target.remoteFsPath !== item.remotePath) {
        updateItem(plan.id, item.localPath, { remotePath: target.remoteFsPath });
      }

      let collected = false;
      await transfer(
        {
          srcFsPath: item.localPath,
          srcFs: localFs,
          targetFsPath: target.remoteFsPath,
          targetFs: remoteFs,
          transferOption,
          filePerm: config.filePerm,
          dirPerm: config.dirPerm,
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        },
        task => {
          collected = true;
          scheduler.add(task);
          itemsByTaskPath.set(pathKey(task.localFsPath), item);
        }
      );

      if (!collected) {
        // transfer() drops ignored paths silently; the item must not stay
        // "uploading" for ever
        updateItem(plan.id, item.localPath, { status: 'skipped', error: 'ignored by config' });
      }
    } catch (error) {
      updateItem(plan.id, item.localPath, { status: 'failed', error: error.message });
    }
  });

  const result = await scheduler.run();
  const verified: UploadPlanItem[] = [];

  result.succeeded.forEach(task => {
    const item = itemsByTaskPath.get(pathKey(task.localFsPath));
    if (item) {
      updateItem(plan.id, item.localPath, {
        status: 'verified',
        attempts: task.attempts,
        error: undefined,
      });
      verified.push(item);
    }
  });
  result.failed.forEach(({ task, error }) => {
    const item = itemsByTaskPath.get(pathKey(task.localFsPath));
    if (item) {
      updateItem(plan.id, item.localPath, {
        status: 'failed',
        attempts: task.attempts,
        error: error.message || String(error),
      });
    }
  });
  result.cancelled.forEach(task => {
    const item = itemsByTaskPath.get(pathKey(task.localFsPath));
    if (item) {
      // the user's choice, not an outcome: the item is due again
      updateItem(plan.id, item.localPath, { status: 'pending', attempts: task.attempts });
    }
  });

  if (result.succeeded.length > 0) {
    // the whole service root, as uploadFolder does for a folder: a plan can
    // touch any number of directories
    try {
      await refreshRemoteExplorer(UResource.from(Uri.file(fileService.baseDir), resourceConfig), true);
    } catch (error) {
      logger.debug(`[plan ${plan.id}] explorer refresh skipped: ${error.message}`);
    }
  }

  return verified;
}

/** One pass over `items`: pre-flight, then one scheduler per service. */
async function runItems(plan: UploadPlan, items: UploadPlanItem[]): Promise<UploadPlanItem[]> {
  const ready = await prepareItems(plan, items);
  if (ready.length === 0) {
    return [];
  }

  const { groups, orphans } = groupByService(ready);
  failAll(plan, orphans, 'no configuration covers this path');

  const verified: UploadPlanItem[] = [];
  // services one after another: two schedulers on one connection would only
  // compete for it, and the status bar reads better
  for (const group of groups) {
    const done = await runGroup(plan, group);
    verified.push(...done);
  }
  return verified;
}

/**
 * Items whose file changed while it was being uploaded. The verified upload is
 * of the old content, so the item is `stale`, refreshed with the new stat, and
 * due again.
 */
async function markStale(plan: UploadPlan, verified: UploadPlanItem[]): Promise<UploadPlanItem[]> {
  const stale: UploadPlanItem[] = [];
  for (const item of verified) {
    let stat: LocalStat | null;
    try {
      stat = await statLocal(item.localPath);
    } catch (error) {
      continue;
    }
    // deleted since: the delete monitor mirrors that, the upload itself was fine
    if (!stat || !differs(item, stat)) {
      continue;
    }
    updateItem(plan.id, item.localPath, {
      status: 'stale',
      localSize: stat.size,
      localMtime: stat.mtime,
      error: 'changed during upload',
    });
    stale.push(item);
  }
  return stale;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

async function execute(plan: UploadPlan, options: RunPlanOptions): Promise<PlanSummary> {
  const selected = selectItems(plan, options.itemPaths);
  if (selected.length === 0) {
    return summarize(plan);
  }

  const startedAt = Date.now();
  logger.info(`[plan ${plan.id}] uploading ${selected.length} file(s) to ${plan.serviceName}`);
  app.sftpBarItem.startSpinner();
  try {
    const verified = await runItems(plan, selected);
    const stale = await markStale(plan, verified);
    if (stale.length > 0) {
      logger.info(`[plan ${plan.id}] ${stale.length} file(s) changed during upload; uploading again`);
      const verifiedAgain = await runItems(plan, stale);
      // changed a second time: left stale for a later run rather than chasing
      // a file that is being rewritten continuously
      await markStale(plan, verifiedAgain);
    }
  } catch (error) {
    // a bug, not an item failure; the items still in flight are closed so the
    // plan does not stay open for ever
    logger.error(error, `plan ${plan.id}`);
    plan.items
      .filter(item => item.status === 'uploading')
      .forEach(item =>
        updateItem(plan.id, item.localPath, { status: 'failed', error: error.message })
      );
  } finally {
    app.sftpBarItem.stopSpinner();
  }

  const summary = summarize(plan);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info(
    `[plan ${plan.id}] ${summary.verified} verified, ${summary.failed} failed, ` +
      `${summary.skipped} skipped, ${summary.stale} stale ` +
      `(${formatBytes(summary.bytes)}, ${seconds} s)`
  );
  return summary;
}

/**
 * Runs the pending, stale and failed items of a plan (or the subset named in
 * `options.itemPaths`) and resolves with the plan's summary. Item failures are
 * recorded in the plan, never thrown; only an unknown plan id rejects. A call
 * for a plan that is already running returns that run's promise.
 */
export function runPlan(planId: string, options: RunPlanOptions = {}): Promise<PlanSummary> {
  const plan = getPlan(planId);
  if (!plan) {
    return Promise.reject(new Error(`Upload plan "${planId}" not found`));
  }

  const inFlight = running.get(planId);
  if (inFlight) {
    return inFlight;
  }

  const finish = () => {
    running.delete(planId);
    notifyRunning();
  };
  const run = execute(plan, options).then(
    summary => {
      finish();
      return summary;
    },
    error => {
      finish();
      throw error;
    }
  );
  running.set(planId, run);
  notifyRunning();
  return run;
}

/** Takes a pending, failed or stale item out of the plan. */
export function skipItem(planId: string, localPath: string): void {
  const plan = getPlan(planId);
  if (!plan) {
    return;
  }
  const item = plan.items.find(candidate => samePath(candidate.localPath, localPath));
  if (!item || RUNNABLE.indexOf(item.status) === -1) {
    return;
  }
  updateItem(planId, localPath, { status: 'skipped', error: 'skipped by user' });
}

export function isPlanRunning(planId: string): boolean {
  return running.has(planId);
}

export function onDidChangeRunning(listener: () => void): vscode.Disposable {
  runningListeners.push(listener);
  return {
    dispose() {
      const index = runningListeners.indexOf(listener);
      if (index !== -1) {
        runningListeners.splice(index, 1);
      }
    },
  };
}

/** Resolves once no plan is running, including runs started while waiting. */
export async function whenIdle(): Promise<void> {
  while (running.size > 0) {
    await Promise.all(Array.from(running.values()).map(run => run.catch(() => undefined)));
  }
}

// test seam: the module keeps process-wide state
export function __resetForTest() {
  running.clear();
  runningListeners.length = 0;
}
