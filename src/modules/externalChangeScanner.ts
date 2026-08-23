import * as vscode from 'vscode';
import app from '../app';
import logger from '../logger';
import { FileService, ServiceConfig, FileSystem, FileEntry, FileType, upath } from '../core';
import { resolveExternalChangesConfig, resolvePollInterval } from '../core/fileService';
import { toRemotePath } from '../helper';
import { showInformationMessage, withProgress } from '../host';
import { getAllFileService } from './serviceManager';
import { isPaused, onDidChangePauseState } from './syncControl';
import { indexFor } from './syncIndexFeeder';
import { IndexEntry, toRelPath } from './syncIndex';
import { scanLocalTree } from './localScanner';
import { isInsideTrash } from './remoteTrash';
import {
  UploadPlan,
  PlanSummary,
  createPlan,
  diffAgainstIndex,
  getPlans,
  updateItem,
} from './uploadPlan';
import { confirmAndRunPlan, PlanDecision } from './planConfirmation';

/**
 * Reconciliation by scan: finds local files that changed since their last
 * verified upload and turns them into an upload plan.
 *
 * Watchers only see what happens while the window is open. Everything else —
 * an edit in another editor while VS Code was closed, a `git pull` in a
 * terminal, a build that ran overnight — is caught here, by walking the local
 * tree and comparing size and mtime against the sync index. A scan runs at
 * activation, when sftp.json is reloaded, when automatic sync is resumed, when
 * the window regains focus after a while, on demand (`SFTP: Scan for External
 * Changes`) and, for environments without reliable filesystem events, on a
 * timer (`watcher.pollInterval`). The result goes through the same
 * confirmation threshold as the watcher's batches; nothing is uploaded behind
 * the user's back.
 *
 * An empty index is the one case a scan cannot reason about: every file would
 * look new. The first time that happens for a service the user is offered
 * `SFTP: Rebuild Sync Index` ({@link rebuildSyncIndex}), which lists both
 * sides and records as verified every file that already matches.
 *
 * Key lifecycle methods:
 * - {@link init} installs the triggers; {@link destroy} removes them.
 * - {@link scanService} / {@link scanAll} run a scan for one or every service.
 * - {@link rebuildSyncIndex} seeds the index from the server.
 */

export type ScanTrigger = 'startup' | 'resume' | 'focus' | 'manual' | 'poll' | 'config';

export type ScanStatus =
  | 'planned'
  | 'up-to-date'
  | 'empty-index'
  | 'skipped'
  | 'cancelled'
  | 'error';

export interface ScanOutcome {
  status: ScanStatus;
  plan: UploadPlan | null;
  /** what the confirmation decided, when a plan was built */
  decision?: PlanDecision;
  /** the plan's summary when the scan returned */
  summary?: PlanSummary;
  filesScanned: number;
  /** why nothing was planned, for `skipped` and `error` */
  reason?: string;
}

export interface ScanOptions {
  /** polled between directories and before the upload; cooperative */
  isCancelled?: () => boolean;
  onProgress?: (scannedFiles: number, scannedDirs: number) => void;
  /** coarse phase messages for a progress notification */
  onStatus?: (message: string) => void;
}

export interface RebuildProgress {
  localFiles: number;
  remoteFiles: number;
}

export interface RebuildSummary {
  /** files present on both sides with the same size (and mtime, where reliable) */
  indexed: number;
  /** files present on both sides but different; left out, so the next scan plans them */
  differ: number;
  onlyLocal: number;
  onlyRemote: number;
  cancelled: boolean;
}

export interface RebuildOptions {
  isCancelled?: () => boolean;
  onProgress?: (progress: RebuildProgress) => void;
}

// a focus regained less than this after the last scan of a service is not a
// reason to scan again
const FOCUS_MIN_INTERVAL_MS = 5 * 60 * 1000;

// how often the poll timer checks whether a service is due
const POLL_TICK_MS = 1000;

// remote directories listed in parallel while rebuilding the index (FTP
// serialises them anyway)
const REMOTE_WALK_CONCURRENCY = 4;

// the remote side reports mtime in whole seconds and some servers round
const MTIME_TOLERANCE_IN_SECONDS = 2;

const BUILD_INDEX_LABEL = 'Build index now';
const LATER_LABEL = 'Later';

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

let destroyed = false;
let pollTimer: any = null;
let wasPaused = false;
const subscriptions: vscode.Disposable[] = [];

// one scan per service at a time; a second request joins the one in flight
const scans = new Map<string, Promise<ScanOutcome>>();
const lastScanAt = new Map<string, number>();
const lastPollAt = new Map<string, number>();
// services told once, this session, that their index is empty
const emptyIndexNotified = new Set<string>();

function foldRel(relPath: string): string {
  return CASE_INSENSITIVE_FS ? relPath.toLowerCase() : relPath;
}

function nameOf(service: FileService): string {
  return service.name || service.baseDir;
}

function isTriggerEnabled(config: ServiceConfig, trigger: ScanTrigger): boolean {
  const external = resolveExternalChangesConfig(config);
  switch (trigger) {
    case 'startup':
    case 'config':
      return external.scanOnStartup;
    case 'resume':
    case 'focus':
      return external.scanOnResume;
    case 'poll':
      return resolvePollInterval(config) > 0;
    default:
      return true;
  }
}

function isScanPlan(plan: UploadPlan): boolean {
  return plan.source === 'scan' || plan.source === 'poll';
}

function openScanPlans(serviceName: string): UploadPlan[] {
  return getPlans().filter(
    plan => plan.serviceName === serviceName && isScanPlan(plan) && plan.finishedAt === undefined
  );
}

/**
 * A manual scan replaces whatever an earlier scan left pending: two plans for
 * the same files would only confuse, and the new one is the current truth.
 */
function supersedeOpenScanPlans(serviceName: string) {
  openScanPlans(serviceName).forEach(plan => {
    plan.items.forEach(item => {
      if (item.status === 'pending') {
        updateItem(plan.id, item.localPath, {
          status: 'skipped',
          error: 'superseded by a newer scan',
        });
      }
    });
  });
}

function notifyEmptyIndex(service: FileService) {
  const name = nameOf(service);
  logger.info(
    `[scan] ${name}: the sync index is empty, external changes can't be detected yet ` +
      '(run "SFTP: Rebuild Sync Index")'
  );
  if (emptyIndexNotified.has(service.baseDir)) {
    return;
  }
  emptyIndexNotified.add(service.baseDir);

  Promise.resolve(
    showInformationMessage(
      `SFTP: the sync index for ${name} is empty, so external changes can't be detected yet.`,
      BUILD_INDEX_LABEL,
      LATER_LABEL
    )
  ).then(
    choice => {
      if (choice === BUILD_INDEX_LABEL) {
        rebuildSyncIndexInteractive(service).catch(error =>
          logger.error(error, `rebuild sync index of ${name}`)
        );
      }
    },
    error => logger.debug(`[scan] empty-index prompt failed: ${error.message}`)
  );
}

async function doScan(
  service: FileService,
  config: ServiceConfig,
  trigger: ScanTrigger,
  options: ScanOptions
): Promise<ScanOutcome> {
  const name = nameOf(service);
  const isCancelled = () => destroyed || (options.isCancelled ? options.isCancelled() : false);
  const status = (message: string) => {
    if (options.onStatus) {
      options.onStatus(message);
    }
  };

  const index = await indexFor(service, config);
  if (index.size === 0 && trigger !== 'manual') {
    notifyEmptyIndex(service);
    return { status: 'empty-index', plan: null, filesScanned: 0 };
  }

  app.sftpBarItem.showMsg(`scanning ${name}…`, `SFTP: scanning ${name} for external changes`);
  status('scanning…');
  const scan = await scanLocalTree(service.baseDir, {
    ignore: config.ignore,
    isCancelled,
    onProgress: (files, dirs) => {
      status(`${files} file(s) scanned`);
      if (options.onProgress) {
        options.onProgress(files, dirs);
      }
    },
  });

  if (scan.cancelled) {
    logger.info(`[scan] ${name}: cancelled after ${scan.files.length} files`);
    app.sftpBarItem.showMsg(`scan of ${name} cancelled`, 2000);
    return { status: 'cancelled', plan: null, filesScanned: scan.files.length };
  }

  const diff = diffAgainstIndex({
    baseDir: service.baseDir,
    scanned: scan.files,
    index,
    // the same mapping every file command uses for a local uri
    toRemotePath: localPath => toRemotePath(localPath, service.baseDir, config.remotePath),
  });

  if (diff.items.length === 0) {
    logger.info(
      `[scan] ${name}: up to date (${scan.files.length} files, ${scan.durationMs} ms` +
        (diff.missingLocally.length > 0
          ? `, ${diff.missingLocally.length} indexed file(s) no longer exist locally)`
          : ')')
    );
    app.sftpBarItem.showMsg(`${name} up to date`, 2000);
    return { status: 'up-to-date', plan: null, filesScanned: scan.files.length };
  }

  logger.info(
    `[scan] ${name}: ${diff.items.length} file(s) changed since their last verified upload ` +
      `(${diff.unchanged} unchanged, ${scan.durationMs} ms, trigger ${trigger})`
  );
  app.sftpBarItem.showMsg(`${name}: ${diff.items.length} changed file(s)`, 2000);

  const plan = createPlan({
    serviceName: service.name,
    profile: app.state.profile,
    source: trigger === 'poll' ? 'poll' : 'scan',
    items: diff.items,
  });

  status(`uploading ${plan.items.length} file(s)…`);
  const outcome = await confirmAndRunPlan(plan, {
    serviceName: service.name,
    host: config.host,
    confirmThreshold: resolveExternalChangesConfig(config).confirmThreshold,
  });

  return {
    status: 'planned',
    plan,
    decision: outcome.decision,
    summary: outcome.summary,
    filesScanned: scan.files.length,
  };
}

/**
 * Scans one service and reports what happened. Automatic triggers respect the
 * `externalChanges` flags, the pause, and an earlier scan plan that is still
 * pending review; a manual scan supersedes such a plan instead. A scan already
 * running for the service is joined, not duplicated.
 */
export function runScan(
  service: FileService,
  trigger: ScanTrigger,
  options: ScanOptions = {}
): Promise<ScanOutcome> {
  const inFlight = scans.get(service.baseDir);
  if (inFlight) {
    return inFlight;
  }

  const name = nameOf(service);
  let config: ServiceConfig;
  try {
    config = service.getConfig();
  } catch (error) {
    logger.debug(`[scan] ${name} skipped: ${error.message}`);
    return Promise.resolve({ status: 'error', plan: null, filesScanned: 0, reason: error.message });
  }

  const skipped = (reason: string): Promise<ScanOutcome> => {
    logger.debug(`[scan] ${name} (${trigger}) skipped: ${reason}`);
    return Promise.resolve({ status: 'skipped', plan: null, filesScanned: 0, reason });
  };

  if (trigger !== 'manual') {
    if (!isTriggerEnabled(config, trigger)) {
      return skipped('disabled by externalChanges / watcher.pollInterval');
    }
    if (isPaused()) {
      return skipped('automatic sync is paused');
    }
    if (openScanPlans(service.name).length > 0) {
      return skipped('a previous scan is still pending review');
    }
  } else {
    supersedeOpenScanPlans(service.name);
  }

  const run = doScan(service, config, trigger, options).then(
    outcome => {
      scans.delete(service.baseDir);
      lastScanAt.set(service.baseDir, Date.now());
      return outcome;
    },
    error => {
      scans.delete(service.baseDir);
      lastScanAt.set(service.baseDir, Date.now());
      throw error;
    }
  );
  scans.set(service.baseDir, run);
  return run;
}

/** The plan a scan produced, or null when there was nothing to plan. */
export async function scanService(
  service: FileService,
  trigger: ScanTrigger
): Promise<UploadPlan | null> {
  const outcome = await runScan(service, trigger);
  return outcome.plan;
}

/** Scans every service, one after another so confirmations never stack. */
export async function scanAll(trigger: ScanTrigger): Promise<void> {
  for (const service of getAllFileService()) {
    if (destroyed) {
      return;
    }
    try {
      await runScan(service, trigger);
    } catch (error) {
      logger.error(error, `[scan] ${nameOf(service)}`);
    }
  }
}

interface RemoteWalkOptions {
  ignore: ((fsPath: string) => boolean) | null | undefined;
  skipDir: (remotePath: string) => boolean;
  isCancelled: () => boolean;
  onFile: (entry: FileEntry) => void;
}

/**
 * Lists the remote tree under `root`, pruning ignored and trash directories,
 * with a bounded number of listings in flight. A directory that fails to list
 * is logged and skipped: one unreadable folder must not abort the rebuild.
 */
async function walkRemote(remoteFs: FileSystem, root: string, options: RemoteWalkOptions) {
  const pendingDirs: string[] = [root];
  let cancelled = false;

  const readDir = async (dir: string) => {
    let entries: FileEntry[];
    try {
      entries = await remoteFs.list(dir);
    } catch (error) {
      logger.warn(`[rebuild-index] cannot list ${dir}: ${error.message}`);
      return;
    }
    entries.forEach(entry => {
      if (options.ignore && options.ignore(entry.fspath)) {
        return;
      }
      if (entry.type === FileType.Directory) {
        if (!options.skipDir(entry.fspath)) {
          pendingDirs.push(entry.fspath);
        }
      } else if (entry.type === FileType.File) {
        options.onFile(entry);
      }
      // symlinks are neither scanned locally nor verified; nothing to match
    });
  };

  await new Promise<void>(resolve => {
    let active = 0;
    const pump = () => {
      if (!cancelled && options.isCancelled()) {
        cancelled = true;
      }
      while (!cancelled && active < REMOTE_WALK_CONCURRENCY && pendingDirs.length > 0) {
        const dir = pendingDirs.pop()!;
        active++;
        readDir(dir).then(
          () => {
            active--;
            pump();
          },
          error => {
            logger.error(error, `[rebuild-index] ${dir}`);
            active--;
            pump();
          }
        );
      }
      if (active === 0 && (cancelled || pendingDirs.length === 0)) {
        resolve();
      }
    };
    pump();
  });

  return cancelled;
}

function sameMtime(localMs: number, remoteMs: number): boolean {
  return (
    Math.abs(Math.floor(localMs / 1000) - Math.floor(remoteMs / 1000)) <= MTIME_TOLERANCE_IN_SECONDS
  );
}

/**
 * Seeds the index from what is already on the server: every file present on
 * both sides with the same size (and, where the remote mtime is reliable, the
 * same mtime within tolerance) is recorded as verified. Files that differ or
 * exist on one side only are left out, so the next scan plans them. The old
 * index is replaced only once the rebuild completes; a cancelled rebuild
 * leaves it untouched.
 */
export async function rebuildSyncIndex(
  service: FileService,
  options: RebuildOptions = {}
): Promise<RebuildSummary> {
  const name = nameOf(service);
  const config = service.getConfig();
  const isCancelled = () => destroyed || (options.isCancelled ? options.isCancelled() : false);
  const index = await indexFor(service, config);
  const remoteFs = await service.getRemoteFileSystem(config);

  let remoteFiles = 0;
  let localFiles = 0;
  const report = () => {
    if (options.onProgress) {
      options.onProgress({ localFiles, remoteFiles });
    }
  };

  const skipDir = (remotePath: string) => {
    try {
      return isInsideTrash(remotePath, config);
    } catch (error) {
      // an unsafe trash config is reported by the deletion paths; here it
      // only means "nothing to skip"
      return false;
    }
  };

  const remote = new Map<string, FileEntry>();
  logger.info(`[rebuild-index] ${name}: listing ${config.remotePath}`);
  const remoteCancelled = await walkRemote(remoteFs, config.remotePath, {
    ignore: config.ignore,
    skipDir,
    isCancelled,
    onFile: entry => {
      remote.set(foldRel(upath.relative(config.remotePath, entry.fspath)), entry);
      remoteFiles++;
      report();
    },
  });
  if (remoteCancelled) {
    return { indexed: 0, differ: 0, onlyLocal: 0, onlyRemote: 0, cancelled: true };
  }

  const local = await scanLocalTree(service.baseDir, {
    ignore: config.ignore,
    isCancelled,
    onProgress: files => {
      localFiles = files;
      report();
    },
  });
  if (local.cancelled) {
    return { indexed: 0, differ: 0, onlyLocal: 0, onlyRemote: 0, cancelled: true };
  }

  // FTP listings carry minute-level mtimes and ignore futimes; size alone is
  // the honest comparison there
  const mtimeReliable = config.protocol !== 'ftp';
  const now = Date.now();
  const entries: Array<[string, IndexEntry]> = [];
  let differ = 0;
  let onlyLocal = 0;

  local.files.forEach(file => {
    const relPath = toRelPath(service.baseDir, file.fsPath);
    const key = foldRel(relPath);
    const remoteEntry = remote.get(key);
    if (!remoteEntry) {
      onlyLocal++;
      return;
    }
    remote.delete(key);

    if (remoteEntry.size === file.size && (!mtimeReliable || sameMtime(file.mtime, remoteEntry.mtime))) {
      entries.push([
        relPath,
        {
          size: file.size,
          mtime: file.mtime,
          verifiedAt: now,
          remoteSize: remoteEntry.size,
          remoteMtime: remoteEntry.mtime,
          status: 'verified',
        },
      ]);
    } else {
      differ++;
    }
  });

  index.clear();
  entries.forEach(([relPath, entry]) => index.set(relPath, entry));
  await index.save();

  const summary: RebuildSummary = {
    indexed: entries.length,
    differ,
    onlyLocal,
    onlyRemote: remote.size,
    cancelled: false,
  };
  logger.info(
    `[rebuild-index] ${name}: ${summary.indexed} indexed, ${summary.differ} differ, ` +
      `${summary.onlyLocal} only local, ${summary.onlyRemote} only remote`
  );
  return summary;
}

export function formatRebuildSummary(summary: RebuildSummary): string {
  if (summary.cancelled) {
    return 'Sync index rebuild cancelled; the index was left as it was.';
  }
  const parts = [`${summary.differ.toLocaleString()} differ`];
  if (summary.onlyLocal > 0) {
    parts.push(`${summary.onlyLocal.toLocaleString()} only local`);
  }
  if (summary.onlyRemote > 0) {
    parts.push(`${summary.onlyRemote.toLocaleString()} only remote`);
  }
  return `Indexed ${summary.indexed.toLocaleString()} files; ${parts.join(', ')}.`;
}

/**
 * {@link rebuildSyncIndex} behind a cancellable progress notification, with
 * the summary shown at the end. Shared by the command and the empty-index
 * prompt.
 */
export async function rebuildSyncIndexInteractive(service: FileService): Promise<RebuildSummary> {
  const name = nameOf(service);
  const summary = await withProgress(
    { title: `SFTP: rebuilding the sync index of ${name}`, cancellable: true },
    (progress, token) =>
      rebuildSyncIndex(service, {
        isCancelled: () => token.isCancellationRequested,
        onProgress: p =>
          progress.report({
            message: `${p.remoteFiles} remote, ${p.localFiles} local file(s) listed`,
          }),
      })
  );
  showInformationMessage(`SFTP: ${name}: ${formatRebuildSummary(summary)}`);
  return summary;
}

function onPauseStateChanged() {
  const paused = isPaused();
  if (wasPaused && !paused) {
    scanAll('resume').catch(error => logger.error(error, '[scan] resume'));
  }
  wasPaused = paused;
}

function onWindowStateChanged(state: vscode.WindowState) {
  if (!state || !state.focused) {
    return;
  }
  const now = Date.now();
  getAllFileService().forEach(service => {
    const last = lastScanAt.get(service.baseDir);
    if (last !== undefined && now - last < FOCUS_MIN_INTERVAL_MS) {
      return;
    }
    runScan(service, 'focus').catch(error => logger.error(error, `[scan] ${nameOf(service)}`));
  });
}

// The timer reads the services on every tick rather than being rebuilt when
// they change: sftp.json reloads recreate them, and a map keyed by base dir
// follows that for free. The watcher block is root config, so it is read
// without resolving the profile.
function pollTick() {
  if (destroyed) {
    return;
  }
  const now = Date.now();
  const seen = new Set<string>();
  getAllFileService().forEach(service => {
    seen.add(service.baseDir);
    const interval = resolvePollInterval({ watcher: service.getWatcherConfig() });
    if (interval <= 0) {
      lastPollAt.delete(service.baseDir);
      return;
    }
    const last = lastPollAt.get(service.baseDir);
    if (last === undefined) {
      // first tick for this service: the first poll is one interval away
      lastPollAt.set(service.baseDir, now);
      return;
    }
    if (now - last < interval || scans.has(service.baseDir)) {
      return;
    }
    lastPollAt.set(service.baseDir, now);
    runScan(service, 'poll').catch(error => logger.error(error, `[scan] ${nameOf(service)}`));
  });
  lastPollAt.forEach((_at, baseDir) => {
    if (!seen.has(baseDir)) {
      lastPollAt.delete(baseDir);
    }
  });
}

/**
 * Installs the triggers: the startup scan (not awaited: a slow disk must not
 * delay activation), resume, focus and the poll timer. Call once the services
 * exist.
 */
export function init(context: vscode.ExtensionContext): void {
  destroy();
  destroyed = false;
  wasPaused = isPaused();

  // seeded so a focus regained right after activation doesn't scan twice
  const now = Date.now();
  getAllFileService().forEach(service => lastScanAt.set(service.baseDir, now));

  subscriptions.push(onDidChangePauseState(onPauseStateChanged));
  subscriptions.push(vscode.window.onDidChangeWindowState(onWindowStateChanged));
  subscriptions.forEach(subscription => context.subscriptions.push(subscription));

  pollTimer = setInterval(pollTick, POLL_TICK_MS);
  // unref'd so the timer never holds the process open
  if (pollTimer && typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }

  scanAll('startup').catch(error => logger.error(error, '[scan] startup'));
}

/** Cancels the timer and the subscriptions; scans in flight stop cooperatively. */
export function destroy(): void {
  destroyed = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  subscriptions.forEach(subscription => subscription.dispose());
  subscriptions.length = 0;
  lastPollAt.clear();
}

export default {
  init,
  destroy,
};

// test seam: the module keeps process-wide state
export function __resetForTest() {
  destroy();
  destroyed = false;
  scans.clear();
  lastScanAt.clear();
  emptyIndexNotified.clear();
  wasPaused = false;
}

// exported for tests
export const testHooks = {
  isTriggerEnabled,
  openScanPlans,
  pollTick,
  onWindowStateChanged,
  onPauseStateChanged,
  FOCUS_MIN_INTERVAL_MS,
};
