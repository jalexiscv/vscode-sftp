import * as path from 'path';
import * as vscode from 'vscode';
import logger from '../logger';
import fsPromises from '../helper/fsPromises';
// used at call time only, to rebuild the retry of a persisted entry:
// fileHandlers imports serviceManager, which imports this module back, and the
// cycle resolves as long as neither side touches the other while loading
import { uploadFile, downloadFile } from '../fileHandlers';

/**
 * Record of every transfer, deletion and rename the extension performs,
 * feeding the SFTP Activity view.
 *
 * The output channel already logs everything, but a flat text log answers
 * "what happened?" poorly: it can't be filtered, a failure scrolls away, and
 * there is no way to act on an entry. This keeps the last {@link MAX_ENTRIES}
 * operations as structured data so the view can group them, show failures
 * first and offer a retry.
 *
 * Entries hold a `retry` thunk rather than enough data to rebuild the
 * operation, because rebuilding it would mean duplicating the target-resolution
 * logic of every file handler.
 *
 * The most recent {@link MAX_PERSISTED_ENTRIES} entries survive a window
 * reload: they are written, debounced and atomically, to `activity-log.json`
 * under the workspace storage path handed to {@link initActivityLog}. A
 * failure that was pending a retry is therefore still there after a reload.
 * Only uploads and downloads get their retry back on load (a fresh handler
 * call on the local path); the rest are replayed from the command that
 * produced them.
 *
 * Key lifecycle methods:
 * - {@link initActivityLog} picks the storage file and loads it; call once on
 *   activation, before anything is recorded.
 * - {@link record} / {@link update} / {@link succeed} / {@link fail} drive an
 *   entry through its life.
 * - {@link flushActivityLog} forces a pending save to disk; call on deactivate.
 */

export enum ActivityKind {
  Upload = 'upload',
  Download = 'download',
  Delete = 'delete',
  Rename = 'rename',
  Restore = 'restore',
  Sync = 'sync',
}

export enum ActivityStatus {
  Pending = 'pending',
  Success = 'success',
  Failed = 'failed',
  Cancelled = 'cancelled',
  Skipped = 'skipped',
}

export interface ActivityEntry {
  id: number;
  kind: ActivityKind;
  status: ActivityStatus;
  /** absolute local path, when the operation has one */
  localPath?: string;
  /** absolute remote path, when known */
  remotePath?: string;
  /** for renames: where it came from */
  fromPath?: string;
  /** FileService name, i.e. the `name` of the sftp.json entry */
  serviceName?: string;
  /** active profile at the time of the operation */
  profile?: string | null;
  startedAt: number;
  finishedAt?: number;
  /** message of the error that failed the operation */
  error?: string;
  /** re-runs the operation; absent when it can't be replayed */
  retry?: () => Promise<void>;
}

export type ActivityDraft = Omit<ActivityEntry, 'id' | 'startedAt' | 'status'> & {
  status?: ActivityStatus;
};

/** What goes to disk: an entry minus its retry thunk. */
type PersistedEntry = Omit<ActivityEntry, 'retry'>;

interface ActivityLogFile {
  version: number;
  entries: PersistedEntry[];
}

// bounded so a long session with a big sync can't grow the log without limit
const MAX_ENTRIES = 500;

// fewer on disk than in memory: the file is read and parsed on every
// activation, and a reload mostly needs the recent failures, not a history
const MAX_PERSISTED_ENTRIES = 200;

const LOG_FILE_NAME = 'activity-log.json';
const LOG_FILE_VERSION = 1;

// a batch updates the log once per file; coalescing the writes keeps the file
// from being serialised hundreds of times per upload burst
const SAVE_DEBOUNCE_MS = 1000;

// what a pending entry becomes when it is read back: the operation it tracked
// died with the previous extension host
const INTERRUPTED_ERROR = 'interrupted by a window reload';

const entries: ActivityEntry[] = [];
const listeners: Array<() => void> = [];
let nextId = 1;

let logFilePath: string | undefined;
let dirty = false;
let saveTimer: any = null;
// writes are chained so two overlapping saves never race on the .tmp file
let writeChain: Promise<void> = Promise.resolve();

function notify() {
  listeners.forEach(listener => {
    try {
      listener();
    } catch (error) {
      logger.error(error, 'activityLog listener');
    }
  });
}

export function record(draft: ActivityDraft): number {
  const entry: ActivityEntry = {
    ...draft,
    id: nextId++,
    startedAt: Date.now(),
    status: draft.status || ActivityStatus.Pending,
  };

  // newest first: that's the reading order of the view and it keeps the
  // trimming below at the cheap end of the array
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES;
  }

  notify();
  markDirty();
  return entry.id;
}

export function update(id: number, patch: Partial<ActivityEntry>) {
  const entry = entries.find(e => e.id === id);
  if (!entry) {
    return;
  }

  Object.assign(entry, patch);
  if (
    patch.status &&
    patch.status !== ActivityStatus.Pending &&
    entry.finishedAt === undefined
  ) {
    entry.finishedAt = Date.now();
  }

  notify();
  markDirty();
}

export function succeed(id: number) {
  update(id, { status: ActivityStatus.Success });
}

export function fail(id: number, error: Error | string) {
  const message = typeof error === 'string' ? error : error.message || String(error);
  update(id, { status: ActivityStatus.Failed, error: message });
}

/** Records an already-finished operation in a single call. */
export function log(draft: ActivityDraft & { status: ActivityStatus }): number {
  const id = record(draft);
  update(id, { status: draft.status });
  return id;
}

export function getEntries(): ActivityEntry[] {
  return entries.slice();
}

export function getEntry(id: number): ActivityEntry | undefined {
  return entries.find(e => e.id === id);
}

export function getFailedEntries(): ActivityEntry[] {
  return entries.filter(e => e.status === ActivityStatus.Failed && Boolean(e.retry));
}

export function clear() {
  entries.length = 0;
  notify();
  // an explicit clear must survive the reload too, or the entries come back
  markDirty();
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

// ---------------------------------------------------------------------------
// persistence

/**
 * Sets the storage directory and loads the entries saved by the previous
 * session.
 *
 * `storagePath` is `context.storageUri.fsPath` in production, per workspace;
 * `undefined` (no workspace) keeps the log in memory only. Never rejects: a
 * missing file is the first run, and an unreadable or corrupt one is logged
 * and ignored — losing the history only costs the retry buttons of the
 * previous session.
 *
 * Loaded entries go *after* whatever was recorded before this call, and the id
 * counter continues past the highest id read, so the session keeps numbering
 * where the previous one stopped.
 */
export async function initActivityLog(options: { storagePath: string | undefined }): Promise<void> {
  cancelScheduledSave();
  logFilePath = options.storagePath
    ? path.join(path.resolve(options.storagePath), LOG_FILE_NAME)
    : undefined;
  dirty = false;

  if (!logFilePath) {
    return;
  }

  const loaded = await readFromDisk(logFilePath);
  if (loaded.length === 0) {
    return;
  }

  let maxId = 0;
  loaded.forEach(persisted => {
    const entry = revive(persisted);
    entries.push(entry);
    if (entry.id > maxId) {
      maxId = entry.id;
    }
  });
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES;
  }
  if (maxId >= nextId) {
    nextId = maxId + 1;
  }

  notify();
}

/**
 * Writes the log now, cancelling any pending debounced save, and resolves once
 * it is on disk. Resolves immediately in memory-only mode or when nothing
 * changed since the last write. Rejects when the write fails.
 */
export function flushActivityLog(): Promise<void> {
  cancelScheduledSave();
  if (!logFilePath) {
    return Promise.resolve();
  }

  if (!dirty) {
    // nothing new, but a write may still be in flight: settle with it so a
    // flush on deactivate really means "on disk". Its failure was already
    // reported to whoever started it.
    return writeChain.catch(() => undefined);
  }

  const filePath = logFilePath;
  const run = () => writeTo(filePath);
  // run after the previous write whether it succeeded or not
  writeChain = writeChain.then(run, run);
  return writeChain;
}

function markDirty() {
  dirty = true;
  if (!logFilePath || saveTimer) {
    return;
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushActivityLog().catch(error => logger.error(error, 'save activity log'));
  }, SAVE_DEBOUNCE_MS);

  // unref'd so a pending save never holds the process open (jest would
  // otherwise report a worker that failed to exit)
  if (typeof saveTimer.unref === 'function') {
    saveTimer.unref();
  }
}

function cancelScheduledSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function toPersisted(entry: ActivityEntry): PersistedEntry {
  const persisted: ActivityEntry = { ...entry };
  delete persisted.retry;
  return persisted;
}

async function writeTo(filePath: string): Promise<void> {
  const data: ActivityLogFile = {
    version: LOG_FILE_VERSION,
    entries: entries.slice(0, MAX_PERSISTED_ENTRIES).map(toPersisted),
  };

  // cleared before the write, not after: a change that lands while the file is
  // being written must trigger another save
  dirty = false;

  // write-then-rename, so a crash mid-write leaves the previous log intact
  // rather than a truncated file that would fail to parse on the next start
  const tmpPath = filePath + '.tmp';
  try {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(tmpPath, JSON.stringify(data), 'utf8');
    await fsPromises.rename(tmpPath, filePath);
  } catch (error) {
    dirty = true;
    throw error;
  }
}

/** The persisted entries, newest first; empty on a first run or a bad file. */
async function readFromDisk(filePath: string): Promise<PersistedEntry[]> {
  let raw: string;
  try {
    raw = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      logger.warn(`[activity-log] cannot read ${filePath}: ${error.message}`);
    }
    return [];
  }

  try {
    const parsed: ActivityLogFile = JSON.parse(raw);
    if (!parsed || parsed.version !== LOG_FILE_VERSION || !Array.isArray(parsed.entries)) {
      logger.warn(`[activity-log] ${filePath} has an unexpected format; starting empty`);
      return [];
    }

    return parsed.entries.filter(isPersistedEntry).slice(0, MAX_PERSISTED_ENTRIES);
  } catch (error) {
    logger.warn(`[activity-log] ${filePath} is corrupt (${error.message}); starting empty`);
    return [];
  }
}

// enough shape to render a row; anything else in the file is skipped rather
// than crashing the view
function isPersistedEntry(value: any): value is PersistedEntry {
  return (
    Boolean(value) &&
    typeof value.id === 'number' &&
    typeof value.kind === 'string' &&
    typeof value.status === 'string' &&
    typeof value.startedAt === 'number'
  );
}

/**
 * Turns a persisted entry back into a live one.
 *
 * A `Pending` entry was in flight when the previous extension host went away;
 * it can't still be running, so it is closed as cancelled with a reason the
 * view can show. Uploads and downloads get a retry that re-runs the handler
 * on the local path — the same retry the transfer hooks install — because
 * that is what a user returns to the view for after a reload.
 */
function revive(persisted: PersistedEntry): ActivityEntry {
  const entry: ActivityEntry = { ...persisted };

  if (entry.status === ActivityStatus.Pending) {
    entry.status = ActivityStatus.Cancelled;
    entry.error = INTERRUPTED_ERROR;
  }

  const localPath = entry.localPath;
  if (localPath) {
    if (entry.kind === ActivityKind.Upload) {
      entry.retry = () => uploadFile(vscode.Uri.file(localPath));
    } else if (entry.kind === ActivityKind.Download) {
      entry.retry = () => downloadFile(vscode.Uri.file(localPath));
    }
  }

  return entry;
}

// test seam: the module keeps process-wide state
export function __resetForTest() {
  cancelScheduledSave();
  entries.length = 0;
  listeners.length = 0;
  nextId = 1;
  logFilePath = undefined;
  dirty = false;
  writeChain = Promise.resolve();
}
