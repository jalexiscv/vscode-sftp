import * as vscode from 'vscode';
import app from '../app';
import logger from '../logger';
import { FileService, ServiceConfig, FileSystem, FileEntry, FileType, upath } from '../core';
import {
  resolveExternalChangesConfig,
  resolvePollInterval,
  uploadIgnoreOf,
} from '../core/fileService';
import { toRemotePath } from '../helper';
import { showInformationMessage, withProgress } from '../host';
import { STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED } from '../constants';
import { getAllFileService } from './serviceManager';
import { isPaused, onDidChangePauseState } from './syncControl';
import { indexFor } from './syncIndexFeeder';
import { IndexEntry, SyncIndex, toRelPath } from './syncIndex';
import { scanLocalTree, ScanResult as LocalScanResult } from './localScanner';
import { isInsideTrash } from './remoteTrash';
import {
  UploadPlan,
  PlanSummary,
  DiffAgainstIndexResult,
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
 * First use and migration: until the index is *seeded* (built by
 * {@link rebuildSyncIndex}, or by a manual scan whose upload the user
 * confirmed and that finished), an automatic scan cannot tell a new file from
 * one that was on the server all along — a fresh checkout of a deployed site
 * would look like hundreds of new files. So the automatic triggers only plan
 * files the index already knows and that changed (`modified`); the unindexed
 * ones are counted and logged, never uploaded nor asked about, and the user
 * is told once per service — with `Build index now` and `Don't show again`,
 * the latter remembered per workspace — that the index is empty or not built.
 * A manual scan plans everything. Once seeded, an automatic scan that finds
 * `new` files always asks before uploading them, whatever their number; a
 * `Skip` is remembered in the index so the same files are not asked about
 * again until they change.
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
  /**
   * files the index does not know that an automatic scan left alone because
   * the index is not built yet; absent when that rule did not apply
   */
  ignoredNew?: number;
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
  /** files present on both sides with the same size: recorded as verified */
  indexed: number;
  /** files present on both sides with another size; left out, so the next scan plans them */
  differ: number;
  /** of the indexed files, those whose remote mtime differs (informational: a git/rsync deploy) */
  mtimeDiffer: number;
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
const DONT_SHOW_AGAIN_LABEL = 'Don\'t show again';

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

let destroyed = false;
let pollTimer: any = null;
let wasPaused = false;
let extensionContext: vscode.ExtensionContext | null = null;
const subscriptions: vscode.Disposable[] = [];

// one scan per service at a time; a second request joins the one in flight
const scans = new Map<string, Promise<ScanOutcome>>();
const lastScanAt = new Map<string, number>();
const lastPollAt = new Map<string, number>();
// index keys whose "not built" notice was shown this session, and those the
// user asked never to see again (persisted per workspace)
const unbuiltNoticeShown = new Set<string>();
const unbuiltNoticeDismissed = new Set<string>();

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

function loadDismissedNotices(context: vscode.ExtensionContext) {
  unbuiltNoticeDismissed.clear();
  if (!context.workspaceState) {
    return;
  }
  const stored = context.workspaceState.get<string[]>(STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED);
  (Array.isArray(stored) ? stored : []).forEach(key => unbuiltNoticeDismissed.add(key));
}

function persistDismissedNotices() {
  if (!extensionContext || !extensionContext.workspaceState) {
    return;
  }
  // fire and forget: losing the flag only brings the notice back next session
  Promise.resolve(
    extensionContext.workspaceState.update(
      STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED,
      Array.from(unbuiltNoticeDismissed)
    )
  ).then(undefined, error => logger.error(error, 'persist unbuilt-index notice'));
}

function dismissUnbuiltNotice(indexKey: string) {
  unbuiltNoticeDismissed.add(indexKey);
  persistDismissedNotices();
}

/** Once the index is built the notice has no reason to exist; forget both marks. */
function forgetUnbuiltNotice(indexKey: string) {
  unbuiltNoticeShown.delete(indexKey);
  if (unbuiltNoticeDismissed.delete(indexKey)) {
    persistDismissedNotices();
  }
}

/**
 * Tells the user, once per service and session — and never again once they
 * say so — that the index of `service` is empty or not built, so automatic
 * scans leave unindexed files alone. A dismissed notification (no button
 * chosen) comes back in the next session, not at the next scan.
 */
function notifyUnbuiltIndex(service: FileService, index: SyncIndex, unindexed: number) {
  const name = nameOf(service);
  const empty = index.size === 0;
  logger.info(
    `[scan] ${name}: the sync index is ${empty ? 'empty' : 'not built'}, ` +
      'unindexed files are left alone until it is (run "SFTP: Rebuild Sync Index")'
  );
  if (unbuiltNoticeDismissed.has(index.key) || unbuiltNoticeShown.has(index.key)) {
    return;
  }
  unbuiltNoticeShown.add(index.key);

  const message = empty
    ? `SFTP: the sync index for ${name} is empty, so external changes can't be detected yet.`
    : `SFTP: the sync index for ${name} is not built yet; ${unindexed} unindexed file(s) ` +
      'are left alone until it is.';
  Promise.resolve(showInformationMessage(message, BUILD_INDEX_LABEL, DONT_SHOW_AGAIN_LABEL)).then(
    choice => {
      if (choice === BUILD_INDEX_LABEL) {
        rebuildSyncIndexInteractive(service).catch(error =>
          logger.error(error, `rebuild sync index of ${name}`)
        );
      } else if (choice === DONT_SHOW_AGAIN_LABEL) {
        dismissUnbuiltNotice(index.key);
      }
    },
    error => logger.debug(`[scan] unbuilt-index prompt failed: ${error.message}`)
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
  const automatic = trigger !== 'manual';
  // an automatic scan on an index that was never built cannot tell a new file
  // from one that was on the server all along: it only acts on files the
  // index knows, and says so once
  const knownOnly = automatic && !index.isSeeded();
  if (knownOnly && index.size === 0) {
    notifyUnbuiltIndex(service, index, 0);
    return { status: 'empty-index', plan: null, filesScanned: 0 };
  }

  app.sftpBarItem.showMsg(`scanning ${name}…`, `SFTP: scanning ${name} for external changes`);
  status('scanning…');
  let scan: LocalScanResult;
  let diff: DiffAgainstIndexResult;
  try {
    scan = await scanLocalTree(service.baseDir, {
      ignore: uploadIgnoreOf(config),
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

    diff = diffAgainstIndex({
      baseDir: service.baseDir,
      scanned: scan.files,
      index,
      // the same mapping every file command uses for a local uri
      toRemotePath: localPath => toRemotePath(localPath, service.baseDir, config.remotePath),
    });
  } catch (error) {
    // the bar must not read "scanning…" for the rest of the session
    app.sftpBarItem.showMsg(`scan of ${name} failed`, 2000);
    throw error;
  }

  let items = diff.items;
  let ignoredNew: number | undefined;
  if (knownOnly) {
    items = diff.items.filter(item => item.reason !== 'new');
    ignoredNew = diff.items.length - items.length;
    if (ignoredNew > 0) {
      logger.info(`[scan] ${name}: ${ignoredNew} unindexed file(s) ignored until the index is built`);
      notifyUnbuiltIndex(service, index, ignoredNew);
    }
  }

  if (items.length === 0) {
    logger.info(
      `[scan] ${name}: up to date (${scan.files.length} files, ${scan.durationMs} ms` +
        (diff.missingLocally.length > 0
          ? `, ${diff.missingLocally.length} indexed file(s) no longer exist locally`
          : '') +
        (ignoredNew ? `, ${ignoredNew} unindexed file(s) ignored)` : ')')
    );
    app.sftpBarItem.showMsg(
      ignoredNew ? `${name}: ${ignoredNew} unindexed file(s) ignored` : `${name} up to date`,
      2000
    );
    if (!automatic && !index.isSeeded()) {
      // the user asked, and the tree matches the index: it covers everything
      index.markSeeded();
      forgetUnbuiltNotice(index.key);
      logger.info(`[scan] ${name}: sync index marked as built (manual scan found it complete)`);
    }
    return { status: 'up-to-date', plan: null, filesScanned: scan.files.length, ignoredNew };
  }

  logger.info(
    `[scan] ${name}: ${items.length} file(s) changed since their last verified upload ` +
      `(${diff.unchanged} unchanged, ${scan.durationMs} ms, trigger ${trigger})`
  );
  app.sftpBarItem.showMsg(`${name}: ${items.length} changed file(s)`, 2000);

  const plan = createPlan({
    serviceName: service.name,
    profile: app.state.profile,
    source: trigger === 'poll' ? 'poll' : 'scan',
    items,
  });

  status(`uploading ${plan.items.length} file(s)…`);
  const outcome = await confirmAndRunPlan(plan, {
    serviceName: service.name,
    host: config.host,
    confirmThreshold: resolveExternalChangesConfig(config).confirmThreshold,
    service,
  });

  if (
    !automatic &&
    !index.isSeeded() &&
    outcome.decision === 'run' &&
    outcome.summary.pending === 0 &&
    outcome.summary.uploading === 0
  ) {
    // the user confirmed the whole tree's worth of differences and the run
    // went through: from here on the index covers the tree
    index.markSeeded();
    forgetUnbuiltNotice(index.key);
    logger.info(`[scan] ${name}: sync index marked as built after a confirmed manual scan`);
  }

  return {
    status: 'planned',
    plan,
    decision: outcome.decision,
    summary: outcome.summary,
    filesScanned: scan.files.length,
    ignoredNew,
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

/** One after another, so two services never stack their confirmations. */
async function scanSequentially(services: FileService[], trigger: ScanTrigger): Promise<void> {
  for (const service of services) {
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

/** Scans every service, one after another so confirmations never stack. */
export function scanAll(trigger: ScanTrigger): Promise<void> {
  return scanSequentially(getAllFileService(), trigger);
}

interface RemoteWalkOptions {
  ignore: ((fsPath: string, isDirectory?: boolean) => boolean) | null | undefined;
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
      // with the directory flag, so a `dir/` pattern prunes the subtree
      if (options.ignore && options.ignore(entry.fspath, entry.type === FileType.Directory)) {
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
 * both sides with the same size is recorded as verified, with the local mtime
 * as the baseline the next scans compare against. The remote mtime is not a
 * condition — a deploy made with git or rsync gives the server other mtimes
 * for identical content, and FTP listings carry minute-level ones anyway — it
 * is only counted, for the summary. Files whose size differs or that exist on
 * one side only are left out, so the next scan plans them. The index is
 * marked as seeded: from now on the automatic scans trust it. The old index
 * is replaced only once the rebuild completes; a cancelled rebuild leaves it
 * untouched.
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
    ignore: uploadIgnoreOf(config),
    skipDir,
    isCancelled,
    onFile: entry => {
      remote.set(foldRel(upath.relative(config.remotePath, entry.fspath)), entry);
      remoteFiles++;
      report();
    },
  });
  const cancelledSummary: RebuildSummary = {
    indexed: 0,
    differ: 0,
    mtimeDiffer: 0,
    onlyLocal: 0,
    onlyRemote: 0,
    cancelled: true,
  };
  if (remoteCancelled) {
    return cancelledSummary;
  }

  const local = await scanLocalTree(service.baseDir, {
    ignore: uploadIgnoreOf(config),
    isCancelled,
    onProgress: files => {
      localFiles = files;
      report();
    },
  });
  if (local.cancelled) {
    return cancelledSummary;
  }

  // FTP listings carry minute-level mtimes and ignore futimes; counting the
  // differences there would only alarm
  const mtimeReliable = config.protocol !== 'ftp';
  const now = Date.now();
  const entries: Array<[string, IndexEntry]> = [];
  let differ = 0;
  let mtimeDiffer = 0;
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

    if (remoteEntry.size !== file.size) {
      differ++;
      return;
    }
    if (mtimeReliable && !sameMtime(file.mtime, remoteEntry.mtime)) {
      mtimeDiffer++;
    }
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
  });

  index.clear();
  entries.forEach(([relPath, entry]) => index.set(relPath, entry));
  index.markSeeded(now);
  await index.save();
  forgetUnbuiltNotice(index.key);

  const summary: RebuildSummary = {
    indexed: entries.length,
    differ,
    mtimeDiffer,
    onlyLocal,
    onlyRemote: remote.size,
    cancelled: false,
  };
  logger.info(
    `[rebuild-index] ${name}: ${summary.indexed} indexed ` +
      `(${summary.mtimeDiffer} with another mtime on the server), ` +
      `${summary.differ} differ in size, ${summary.onlyLocal} only local, ` +
      `${summary.onlyRemote} only remote; index marked as built`
  );
  return summary;
}

export function formatRebuildSummary(summary: RebuildSummary): string {
  if (summary.cancelled) {
    return 'Sync index rebuild cancelled; the index was left as it was.';
  }
  const parts = [`${summary.differ.toLocaleString()} differ in size`];
  if (summary.onlyLocal > 0) {
    parts.push(`${summary.onlyLocal.toLocaleString()} only local`);
  }
  if (summary.onlyRemote > 0) {
    parts.push(`${summary.onlyRemote.toLocaleString()} only remote`);
  }
  let message = `Indexed ${summary.indexed.toLocaleString()} files; ${parts.join(', ')}.`;
  if (summary.mtimeDiffer > 0) {
    message +=
      ` ${summary.mtimeDiffer.toLocaleString()} of the indexed files have another mtime ` +
      'on the server (matched by size).';
  }
  return message;
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
  const due = getAllFileService().filter(service => {
    const last = lastScanAt.get(service.baseDir);
    return last === undefined || now - last >= FOCUS_MIN_INTERVAL_MS;
  });
  // sequential, like the startup scan: parallel scans would stack one
  // confirmation dialog per service
  scanSequentially(due, 'focus').catch(error => logger.error(error, '[scan] focus'));
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
  extensionContext = context;
  loadDismissedNotices(context);

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
  unbuiltNoticeShown.clear();
  unbuiltNoticeDismissed.clear();
  extensionContext = null;
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
  BUILD_INDEX_LABEL,
  DONT_SHOW_AGAIN_LABEL,
};
