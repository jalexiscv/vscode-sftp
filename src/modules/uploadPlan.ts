import * as path from 'path';
import * as vscode from 'vscode';
import logger from '../logger';
import { canFingerprint, fingerprintFile } from '../core/fingerprint';
import { IndexEntry, SyncIndex, toRelPath } from './syncIndex';
import { LocalFileRecord } from './localScanner';

/**
 * The manifest of a batch of files to upload, and the record of how it went.
 *
 * Between "something changed" and "upload it" there is now an explicit plan:
 * a list of items, each with the reason it is there (new, modified, ...) and a
 * status that moves from pending to verified or failed as the transfer runs.
 * Having it as data is what makes a batch previewable before it runs,
 * confirmable when it is large, exportable as a report afterwards, and
 * retryable item by item from the activity view.
 *
 * Plans are built by the callers that detect changes — the watcher, a scan
 * against the sync index ({@link diffAgainstIndex}), an explicit command — and
 * executed by the transfer layer, which reports back through
 * {@link updateItem}. This module holds the last {@link MAX_PLANS} plans in
 * memory and notifies listeners on every change, in the same way the activity
 * log does; it performs no transfer itself.
 *
 * Key lifecycle methods:
 * - {@link createPlan} registers a new plan from a draft.
 * - {@link updateItem} records an item's progress and closes the plan when
 *   nothing is left pending.
 * - {@link summarize} / {@link formatSummary} / {@link formatReport} turn a
 *   plan into numbers, into one line and into a Markdown report.
 * - {@link removePlan} / {@link clearPlans} forget one plan or all of them.
 * - {@link classifyAgainstIndex} decides whether one local file is new,
 *   modified or unchanged against the index, reading it when only that can
 *   tell; {@link diffAgainstIndex} applies it to a whole local scan.
 */

export type PlanSource = 'watcher' | 'scan' | 'command' | 'git' | 'poll';
export type PlanReason = 'new' | 'modified' | 'deleted' | 'renamed' | 'missing-remote';
/**
 * `assumed`: the user declared the item to be on the server already ("mark as
 * uploaded"); nothing was transferred, the index records it as verified.
 */
export type PlanItemStatus =
  | 'pending'
  | 'uploading'
  | 'verified'
  | 'failed'
  | 'skipped'
  | 'assumed'
  | 'stale';

export interface UploadPlanItem {
  localPath: string;
  remotePath: string;
  reason: PlanReason;
  localSize: number;
  /** local mtime in ms */
  localMtime: number;
  status: PlanItemStatus;
  attempts: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface UploadPlan {
  /** `YYYYMMDD-HHmmss-n`, n counting up within the session */
  id: string;
  serviceName: string;
  profile: string | null;
  source: PlanSource;
  createdAt: number;
  /** set once no item is pending or uploading */
  finishedAt?: number;
  items: UploadPlanItem[];
}

export interface PlanSummary {
  total: number;
  pending: number;
  uploading: number;
  verified: number;
  failed: number;
  skipped: number;
  assumed: number;
  stale: number;
  /** local bytes of every item in the plan */
  bytes: number;
}

export type UploadPlanItemDraft = Omit<UploadPlanItem, 'status' | 'attempts'> &
  Partial<Pick<UploadPlanItem, 'status' | 'attempts'>>;

export interface UploadPlanDraft {
  serviceName: string;
  profile: string | null;
  source: PlanSource;
  items: UploadPlanItemDraft[];
}

// enough history to review the session's batches without growing for ever
const MAX_PLANS = 20;

// statuses after which an item will not be touched again by this plan
const TERMINAL_STATUSES: PlanItemStatus[] = ['verified', 'failed', 'skipped', 'assumed'];

const plans: UploadPlan[] = [];
const listeners: Array<() => void> = [];
let nextSequence = 1;

// windows and macOS both default to case-insensitive filesystems, so an update
// addressed with different casing than the item was created with must match
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function samePath(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return CASE_INSENSITIVE_FS ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function notify() {
  listeners.forEach(listener => {
    try {
      listener();
    } catch (error) {
      logger.error(error, 'uploadPlan listener');
    }
  });
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// same shape as the remote trash batch stamp, so the two sort and read alike
function stamp(when: Date): string {
  return (
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
  );
}

/**
 * Registers a plan. `now` is injectable so ids are reproducible in tests.
 *
 * Items default to `pending` with zero attempts; a draft may pre-set either,
 * e.g. to register an item that was skipped before the plan ran.
 */
export function createPlan(draft: UploadPlanDraft, now: Date = new Date()): UploadPlan {
  const plan: UploadPlan = {
    id: `${stamp(now)}-${nextSequence++}`,
    serviceName: draft.serviceName,
    profile: draft.profile,
    source: draft.source,
    createdAt: now.getTime(),
    items: draft.items.map(item => ({
      ...item,
      status: item.status || 'pending',
      attempts: item.attempts || 0,
    })),
  };

  // newest first, like the activity log: that's the reading order of the view
  plans.unshift(plan);
  if (plans.length > MAX_PLANS) {
    plans.length = MAX_PLANS;
  }

  notify();
  return plan;
}

/** Most recent first. A copy of the list; the plans themselves are live. */
export function getPlans(): UploadPlan[] {
  return plans.slice();
}

export function getPlan(id: string): UploadPlan | undefined {
  return plans.find(plan => plan.id === id);
}

export function getLatestPlan(): UploadPlan | undefined {
  return plans[0];
}

/**
 * Applies `patch` to the item with that local path.
 *
 * Moving to `uploading` stamps `startedAt`; reaching `verified`, `failed`,
 * `skipped` or `assumed` stamps `finishedAt`. A caller that re-queues an item sets its
 * status back to `pending` (and may clear `finishedAt` explicitly). The plan's
 * own `finishedAt` follows: set once no item is pending or uploading, cleared
 * if one becomes so again.
 */
export function updateItem(planId: string, localPath: string, patch: Partial<UploadPlanItem>): void {
  const plan = getPlan(planId);
  if (!plan) {
    return;
  }

  const item = plan.items.find(candidate => samePath(candidate.localPath, localPath));
  if (!item) {
    return;
  }

  const now = Date.now();
  Object.assign(item, patch);

  if (patch.status === 'uploading' && item.startedAt === undefined) {
    item.startedAt = now;
  }
  if (patch.status && TERMINAL_STATUSES.indexOf(patch.status) !== -1 && item.finishedAt === undefined) {
    item.finishedAt = now;
  }

  const open = plan.items.some(
    candidate => candidate.status === 'pending' || candidate.status === 'uploading'
  );
  if (open) {
    plan.finishedAt = undefined;
  } else if (plan.finishedAt === undefined) {
    plan.finishedAt = now;
  }

  notify();
}

export function summarize(plan: UploadPlan): PlanSummary {
  const summary: PlanSummary = {
    total: plan.items.length,
    pending: 0,
    uploading: 0,
    verified: 0,
    failed: 0,
    skipped: 0,
    assumed: 0,
    stale: 0,
    bytes: 0,
  };

  plan.items.forEach(item => {
    summary[item.status]++;
    summary.bytes += item.localSize || 0;
  });

  return summary;
}

/**
 * One line of numbers for a plan, e.g. `12 files — 10 verified, 1 failed,
 * 1 pending`. The three main counters are always there; uploading, skipped,
 * assumed and stale only when non-zero, so the usual case stays short. Shared
 * by the activity view and the end-of-run notification, so both read alike.
 */
export function formatSummary(summary: PlanSummary): string {
  const parts = [
    `${summary.verified} verified`,
    `${summary.failed} failed`,
    `${summary.pending} pending`,
  ];
  if (summary.uploading > 0) {
    parts.push(`${summary.uploading} uploading`);
  }
  if (summary.skipped > 0) {
    parts.push(`${summary.skipped} skipped`);
  }
  if (summary.assumed > 0) {
    parts.push(`${summary.assumed} assumed uploaded`);
  }
  if (summary.stale > 0) {
    parts.push(`${summary.stale} stale`);
  }

  return `${summary.total} ${summary.total === 1 ? 'file' : 'files'} — ${parts.join(', ')}`;
}

/** `512 B`, `2.0 KB`, `120 MB`: one decimal below 100, none above. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(ms: number): string {
  const when = new Date(ms);
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
  );
}

// a path or error message with "|" or a newline would break the table
function cell(value: string | undefined): string {
  return (value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * The plan as a Markdown document: a header with service, profile, source,
 * dates and the summary, then one table row per item. Meant for "Export Upload
 * Report" — something to keep for an audit or paste into a ticket.
 */
export function formatReport(plan: UploadPlan): string {
  const summary = summarize(plan);
  const lines: string[] = [];

  lines.push(`# Upload plan ${plan.id}`);
  lines.push('');
  lines.push(`- Service: ${plan.serviceName}`);
  lines.push(`- Profile: ${plan.profile || '(none)'}`);
  lines.push(`- Source: ${plan.source}`);
  lines.push(`- Created: ${formatDate(plan.createdAt)}`);
  lines.push(`- Finished: ${plan.finishedAt ? formatDate(plan.finishedAt) : '(in progress)'}`);
  lines.push(
    `- Summary: ${summary.total} item(s), ${formatBytes(summary.bytes)} — ` +
      `${summary.verified} verified, ${summary.failed} failed, ${summary.skipped} skipped, ` +
      `${summary.assumed} assumed uploaded, ${summary.stale} stale, ` +
      `${summary.uploading} uploading, ${summary.pending} pending`
  );
  lines.push('');
  lines.push('| Status | Reason | Local | Remote | Size | Attempts | Error |');
  lines.push('|---|---|---|---|---|---|---|');

  plan.items.forEach(item => {
    lines.push(
      `| ${item.status} | ${item.reason} | ${cell(item.localPath)} | ${cell(item.remotePath)} ` +
        `| ${formatBytes(item.localSize || 0)} | ${item.attempts} | ${cell(item.error)} |`
    );
  });

  lines.push('');
  return lines.join('\n');
}

export function onDidChange(listener: () => void): vscode.Disposable {
  listeners.push(listener);
  return {
    dispose() {
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    },
  };
}

export function clearPlans(): void {
  plans.length = 0;
  notify();
}

/** Drops one plan from the registry. Returns false when the id is unknown. */
export function removePlan(id: string): boolean {
  const index = plans.findIndex(plan => plan.id === id);
  if (index === -1) {
    return false;
  }

  plans.splice(index, 1);
  notify();
  return true;
}

export interface DiffAgainstIndexInput {
  baseDir: string;
  /** what the local scanner found */
  scanned: LocalFileRecord[];
  index: SyncIndex;
  /** the caller resolves the remote path (UResource / config.remotePath) */
  toRemotePath: (localFsPath: string) => string;
  /** `externalChanges.compareContent`; true when omitted */
  compareContent?: boolean;
  /** polled between the files read for their content; cooperative */
  isCancelled?: () => boolean;
  /** called after every file read for its content, with how many were so far */
  onProgress?: (compared: number) => void;
}

export interface DiffAgainstIndexResult {
  items: Array<Omit<UploadPlanItem, 'status' | 'attempts'>>;
  /** files that are the version their entry describes (the rewritten ones included) */
  unchanged: number;
  /**
   * of the unchanged, those whose mtime moved with the same size and whose
   * content turned out to be the one the index knows: rewritten, not edited
   */
  rewritten: number;
  /** index entries (relative paths) with no local file; informational only */
  missingLocally: string[];
  /** the cancellation fired while files were being read; the result is partial */
  cancelled: boolean;
}

/** What one local file is, against its index entry. */
export type ChangeVerdict = 'new' | 'modified' | 'unchanged';

export interface ClassifyInput {
  index: SyncIndex;
  /** the entry's key: path relative to the service base dir */
  relPath: string;
  fsPath: string;
  size: number;
  /** mtime in ms */
  mtime: number;
  /** `externalChanges.compareContent`; true when omitted */
  compareContent?: boolean;
}

export interface ClassifyResult {
  verdict: ChangeVerdict;
  /**
   * true when the file had to be read: its size matched and its mtime moved,
   * so only the content could tell. An `unchanged` verdict with this flag is
   * a file rewritten with the same bytes; a `modified` one really changed.
   */
  byContent: boolean;
}

// files read at once by diffAgainstIndex; see core/fingerprint
const COMPARE_CONCURRENCY = 4;

// Remote filesystems report mtime with one-second resolution, and the
// transfer layer compares in seconds for that reason; comparing the local
// side in seconds as well keeps "unchanged" consistent between the two.
export function mtimeInSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/**
 * Whether a local file of `size` and `mtime` is the version its index entry
 * describes by its stat alone, i.e. nothing to upload: a verified (or
 * skipped) entry with the same size and the same mtime to the second. A
 * `failed` entry is never unchanged. This is the cheap half of the rule; a
 * file that fails it with the same size may still be unchanged by content,
 * which {@link classifyAgainstIndex} settles by reading it. The plan runner
 * uses this stat-only rule to notice a file rewritten during its upload.
 */
export function isUnchangedAgainstIndex(
  entry: { size: number; mtime: number; status?: string } | undefined,
  size: number,
  mtime: number
): boolean {
  if (!entry || entry.status === 'failed') {
    return false;
  }
  return entry.size === size && mtimeInSeconds(entry.mtime) === mtimeInSeconds(mtime);
}

// the stat-only verdict, or 'suspect' when only the content can tell: the
// same size under another mtime, with a fingerprint to compare against
function classifyByStat(
  entry: IndexEntry | undefined,
  size: number,
  mtime: number,
  compareContent: boolean
): ChangeVerdict | 'suspect' {
  if (!entry) {
    return 'new';
  }
  if (isUnchangedAgainstIndex(entry, size, mtime)) {
    return 'unchanged';
  }
  if (
    entry.status === 'failed' ||
    entry.size !== size ||
    !compareContent ||
    !entry.fingerprint ||
    !canFingerprint(size)
  ) {
    return 'modified';
  }
  return 'suspect';
}

// reads the suspect and settles it: the same bytes under a new mtime are
// not an edit, and the entry moves along with the mtime so the next scan
// needs no read; other bytes are a change
async function classifySuspect(
  index: SyncIndex,
  relPath: string,
  entry: IndexEntry,
  fsPath: string,
  mtime: number
): Promise<ChangeVerdict> {
  let fingerprint: string;
  try {
    fingerprint = await fingerprintFile(fsPath);
  } catch (error) {
    // gone or unreadable between the stat and the read: the old rule applies,
    // and the upload (or its absence) will say more
    logger.debug(`[plan] ${fsPath} could not be compared by content: ${error.message}`);
    return 'modified';
  }
  if (fingerprint !== entry.fingerprint) {
    return 'modified';
  }
  // the entry may have been rewritten meanwhile (a verified upload landed):
  // refresh only what is still the same version
  const current = index.get(relPath);
  if (current && current.fingerprint === entry.fingerprint && current.status === entry.status) {
    index.set(relPath, { ...current, mtime });
  }
  return 'unchanged';
}

/**
 * What one local file is against the index of its service:
 *
 * - not in the index → `new`
 * - in the index as `failed` → `modified`: the entry records an attempt, not
 *   a verified state, so the file is due again whatever its stat
 * - a verified (or skipped) entry with the same size and mtime (to the
 *   second) → `unchanged`
 * - another size → `modified`, without reading anything
 * - the same size under another mtime → the file is read and its fingerprint
 *   compared with the entry's (when the entry has one, `compareContent` is on
 *   and the file is not above the size cap): the same bytes are `unchanged`
 *   — a checkout, a copy, a `touch`, a formatter that changed nothing — and
 *   the entry's mtime is moved to the new one so the next scan needs no read;
 *   other bytes are `modified`. Without a fingerprint to compare against, the
 *   file is `modified` as it always was.
 *
 * The scanner, the change collector and the plan runner all use this one
 * rule, so a file is "unchanged" for one of them iff it is for all.
 */
export async function classifyAgainstIndex(input: ClassifyInput): Promise<ClassifyResult> {
  const entry = input.index.get(input.relPath);
  const compareContent = input.compareContent !== false;
  const byStat = classifyByStat(entry, input.size, input.mtime, compareContent);
  if (byStat !== 'suspect') {
    return { verdict: byStat, byContent: false };
  }
  const verdict = await classifySuspect(
    input.index,
    input.relPath,
    entry!,
    input.fsPath,
    input.mtime
  );
  return { verdict, byContent: true };
}

/**
 * Turns a local scan into plan items by comparing it with the sync index,
 * file by file with the rule of {@link classifyAgainstIndex}: `new` and
 * `modified` files become items (in the order they were scanned), unchanged
 * ones are counted — those told apart by their content also as `rewritten` —
 * and index entries with no local file are listed in `missingLocally`
 * (deletions are mirrored by another module, this only reports them).
 *
 * The stat comparison is immediate; the files only the content can settle
 * are read a few at a time, with progress and cooperative cancellation. The
 * index is never given new entries here, but an entry whose file was
 * rewritten identically has its mtime refreshed.
 */
export async function diffAgainstIndex(input: DiffAgainstIndexInput): Promise<DiffAgainstIndexResult> {
  const compareContent = input.compareContent !== false;
  const isCancelled = input.isCancelled || (() => false);
  const seen = new Set<string>();
  const verdicts: ChangeVerdict[] = [];
  const suspects: Array<{ position: number; relPath: string; entry: IndexEntry }> = [];
  let rewritten = 0;

  input.scanned.forEach((record, position) => {
    const relPath = toRelPath(input.baseDir, record.fsPath);
    seen.add(foldRel(relPath));
    const entry = input.index.get(relPath);
    const byStat = classifyByStat(entry, record.size, record.mtime, compareContent);
    if (byStat === 'suspect') {
      // settled below; 'modified' is what it is if the read never happens
      verdicts[position] = 'modified';
      suspects.push({ position, relPath, entry: entry! });
    } else {
      verdicts[position] = byStat;
    }
  });

  let next = 0;
  let compared = 0;
  let cancelled = false;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(COMPARE_CONCURRENCY, suspects.length)) },
    async () => {
      while (next < suspects.length) {
        if (isCancelled()) {
          cancelled = true;
          return;
        }
        const suspect = suspects[next++];
        const record = input.scanned[suspect.position];
        const verdict = await classifySuspect(
          input.index,
          suspect.relPath,
          suspect.entry,
          record.fsPath,
          record.mtime
        );
        verdicts[suspect.position] = verdict;
        if (verdict === 'unchanged') {
          rewritten++;
        }
        compared++;
        if (input.onProgress) {
          input.onProgress(compared);
        }
      }
    }
  );
  await Promise.all(lanes);

  const items: DiffAgainstIndexResult['items'] = [];
  let unchanged = 0;
  input.scanned.forEach((record, position) => {
    const verdict = verdicts[position];
    if (verdict === 'unchanged') {
      unchanged++;
      return;
    }
    items.push({
      localPath: record.fsPath,
      remotePath: input.toRemotePath(record.fsPath),
      reason: verdict,
      localSize: record.size,
      localMtime: record.mtime,
    });
  });

  const missingLocally = input.index
    .entries()
    .map(([relPath]) => relPath)
    .filter(relPath => !seen.has(foldRel(relPath)));

  return { items, unchanged, rewritten, missingLocally, cancelled };
}

function foldRel(relPath: string): string {
  return CASE_INSENSITIVE_FS ? relPath.toLowerCase() : relPath;
}

// test seam: the module keeps process-wide state
export function __resetForTest() {
  plans.length = 0;
  listeners.length = 0;
  nextSequence = 1;
}
