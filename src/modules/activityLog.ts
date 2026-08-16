import * as vscode from 'vscode';
import logger from '../logger';

/**
 * In-memory record of every transfer, deletion and rename the extension
 * performs, feeding the SFTP Activity view.
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

// bounded so a long session with a big sync can't grow the log without limit
const MAX_ENTRIES = 500;

const entries: ActivityEntry[] = [];
const listeners: Array<() => void> = [];
let nextId = 1;

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

// test seam: the module keeps process-wide state
export function __resetForTest() {
  entries.length = 0;
  listeners.length = 0;
  nextId = 1;
}
