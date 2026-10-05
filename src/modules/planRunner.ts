import * as path from 'path';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import app from '../app';
import logger from '../logger';
import fsPromises from '../helper/fsPromises';
import { FileService, ServiceConfig, UResource, TransferDirection, FileSystem } from '../core';
import {
  ConnectionGate,
  isConnectionLostError,
  onConnectionRecovered,
} from '../core/connectionHealth';
import { getOpenTextDocuments, showWarningMessage } from '../host';
import { transfer } from '../fileHandlers/transfer/transfer';
import { handleCtxFromUri } from '../fileHandlers';
import { refreshRemoteExplorer } from '../fileHandlers/shared';
import { getFileService } from './serviceManager';
import { rememberSkipped, rememberAssumedUploaded } from './syncIndexFeeder';
import { holdSyncIndexSaves } from './syncIndex';
import {
  UploadPlan,
  UploadPlanItem,
  PlanItemStatus,
  PlanSummary,
  getPlan,
  updateItem,
  summarize,
  isUnchangedAgainstIndex,
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
 * - in a plan the user did not trigger (anything but `command`), a file that
 *   is open in the editor with unsaved changes is `skipped`: the transfer
 *   layer would save the document to upload it, and a startup scan must not
 *   write a hot-exit draft to disk and ship it;
 * - a file rewritten *during* its upload is `stale` and re-run once; if it
 *   changes again it stays `stale` for a later run;
 * - a plan built under another profile is not run against the active one (its
 *   items fail with a clear message) — the index would otherwise record the
 *   upload under the wrong destination;
 * - a **lost connection** is not a failure of the files: the item whose
 *   upload it interrupted and every item still queued go back to `pending`
 *   (with the reason in `error`), the plan stays open — which also keeps the
 *   automatic scans from planning the same files again on top of it — and it
 *   is resumed on its own when the connection is back (the connection gate
 *   reports the recovery) or, failing that, on a timer that follows the
 *   gate's hold, up to {@link MAX_AUTOMATIC_RESUMES} times; then it waits
 *   for the user. One warning per service and outage, not one per file;
 * - an item whose upload is the one the connection dies on
 *   {@link MAX_ITEM_INTERRUPTIONS} times running is `failed` instead of held
 *   once more: it is more likely the cause than a victim, and the plan goes
 *   on without it. An automatic resume only runs what is on hold, so that
 *   item waits for the user;
 * - `Cancel All Transfers` puts every item whose task did not finish — not
 *   only the ones that were running — back to `pending`, so the plan closes
 *   cleanly and can be run again;
 * - the remote parent directory of each item is ensured once per directory
 *   and per run, not once per file;
 * - {@link runPlan} always resolves with the summary; a second call for a plan
 *   already running waits for that run instead of starting another.
 *
 * Key lifecycle methods:
 * - {@link runPlan} runs (a subset of) a plan.
 * - {@link skipItem} takes an item out of a plan and remembers the skip in the
 *   sync index.
 * - {@link markAsUploaded} settles items as `assumed` — on the server
 *   already, by the user's word — and records them as verified in the index.
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

// a plan on hold after a lost connection is resumed on its own this many
// times (each following the connection gate's hold, so about ten minutes at
// the gate's ceiling); after that it stays pending until the user runs it,
// saves again, or the connection recovers on its own through another use
export const MAX_AUTOMATIC_RESUMES = 10;
// a resume never comes sooner than this after the loss, whatever the gate says
const MIN_RESUME_DELAY_MS = 5 * 1000;
// an item in flight when the connection goes is held with the rest; one that
// is in flight every time it goes (a file the server answers by dropping the
// session) would keep the whole plan from ever getting past it, so after this
// many interruptions without a clean run in between it fails instead
export const MAX_ITEM_INTERRUPTIONS = 3;

interface HeldPlan {
  planId: string;
  serviceName: string;
  host: string;
  gate: ConnectionGate | null;
  itemPaths?: string[];
  /** automatic resumes so far */
  resumes: number;
  timer?: NodeJS.Timer;
}

const running = new Map<string, Promise<PlanSummary>>();
const runningListeners: Array<() => void> = [];
const held = new Map<string, HeldPlan>();
// plan id -> path key -> uploads of that item interrupted by a lost
// connection since the plan last got through
const interruptions = new Map<string, Map<string, number>>();
// services already warned about the current outage; cleared when a plan of
// theirs gets through again
const outageNotified = new Set<string>();
let recoverySubscription: (() => void) | null = null;

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

function countInterruption(planId: string, localPath: string): number {
  let counts = interruptions.get(planId);
  if (!counts) {
    counts = new Map<string, number>();
    interruptions.set(planId, counts);
  }
  const count = (counts.get(pathKey(localPath)) || 0) + 1;
  counts.set(pathKey(localPath), count);
  return count;
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

// the same rule the scanner and the collector apply (size, mtime to the
// second): a file is "changed" for the runner iff it is for them
function differs(item: UploadPlanItem, stat: LocalStat): boolean {
  return !isUnchangedAgainstIndex(
    { size: item.localSize, mtime: item.localMtime },
    stat.size,
    stat.mtime
  );
}

/**
 * Whether `localPath` is open in the editor with unsaved changes. The transfer
 * layer saves such a document before uploading it ("save before upload"),
 * which is right for a command the user just ran and wrong for a plan that
 * runs on its own: a draft restored by hot exit at startup would be written to
 * disk and uploaded without anyone asking for it.
 */
function hasUnsavedChanges(localPath: string): boolean {
  let documents: ReturnType<typeof getOpenTextDocuments>;
  try {
    documents = getOpenTextDocuments();
  } catch (error) {
    // no editor host (tests, a headless run): nothing can be dirty
    return false;
  }
  if (!Array.isArray(documents)) {
    return false;
  }
  return documents.some(
    document =>
      Boolean(document) &&
      typeof document.fileName === 'string' &&
      samePath(document.fileName, localPath) &&
      !document.isClosed &&
      document.isDirty === true
  );
}

/**
 * The pre-flight check of a run: a missing file is skipped, a file that moved
 * on since the plan was built is refreshed (it was never uploaded, so it is not
 * stale), and — unless the user ran the plan as a command — a file with unsaved
 * changes in the editor is skipped rather than saved behind their back.
 * Returns the items that are still going.
 */
async function prepareItems(plan: UploadPlan, items: UploadPlanItem[]): Promise<UploadPlanItem[]> {
  const ready: UploadPlanItem[] = [];
  const automatic = plan.source !== 'command';
  for (const item of items) {
    if (automatic && hasUnsavedChanges(item.localPath)) {
      logger.info(
        `[plan ${plan.id}] ${item.localPath} skipped: unsaved changes in the editor`
      );
      updateItem(plan.id, item.localPath, {
        status: 'skipped',
        error: 'unsaved changes in the editor',
      });
      continue;
    }

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

// the connection went, not the files: they are due again, and the reason is
// kept on the item so the view says why they wait
function holdAll(plan: UploadPlan, items: UploadPlanItem[], error: any) {
  const message = `on hold: ${error && error.message ? error.message : String(error)}`;
  items.forEach(item => {
    if (item.status === 'uploading' || item.status === 'pending' || item.status === 'stale') {
      updateItem(plan.id, item.localPath, { status: 'pending', error: message });
    }
  });
}

interface GroupResult {
  verified: UploadPlanItem[];
  /** the connection was lost during this group; its items are on hold */
  connectionLost?: Error;
  /** where the hold can be read from, when the connection is known */
  gate?: ConnectionGate;
  host?: string;
}

/**
 * Uploads the items of one service through a single scheduler and writes the
 * result of every task back to its item. Resolves with the items that ended
 * `verified`, and with the connection loss that interrupted the group if
 * there was one.
 */
async function runGroup(plan: UploadPlan, group: ServiceGroup): Promise<GroupResult> {
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
    return { verified: [] };
  }

  if (fileService.getAvailableProfiles().length > 0 && plan.profile !== app.state.profile) {
    failAll(
      plan,
      items,
      `plan was built for profile "${plan.profile || ''}" but "${app.state.profile || ''}" is active`
    );
    return { verified: [] };
  }

  let gate: ConnectionGate | undefined;
  try {
    gate = fileService.getConnectionGate(config);
  } catch (_error) {
    gate = undefined;
  }
  const host = String(config.host || '');

  let remoteFs: FileSystem;
  try {
    remoteFs = await fileService.getRemoteFileSystem(config);
  } catch (error) {
    if (isConnectionLostError(error)) {
      holdAll(plan, items, error);
      return { verified: [], connectionLost: error, gate, host };
    }
    failAll(plan, items, error.message);
    return { verified: [] };
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
    uploadExclude: config.uploadExclude,
    verifyUpload: config.verifyUpload,
    retries: config.uploadRetries,
  };
  const resourceConfig = {
    localBasePath: fileService.baseDir,
    remoteBasePath: config.remotePath,
    remoteId: fileService.id,
    remote: { host: config.host, port: config.port },
  };

  // One ensureDir per distinct remote directory for the whole batch: a plan of
  // 400 files in a dozen folders used to cost 400 mkdir round trips (each a
  // failed mkdir plus an lstat over SFTP). The promise is cached, so the items
  // of one folder collected in parallel share the same call.
  const ensuredDirs = new Map<string, Promise<void>>();
  const ensureRemoteDir = (dir: string): Promise<void> => {
    let ensured = ensuredDirs.get(dir);
    if (!ensured) {
      ensured = remoteFs.ensureDir(dir).then(() => {
        if (!config.dirPerm) {
          return;
        }
        // what transferWithType does after creating the directory; non-fatal,
        // FTP servers commonly refuse SITE CHMOD
        return remoteFs
          .chmod(dir, parseInt(String(config.dirPerm), 8))
          .catch(error => logger.warn(`chmod ${dir} failed: ${error.message}`));
      });
      ensuredDirs.set(dir, ensured);
    }
    return ensured;
  };

  // the first loss of the connection while the tasks are collected (an
  // ensureDir, a stat of the target); the items behind it are not sent
  let lostWhileCollecting: Error | undefined;

  await mapWithConcurrency(items, COLLECT_CONCURRENCY, async item => {
    if (lostWhileCollecting) {
      holdAll(plan, [item], lostWhileCollecting);
      return;
    }
    try {
      // the collector and the scanner filter these out, but the config may
      // have changed since the plan was built; the item must say why it was
      // not sent rather than stay "uploading" or read as merely "ignored"
      if (config.uploadExclude && config.uploadExclude(item.localPath)) {
        updateItem(plan.id, item.localPath, {
          status: 'skipped',
          error: 'excluded from upload (uploadExclude)',
        });
        return;
      }

      // resolved against the live config: remotePath may have changed since
      // the plan was built, and the item shows where the file really went
      const target = UResource.from(Uri.file(item.localPath), resourceConfig);
      if (target.remoteFsPath !== item.remotePath) {
        updateItem(plan.id, item.localPath, { remotePath: target.remoteFsPath });
      }

      await ensureRemoteDir(remoteFs.pathResolver.dirname(target.remoteFsPath));

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
        },
        { ensureDirExist: false }
      );

      if (!collected) {
        // transfer() drops ignored paths silently; the item must not stay
        // "uploading" for ever
        updateItem(plan.id, item.localPath, { status: 'skipped', error: 'ignored by config' });
      }
    } catch (error) {
      if (isConnectionLostError(error)) {
        lostWhileCollecting = lostWhileCollecting || error;
        holdAll(plan, [item], error);
        return;
      }
      updateItem(plan.id, item.localPath, { status: 'failed', error: error.message });
    }
  });

  if (lostWhileCollecting) {
    // whatever was collected would fail the same way; it goes back to pending
    // with the rest (see the "uploading" sweep below)
    scheduler.stop();
  }

  const result = await scheduler.run();
  const connectionLost: Error | undefined = lostWhileCollecting || result.connectionLost;
  const verified: UploadPlanItem[] = [];
  // items whose task reported an outcome; whatever is still "uploading"
  // afterwards had no task run at all (see below)
  const settled = new Set<UploadPlanItem>();

  result.succeeded.forEach(task => {
    const item = itemsByTaskPath.get(pathKey(task.localFsPath));
    if (item) {
      settled.add(item);
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
      settled.add(item);
      if (isConnectionLostError(error)) {
        const interrupted = countInterruption(plan.id, item.localPath);
        if (interrupted >= MAX_ITEM_INTERRUPTIONS) {
          logger.warn(
            `[plan ${plan.id}] ${item.localPath} failed: the connection was lost ` +
              `${interrupted} times while uploading it; the plan goes on without it`
          );
          updateItem(plan.id, item.localPath, {
            status: 'failed',
            attempts: task.attempts,
            error:
              `connection lost ${interrupted} times while uploading this file: ` +
              (error.message || String(error)),
          });
          return;
        }
        // interrupted, not refused: due again once the connection is back
        updateItem(plan.id, item.localPath, {
          status: 'pending',
          attempts: task.attempts,
          error: `on hold: ${error.message || String(error)}`,
        });
        return;
      }
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
      settled.add(item);
      // the user's choice, not an outcome: the item is due again
      updateItem(plan.id, item.localPath, { status: 'pending', attempts: task.attempts });
    }
  });
  // `Cancel All Transfers` empties the queue without a task.done per queued
  // task (and a scheduler already stopped ignores add()), and so does a lost
  // connection: those items would otherwise stay "uploading" for ever, the
  // plan never closing and never runnable again. They never started, so
  // they are simply due again.
  items.forEach(item => {
    if (item.status === 'uploading' && !settled.has(item)) {
      updateItem(
        plan.id,
        item.localPath,
        connectionLost
          ? { status: 'pending', error: `on hold: ${connectionLost.message}` }
          : { status: 'pending' }
      );
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

  return { verified, connectionLost, gate, host };
}

interface ItemsResult {
  verified: UploadPlanItem[];
  /** the first connection loss met, when a group was interrupted by one */
  lost?: GroupResult;
}

/** One pass over `items`: pre-flight, then one scheduler per service. */
async function runItems(plan: UploadPlan, items: UploadPlanItem[]): Promise<ItemsResult> {
  const ready = await prepareItems(plan, items);
  if (ready.length === 0) {
    return { verified: [] };
  }

  const { groups, orphans } = groupByService(ready);
  failAll(plan, orphans, 'no configuration covers this path');

  const verified: UploadPlanItem[] = [];
  let lost: GroupResult | undefined;
  // services one after another: two schedulers on one connection would only
  // compete for it, and the status bar reads better
  for (const group of groups) {
    const done = await runGroup(plan, group);
    verified.push(...done.verified);
    if (done.connectionLost && !lost) {
      lost = done;
    }
  }
  return { verified, lost };
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
  // every verified file marks the index dirty; without this a long run had
  // the whole index serialised once a second for its entire duration
  const releaseIndexSaves = holdSyncIndexSaves();
  let lost: GroupResult | undefined;
  try {
    const first = await runItems(plan, selected);
    lost = first.lost;
    const stale = await markStale(plan, first.verified);
    if (stale.length > 0 && !lost) {
      logger.info(`[plan ${plan.id}] ${stale.length} file(s) changed during upload; uploading again`);
      const again = await runItems(plan, stale);
      lost = again.lost;
      // changed a second time: left stale for a later run rather than chasing
      // a file that is being rewritten continuously
      await markStale(plan, again.verified);
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
    releaseIndexSaves();
    app.sftpBarItem.stopSpinner();
  }

  const summary = summarize(plan);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info(
    `[plan ${plan.id}] ${summary.verified} verified, ${summary.failed} failed, ` +
      `${summary.skipped} skipped, ${summary.stale} stale` +
      (lost ? `, ${summary.pending + summary.stale} on hold` : '') +
      ` (${formatBytes(summary.bytes)}, ${seconds} s)`
  );

  if (lost) {
    holdPlan(plan, lost, options);
  } else {
    releaseHold(plan.id);
    outageNotified.delete(plan.serviceName);
  }
  return summary;
}

function releaseHold(planId: string) {
  const entry = held.get(planId);
  if (!entry) {
    return;
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  held.delete(planId);
  interruptions.delete(planId);
}

/**
 * Registers a plan interrupted by a lost connection: its items are pending
 * again, and it will be resumed when the gate reports the connection back
 * or, failing that, after the gate's current hold (never sooner than
 * {@link MIN_RESUME_DELAY_MS}), at most {@link MAX_AUTOMATIC_RESUMES} times.
 */
function holdPlan(plan: UploadPlan, lost: GroupResult, options: RunPlanOptions) {
  const waiting = plan.items.filter(item => item.status === 'pending' || item.status === 'stale');
  if (waiting.length === 0) {
    releaseHold(plan.id);
    return;
  }

  const previous = held.get(plan.id);
  if (previous && previous.timer) {
    clearTimeout(previous.timer);
  }
  const entry: HeldPlan = {
    planId: plan.id,
    serviceName: plan.serviceName,
    host: lost.host || '',
    gate: lost.gate || null,
    itemPaths: options.itemPaths,
    resumes: previous ? previous.resumes : 0,
  };
  held.set(plan.id, entry);
  ensureRecoverySubscription();

  const reason = lost.connectionLost ? lost.connectionLost.message : 'connection lost';
  logger.warn(`[plan ${plan.id}] ${waiting.length} file(s) on hold: ${reason}`);
  notifyOutage(entry, waiting.length, reason);

  if (entry.resumes >= MAX_AUTOMATIC_RESUMES) {
    logger.warn(
      `[plan ${plan.id}] not resumed automatically any more after ${entry.resumes} attempts; ` +
        'it stays in Upload plans until the connection is used again or the plan is run by hand'
    );
    return;
  }

  const delay = Math.max(MIN_RESUME_DELAY_MS, entry.gate ? entry.gate.retryAfter() : 0);
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    entry.resumes += 1;
    logger.info(`[plan ${plan.id}] resuming (${entry.resumes}/${MAX_AUTOMATIC_RESUMES})`);
    resumeHeld(entry);
  }, delay);
  if (typeof entry.timer.unref === 'function') {
    entry.timer.unref();
  }
}

function notifyOutage(entry: HeldPlan, count: number, reason: string) {
  if (outageNotified.has(entry.serviceName)) {
    return;
  }
  outageNotified.add(entry.serviceName);
  const where = entry.host ? ` to ${entry.host}` : '';
  showWarningMessage(
    `SFTP: connection${where} lost (${reason}). ${count} upload(s) of ${entry.serviceName} ` +
      'are on hold and will resume when it is back.'
  );
}

function resumeHeld(entry: HeldPlan) {
  const plan = getPlan(entry.planId);
  // only what is on hold: an item that failed meanwhile — the one that kept
  // interrupting the connection among them — waits for the user
  const waiting = plan
    ? selectItems(plan, entry.itemPaths).filter(item => item.status !== 'failed')
    : [];
  if (waiting.length === 0) {
    releaseHold(entry.planId);
    return;
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  runPlan(entry.planId, { itemPaths: waiting.map(item => item.localPath) }).catch(error =>
    logger.error(error, `plan ${entry.planId} resume`)
  );
}

function ensureRecoverySubscription() {
  if (recoverySubscription) {
    return;
  }
  recoverySubscription = onConnectionRecovered(gate => {
    Array.from(held.values())
      // a plan waits for its own connection; another host coming back says
      // nothing about it
      .filter(entry => entry.gate === null || entry.gate === gate)
      .forEach(entry => {
        logger.info(`[plan ${entry.planId}] connection to ${gate.label} is back; resuming`);
        resumeHeld(entry);
      });
  });
}

/** Plans interrupted by a lost connection and waiting for it to come back. */
export function getHeldPlanIds(): string[] {
  return Array.from(held.keys());
}

/**
 * Resumes every held plan now (or those of `planIds`), whatever the hold
 * says: a manual scan or a "run plan" from the view is the user asking.
 */
export function resumeHeldPlans(planIds?: string[]): Promise<void> {
  const entries = Array.from(held.values()).filter(
    entry => !planIds || planIds.indexOf(entry.planId) !== -1
  );
  return Promise.all(
    entries.map(entry =>
      runPlan(entry.planId, { itemPaths: entry.itemPaths }).then(
        () => undefined,
        error => logger.error(error, `plan ${entry.planId} resume`)
      )
    )
  ).then(() => undefined);
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

/**
 * Takes a pending, failed or stale item out of the plan, and remembers in the
 * sync index that this version was declined, so the next scan does not plan
 * it again until the file changes. The index write is best effort: it never
 * delays or fails the skip itself.
 */
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

  const service: FileService | undefined = getFileService(Uri.file(item.localPath));
  if (service) {
    rememberSkipped(service, [item]).catch(error =>
      logger.debug(`[plan ${planId}] cannot remember the skip of ${item.localPath}: ${error.message}`)
    );
  }
}

/**
 * Settles the pending, failed and stale items of a plan (or the subset named
 * in `itemPaths`) as `assumed`: the user says they are on the server already,
 * so nothing is uploaded and the sync index records each of them as verified
 * — flagged as assumed — with the size and mtime the plan measured. From
 * there on a scan only proposes them again once they change. Resolves with
 * the items it settled once the index write is done (best effort: a failure
 * there is logged, the plan is settled anyway).
 */
export async function markAsUploaded(
  planId: string,
  itemPaths?: string[]
): Promise<UploadPlanItem[]> {
  const plan = getPlan(planId);
  if (!plan) {
    return [];
  }
  const items = selectItems(plan, itemPaths);
  if (items.length === 0) {
    return [];
  }

  items.forEach(item => updateItem(planId, item.localPath, { status: 'assumed', error: undefined }));
  logger.info(`[plan ${planId}] ${items.length} item(s) marked as uploaded by the user`);

  // one service per plan: every item of a plan belongs to the service that
  // built it, so the first item's owner is the index to write
  const service: FileService | undefined = getFileService(Uri.file(items[0].localPath));
  if (service) {
    await rememberAssumedUploaded(service, items);
  } else {
    logger.debug(`[plan ${planId}] no service owns ${items[0].localPath}; the index was not updated`);
  }
  return items;
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
  held.forEach(entry => {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
  });
  held.clear();
  interruptions.clear();
  outageNotified.clear();
  if (recoverySubscription) {
    recoverySubscription();
    recoverySubscription = null;
  }
}
