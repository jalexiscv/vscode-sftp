import * as vscode from 'vscode';
import app from '../app';
import logger from '../logger';
import { FileService, ServiceConfig, FileSystem, FileEntry, FileType, upath } from '../core';
import {
  resolveExternalChangesConfig,
  resolvePollInterval,
  uploadIgnoreOf,
} from '../core/fileService';
import {
  fingerprintFiles,
  FingerprintCandidate,
  FingerprintFilesResult,
} from '../core/fingerprint';
import { toRemotePath } from '../helper';
import {
  executeCommand,
  showChoiceMessage,
  showInformationMessage,
  showWarningMessage,
  withProgress,
} from '../host';
import {
  COMMAND_UPLOAD_EXCLUDE_MANAGE,
  STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED,
} from '../constants';
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
 * again until they change, and `Mark as uploaded` records them as verified
 * without a transfer.
 *
 * For a tree that is known to be on the server already — the usual case of a
 * site that has been mirrored with `uploadOnSave` for years — listing the
 * remote side to build the index is needless, and over FTP with tens of
 * thousands of files it is slow: {@link markLocalTreeAsUploaded} seeds the
 * index from the local tree alone, on the user's word.
 *
 * Key lifecycle methods:
 * - {@link init} installs the triggers; {@link destroy} removes them.
 * - {@link scanService} / {@link scanAll} run a scan for one or every service.
 * - {@link rebuildSyncIndex} seeds the index from the server.
 * - {@link markLocalTreeAsUploaded} seeds it from the local tree, unverified.
 */

export type ScanTrigger = 'startup' | 'resume' | 'focus' | 'manual' | 'poll' | 'config';

export type ScanStatus =
  | 'planned'
  | 'up-to-date'
  | 'empty-index'
  | 'too-many'
  | 'skipped'
  | 'cancelled'
  | 'error';

export interface ScanOutcome {
  status: ScanStatus;
  plan: UploadPlan | null;
  /** for `too-many`: how many files differed, against `externalChanges.maxPlanItems` */
  changed?: number;
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
  /** of the files matched by size, those read for their content fingerprint so far */
  fingerprinted: number;
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
  /** of the indexed files, those whose content fingerprint was recorded */
  fingerprinted: number;
  cancelled: boolean;
}

export interface RebuildOptions {
  isCancelled?: () => boolean;
  onProgress?: (progress: RebuildProgress) => void;
}

export interface MarkUploadedSummary {
  /** local files recorded as uploaded */
  marked: number;
  /** items of this service's open plans settled as `assumed` along the way */
  settledPlanItems: number;
  /** the scan was cancelled or the confirmation declined; the index was left as it was */
  cancelled: boolean;
}

export interface MarkUploadedOptions {
  isCancelled?: () => boolean;
  /** `fingerprinted` counts the files read for their content once the tree is listed */
  onProgress?: (scannedFiles: number, fingerprinted?: number) => void;
  /**
   * Asked once the local tree is counted and before anything is written;
   * resolving false leaves the index as it was. Without it the write goes
   * ahead — the caller confirmed already.
   */
  confirm?: (files: number) => Promise<boolean>;
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
const MARK_ALL_UPLOADED_LABEL = 'Mark all as uploaded';
const DONT_SHOW_AGAIN_LABEL = 'Don\'t show again';
const MANAGE_EXCLUSIONS_LABEL = 'Manage upload exclusions';

// plan item statuses that "mark as uploaded" settles: what a run would pick up
const OPEN_ITEM_STATUSES = ['pending', 'stale', 'failed'];

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
// base dirs whose last scan found more changed files than
// externalChanges.maxPlanItems: automatic scans would only walk the same tree
// to the same conclusion, so they stay off until something changes the
// picture (a manual scan, a rebuild, "mark as uploaded", a config reload)
const overflowed = new Map<string, number>();

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
  // "Mark all as uploaded" is the fast path for a tree that is on the server
  // already: no remote listing, the local tree becomes the baseline
  Promise.resolve(
    showInformationMessage(message, BUILD_INDEX_LABEL, MARK_ALL_UPLOADED_LABEL, DONT_SHOW_AGAIN_LABEL)
  ).then(
    choice => {
      if (choice === BUILD_INDEX_LABEL) {
        rebuildSyncIndexInteractive(service).catch(error =>
          logger.error(error, `rebuild sync index of ${name}`)
        );
      } else if (choice === MARK_ALL_UPLOADED_LABEL) {
        markLocalTreeAsUploadedInteractive(service).catch(error =>
          logger.error(error, `mark local tree of ${name} as uploaded`)
        );
      } else if (choice === DONT_SHOW_AGAIN_LABEL) {
        dismissUnbuiltNotice(index.key);
      }
    },
    error => logger.debug(`[scan] unbuilt-index prompt failed: ${error.message}`)
  );
}

/**
 * Tells the user that a scan found more changed files than
 * `externalChanges.maxPlanItems`, with the two ways out: declare the local
 * tree uploaded (the usual answer on a site that is on the server already) or
 * trim the tree with `uploadExclude`. Not modal: nothing is waiting on it.
 */
function notifyTooManyChanges(service: FileService, changed: number, limit: number) {
  const name = nameOf(service);
  const message =
    `SFTP: ${name}: ${changed.toLocaleString()} local file(s) differ from the sync index, ` +
    `above the ${limit.toLocaleString()} allowed per upload plan (externalChanges.maxPlanItems). ` +
    'Nothing was planned. If those files are on the server already, mark them as uploaded; ' +
    'if they should never go up, exclude them; otherwise upload the project and scan again.';
  Promise.resolve(showWarningMessage(message, MARK_ALL_UPLOADED_LABEL, MANAGE_EXCLUSIONS_LABEL)).then(
    choice => {
      if (choice === MARK_ALL_UPLOADED_LABEL) {
        markLocalTreeAsUploadedInteractive(service).catch(error =>
          logger.error(error, `mark local tree of ${name} as uploaded`)
        );
      } else if (choice === MANAGE_EXCLUSIONS_LABEL) {
        Promise.resolve(executeCommand(COMMAND_UPLOAD_EXCLUDE_MANAGE)).then(undefined, error =>
          logger.error(error, 'manage upload exclusions')
        );
      }
    },
    error => logger.debug(`[scan] too-many prompt failed: ${error.message}`)
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

    diff = await diffAgainstIndex({
      baseDir: service.baseDir,
      scanned: scan.files,
      index,
      // the same mapping every file command uses for a local uri
      toRemotePath: localPath => toRemotePath(localPath, service.baseDir, config.remotePath),
      compareContent: resolveExternalChangesConfig(config).compareContent,
      isCancelled,
      onProgress: compared => status(`${compared} file(s) compared by content`),
    });

    if (diff.cancelled) {
      logger.info(`[scan] ${name}: cancelled while comparing files by content`);
      app.sftpBarItem.showMsg(`scan of ${name} cancelled`, 2000);
      return { status: 'cancelled', plan: null, filesScanned: scan.files.length };
    }
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
    overflowed.delete(service.baseDir);
    logger.info(
      `[scan] ${name}: up to date (${scan.files.length} files, ${scan.durationMs} ms` +
        (diff.rewritten > 0
          ? `, ${diff.rewritten} file(s) rewritten with the same content, not planned`
          : '') +
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
      `(${diff.unchanged} unchanged` +
      (diff.rewritten > 0 ? `, ${diff.rewritten} of them rewritten with the same content` : '') +
      `, ${scan.durationMs} ms, trigger ${trigger})`
  );

  // A plan of tens of thousands of items saturates the view, the status bar,
  // the index and the connection, and answering it file by file is not a
  // real option: report the count with the two ways out instead, and keep
  // the automatic scans from walking the same tree again until something
  // changes the picture.
  const limit = resolveExternalChangesConfig(config).maxPlanItems;
  if (limit > 0 && items.length > limit) {
    overflowed.set(service.baseDir, items.length);
    logger.warn(
      `[scan] ${name}: ${items.length} changed file(s) exceed externalChanges.maxPlanItems ` +
        `(${limit}); nothing planned. Mark the local files as uploaded, add upload exclusions ` +
        'or raise the limit, then scan again'
    );
    app.sftpBarItem.showMsg(`${name}: ${items.length} changed file(s), too many to plan`, 4000);
    notifyTooManyChanges(service, items.length, limit);
    return {
      status: 'too-many',
      plan: null,
      changed: items.length,
      filesScanned: scan.files.length,
      ignoredNew,
      reason: `${items.length} changed file(s) exceed externalChanges.maxPlanItems (${limit})`,
    };
  }
  overflowed.delete(service.baseDir);
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
    (outcome.decision === 'run' || outcome.decision === 'assume') &&
    outcome.summary.pending === 0 &&
    outcome.summary.uploading === 0
  ) {
    // the user confirmed the whole tree's worth of differences and the run
    // went through — or declared them uploaded already: either way, from
    // here on the index covers the tree
    index.markSeeded();
    forgetUnbuiltNotice(index.key);
    logger.info(
      `[scan] ${name}: sync index marked as built after a manual scan ` +
        (outcome.decision === 'assume' ? 'marked as uploaded' : 'confirmed and uploaded')
    );
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
    // a reloaded sftp.json may carry new exclusions or another limit: that
    // scan gets its chance; the rest would only repeat the overflow
    if (trigger === 'config') {
      overflowed.delete(service.baseDir);
    } else if (overflowed.has(service.baseDir)) {
      return skipped(
        `the last scan found ${overflowed.get(service.baseDir)} changed file(s), above ` +
          'externalChanges.maxPlanItems; scan manually once that is settled'
      );
    }
  } else {
    supersedeOpenScanPlans(service.name);
    overflowed.delete(service.baseDir);
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
 * Fingerprints the files an index is being seeded with, unless
 * `externalChanges.compareContent` is off — then nothing is read and the
 * entries carry no fingerprint, so the scans fall back to size and mtime.
 */
function fingerprintBaseline(
  files: FingerprintCandidate[],
  config: ServiceConfig,
  options: { isCancelled: () => boolean; onProgress: (fingerprinted: number) => void }
): Promise<FingerprintFilesResult> {
  if (!resolveExternalChangesConfig(config).compareContent) {
    return Promise.resolve({ fingerprints: new Map<string, string>(), cancelled: false });
  }
  return fingerprintFiles(files, options);
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
  let fingerprinted = 0;
  const report = () => {
    if (options.onProgress) {
      options.onProgress({ localFiles, remoteFiles, fingerprinted });
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
    fingerprinted: 0,
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
  const matched: Array<{ fsPath: string; size: number }> = [];
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
    matched.push({ fsPath: file.fsPath, size: file.size });
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

  // the local content of every matched file is the baseline the scans
  // compare against when its mtime moves: read once now, or never
  const fingerprints = await fingerprintBaseline(matched, config, {
    isCancelled,
    onProgress: count => {
      fingerprinted = count;
      report();
    },
  });
  if (fingerprints.cancelled) {
    return cancelledSummary;
  }
  entries.forEach(([, entry], position) => {
    const fingerprint = fingerprints.fingerprints.get(matched[position].fsPath);
    if (fingerprint) {
      entry.fingerprint = fingerprint;
    }
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
    fingerprinted: fingerprints.fingerprints.size,
    cancelled: false,
  };
  logger.info(
    `[rebuild-index] ${name}: ${summary.indexed} indexed ` +
      `(${summary.mtimeDiffer} with another mtime on the server, ` +
      `${summary.fingerprinted} fingerprinted), ` +
      `${summary.differ} differ in size, ${summary.onlyLocal} only local, ` +
      `${summary.onlyRemote} only remote; index marked as built`
  );
  // the index changed: the automatic scans get another chance
  overflowed.delete(service.baseDir);
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
            message:
              `${p.remoteFiles} remote, ${p.localFiles} local file(s) listed` +
              (p.fingerprinted > 0 ? `, ${p.fingerprinted} fingerprinted` : ''),
          }),
      })
  );
  showInformationMessage(`SFTP: ${name}: ${formatRebuildSummary(summary)}`);
  return summary;
}

/**
 * Settles the open items (pending, stale, failed) of every plan of `service`
 * as `assumed`: the user just declared the whole local tree uploaded, so a
 * plan still waiting for a decision on some of those files has its answer.
 * An automatic scan blocked behind such a plan ("a previous scan is still
 * pending review") is unblocked by the same stroke. Returns how many items.
 */
function settleOpenPlanItems(serviceName: string): number {
  let settled = 0;
  getPlans().forEach(plan => {
    if (plan.serviceName !== serviceName) {
      return;
    }
    plan.items.forEach(item => {
      if (OPEN_ITEM_STATUSES.indexOf(item.status) !== -1) {
        updateItem(plan.id, item.localPath, { status: 'assumed', error: undefined });
        settled++;
      }
    });
  });
  return settled;
}

/**
 * Seeds the index from the local tree alone, on the user's word: every local
 * file (pruned by `ignore` and `uploadExclude`, like a scan) is recorded as
 * verified — flagged as assumed — with its current size and mtime, the index
 * is marked as seeded, and the open items of this service's plans are
 * settled as `assumed`. Nothing is listed on the server and nothing is
 * transferred: from here on, only what changes locally is proposed. The old
 * index is replaced only once the scan completes and `options.confirm` (when
 * given) agreed; a cancelled or declined call leaves it untouched.
 *
 * This is the answer to "the extension found thousands of files it never
 * uploaded" on a site that has been mirrored by hand or by `uploadOnSave` for
 * years: `Rebuild Sync Index` would list every remote directory to reach the
 * same conclusion, and a scan plan of that size saturates the connection and
 * the view.
 */
export async function markLocalTreeAsUploaded(
  service: FileService,
  options: MarkUploadedOptions = {}
): Promise<MarkUploadedSummary> {
  const name = nameOf(service);
  const config = service.getConfig();
  const isCancelled = () => destroyed || (options.isCancelled ? options.isCancelled() : false);
  const cancelled: MarkUploadedSummary = { marked: 0, settledPlanItems: 0, cancelled: true };

  const index = await indexFor(service, config);
  const local = await scanLocalTree(service.baseDir, {
    ignore: uploadIgnoreOf(config),
    isCancelled,
    onProgress: files => {
      if (options.onProgress) {
        options.onProgress(files);
      }
    },
  });
  if (local.cancelled) {
    logger.info(`[mark-uploaded] ${name}: cancelled after ${local.files.length} files; index left as it was`);
    return cancelled;
  }
  if (options.confirm && !(await options.confirm(local.files.length))) {
    logger.info(`[mark-uploaded] ${name}: declined by the user; index left as it was`);
    return cancelled;
  }

  // read after the confirmation, so a declined dialog costs no reads: the
  // content as it is now is what the scans will compare against
  const fingerprints = await fingerprintBaseline(local.files, config, {
    isCancelled,
    onProgress: count => {
      if (options.onProgress) {
        options.onProgress(local.files.length, count);
      }
    },
  });
  if (fingerprints.cancelled) {
    logger.info(`[mark-uploaded] ${name}: cancelled while fingerprinting; index left as it was`);
    return cancelled;
  }

  const now = Date.now();
  index.clear();
  local.files.forEach(file => {
    const entry: IndexEntry = {
      size: file.size,
      mtime: file.mtime,
      verifiedAt: now,
      status: 'verified',
      assumed: true,
    };
    const fingerprint = fingerprints.fingerprints.get(file.fsPath);
    if (fingerprint) {
      entry.fingerprint = fingerprint;
    }
    index.set(toRelPath(service.baseDir, file.fsPath), entry);
  });
  index.markSeeded(now);
  await index.save();
  forgetUnbuiltNotice(index.key);
  // the tree is the baseline now: the automatic scans get another chance
  overflowed.delete(service.baseDir);

  const settledPlanItems = settleOpenPlanItems(service.name);
  logger.info(
    `[mark-uploaded] ${name}: ${local.files.length} local file(s) recorded as uploaded on the ` +
      `user's word (${local.durationMs} ms, ${fingerprints.fingerprints.size} fingerprinted), ` +
      `${settledPlanItems} open plan item(s) settled; index marked as built`
  );
  return { marked: local.files.length, settledPlanItems, cancelled: false };
}

export function formatMarkUploadedSummary(summary: MarkUploadedSummary): string {
  if (summary.cancelled) {
    return 'Nothing was marked; the sync index was left as it was.';
  }
  let message =
    `${summary.marked.toLocaleString()} local file(s) recorded as uploaded; ` +
    'from now on only files that change are proposed.';
  if (summary.settledPlanItems > 0) {
    message += ` ${summary.settledPlanItems.toLocaleString()} pending plan item(s) were settled too.`;
  }
  return message;
}

/**
 * {@link markLocalTreeAsUploaded} behind a cancellable progress notification
 * and a modal confirmation that states the count and what it means, with the
 * summary shown at the end. Shared by the command and the unbuilt-index
 * notice.
 */
export async function markLocalTreeAsUploadedInteractive(
  service: FileService
): Promise<MarkUploadedSummary> {
  const name = nameOf(service);
  let host = '';
  try {
    host = service.getConfig().host;
  } catch (error) {
    // the config problem surfaces from markLocalTreeAsUploaded itself
  }
  const target = [name, host].filter(part => Boolean(part)).join(' - ');

  const summary = await withProgress(
    { title: `SFTP: counting the local files of ${name}`, cancellable: true },
    (progress, token) =>
      markLocalTreeAsUploaded(service, {
        isCancelled: () => token.isCancellationRequested,
        onProgress: (files, fingerprinted) =>
          progress.report({
            message:
              `${files} local file(s) listed` +
              (fingerprinted ? `, ${fingerprinted} fingerprinted` : ''),
          }),
        confirm: async files => {
          const confirmLabel = `Mark ${files.toLocaleString()} file(s) as uploaded`;
          const choice = await showChoiceMessage(
            `SFTP: record ${files.toLocaleString()} local file(s) as already uploaded to ${target}?\n\n` +
              'Nothing is transferred and the server is not checked: the sync index will take ' +
              'every local file, as it is now, to be on the server, and only files that change ' +
              'from here on will be proposed. Use "Rebuild Sync Index" instead if you want the ' +
              'server listed and compared.',
            [confirmLabel],
            { modal: true }
          );
          return choice === confirmLabel;
        },
      })
  );
  showInformationMessage(`SFTP: ${name}: ${formatMarkUploadedSummary(summary)}`);
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
  overflowed.clear();
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
  MARK_ALL_UPLOADED_LABEL,
  DONT_SHOW_AGAIN_LABEL,
  MANAGE_EXCLUSIONS_LABEL,
};
