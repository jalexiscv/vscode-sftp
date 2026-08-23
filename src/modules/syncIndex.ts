import * as crypto from 'crypto';
import * as path from 'path';
import logger from '../logger';
import upath from '../core/upath';
import fsPromises from '../helper/fsPromises';

/**
 * Persistent record of which version of each local file was last uploaded and
 * verified, per real destination.
 *
 * It is what lets the extension answer "what still needs uploading?" without
 * listing the server, and notice edits made while VS Code was closed: a scan of
 * the local tree compared against this index yields the files whose size or
 * mtime moved since their last verified upload. The index therefore reflects
 * what was *verified*, not what was attempted — callers update it from the
 * after-transfer hook, once the upload checked out.
 *
 * One index per destination: the key ({@link indexKeyFor}) folds the service
 * base dir, host, port, remote path and profile, so two profiles of the same
 * service never share entries. Each index is a JSON file under the workspace
 * storage path handed to {@link initSyncIndex}; without one (no workspace) the
 * index lives in memory only. Entries are keyed by the path relative to the
 * service base dir, always with "/" separators, and looked up case-insensitively
 * on Windows and macOS while keeping the casing they were stored with.
 *
 * Key lifecycle methods:
 * - {@link initSyncIndex} picks the storage directory; call once on activation.
 * - {@link getSyncIndex} loads an index lazily by key.
 * - {@link SyncIndex.set} / {@link SyncIndex.remove} / {@link SyncIndex.rename}
 *   mutate entries; writes are debounced and atomic (`.tmp` + rename).
 * - {@link flushSyncIndex} forces every loaded index to disk; call on deactivate.
 */

export interface IndexEntry {
  /** size of the LOCAL file at the moment of the verified upload */
  size: number;
  /** mtime of the LOCAL file at the moment of the verified upload, in ms */
  mtime: number;
  /** when the upload was verified, ms epoch */
  verifiedAt: number;
  remoteSize?: number;
  remoteMtime?: number;
  status: 'verified' | 'failed';
  error?: string;
}

interface IndexFile {
  version: number;
  key: string;
  entries: { [relPath: string]: IndexEntry };
}

const INDEX_FILE_VERSION = 1;

// subfolder of the storage path, so the index files don't mingle with whatever
// else the extension may store there later
const INDEX_DIR_NAME = 'sync-index';

// A burst of uploads updates the index once per file; coalescing the writes
// keeps a 50k-entry index from being serialised hundreds of times per batch.
const SAVE_DEBOUNCE_MS = 1000;

// windows and macOS both default to case-insensitive filesystems, so a lookup
// whose casing differs from the stored path must still find it
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function foldCase(value: string): string {
  return CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
}

/** Unix separators, no leading "./" or "/": the form every entry is keyed by. */
function normalizeRelPath(relPath: string): string {
  return upath
    .toUnix(relPath)
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
}

let storageRoot: string | undefined;
const loaded = new Map<string, SyncIndex>();
const loading = new Map<string, Promise<SyncIndex>>();

export class SyncIndex {
  readonly key: string;

  // folded relPath -> entry with its original casing, so lookups are
  // case-insensitive where the filesystem is, and the view shows the real name
  private _entries = new Map<string, { relPath: string; entry: IndexEntry }>();
  private _dirty = false;
  private _saveTimer: any = null;
  // writes are chained so two overlapping saves never race on the .tmp file
  private _writeChain: Promise<void> = Promise.resolve();

  /** @param filePath null for a memory-only index */
  constructor(key: string, private _filePath: string | null) {
    this.key = key;
  }

  get(relPath: string): IndexEntry | undefined {
    const found = this._entries.get(foldCase(normalizeRelPath(relPath)));
    return found ? found.entry : undefined;
  }

  set(relPath: string, entry: IndexEntry): void {
    const normalized = normalizeRelPath(relPath);
    this._entries.set(foldCase(normalized), { relPath: normalized, entry });
    this._markDirty();
  }

  remove(relPath: string): void {
    if (this._entries.delete(foldCase(normalizeRelPath(relPath)))) {
      this._markDirty();
    }
  }

  /** Moves an entry to a new path; a no-op when `fromRel` is unknown. */
  rename(fromRel: string, toRel: string): void {
    const fromKey = foldCase(normalizeRelPath(fromRel));
    const found = this._entries.get(fromKey);
    if (!found) {
      return;
    }

    this._entries.delete(fromKey);
    const normalizedTo = normalizeRelPath(toRel);
    this._entries.set(foldCase(normalizedTo), { relPath: normalizedTo, entry: found.entry });
    this._markDirty();
  }

  /** Every entry, keyed by the relative path it was stored with. */
  entries(): Array<[string, IndexEntry]> {
    return Array.from(this._entries.values()).map(
      ({ relPath, entry }) => [relPath, entry] as [string, IndexEntry]
    );
  }

  get size(): number {
    return this._entries.size;
  }

  clear(): void {
    if (this._entries.size === 0) {
      return;
    }

    this._entries.clear();
    this._markDirty();
  }

  /**
   * Writes the index now, cancelling any pending debounced save.
   *
   * Resolves immediately for a memory-only index or when nothing changed since
   * the last write. Rejects when the write fails; the debounced path logs that
   * instead, since nobody is awaiting it.
   */
  save(): Promise<void> {
    this._cancelScheduledSave();
    if (!this._filePath) {
      return Promise.resolve();
    }

    if (!this._dirty) {
      // nothing new, but a write may still be in flight: settle with it, so a
      // flush on deactivate really means "on disk". Its failure was already
      // reported to whoever started it.
      return this._writeChain.catch(() => undefined);
    }

    const filePath = this._filePath;
    const run = () => this._writeTo(filePath);
    // run after the previous write whether it succeeded or not
    this._writeChain = this._writeChain.then(run, run);
    return this._writeChain;
  }

  /** Replaces the contents with what was read from disk; does not mark dirty. */
  _load(entries: { [relPath: string]: IndexEntry }): void {
    this._entries.clear();
    Object.keys(entries).forEach(relPath => {
      const normalized = normalizeRelPath(relPath);
      this._entries.set(foldCase(normalized), { relPath: normalized, entry: entries[relPath] });
    });
    this._dirty = false;
  }

  /** Drops a pending debounced save. Used when the module is reset. */
  _dispose(): void {
    this._cancelScheduledSave();
  }

  private _markDirty() {
    this._dirty = true;
    if (!this._filePath || this._saveTimer) {
      return;
    }

    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save().catch(error => logger.error(error, `save sync index ${this.key}`));
    }, SAVE_DEBOUNCE_MS);

    // unref'd so a pending save never holds the process open (jest would
    // otherwise report a worker that failed to exit)
    if (typeof this._saveTimer.unref === 'function') {
      this._saveTimer.unref();
    }
  }

  private _cancelScheduledSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
  }

  private async _writeTo(filePath: string): Promise<void> {
    const data: IndexFile = {
      version: INDEX_FILE_VERSION,
      key: this.key,
      entries: {},
    };
    this._entries.forEach(({ relPath, entry }) => {
      data.entries[relPath] = entry;
    });

    // cleared before the write, not after: a mutation that lands while the
    // file is being written must trigger another save
    this._dirty = false;

    // write-then-rename, so a crash mid-write leaves the previous index intact
    // rather than a truncated file that would fail to parse on the next start
    const tmpPath = filePath + '.tmp';
    try {
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(tmpPath, JSON.stringify(data), 'utf8');
      await fsPromises.rename(tmpPath, filePath);
    } catch (error) {
      this._dirty = true;
      throw error;
    }
  }
}

/**
 * Sets the directory the indexes are persisted under.
 *
 * In production this is `context.storageUri.fsPath`, which is per workspace;
 * `undefined` (no workspace open) switches every index to memory only.
 */
export function initSyncIndex(options: { storagePath: string | undefined }): void {
  storageRoot = options.storagePath ? path.resolve(options.storagePath) : undefined;
}

function indexFilePath(key: string): string | null {
  return storageRoot ? path.join(storageRoot, INDEX_DIR_NAME, key + '.json') : null;
}

async function loadFromDisk(key: string, filePath: string): Promise<SyncIndex> {
  const index = new SyncIndex(key, filePath);

  let raw: string;
  try {
    raw = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      logger.warn(`[sync-index] cannot read ${filePath}: ${error.message}`);
    }
    return index;
  }

  try {
    const parsed: IndexFile = JSON.parse(raw);
    if (
      !parsed ||
      parsed.version !== INDEX_FILE_VERSION ||
      !parsed.entries ||
      typeof parsed.entries !== 'object'
    ) {
      logger.warn(`[sync-index] ${filePath} has an unexpected format; starting empty`);
      return index;
    }

    index._load(parsed.entries);
  } catch (error) {
    // an unparsable index is unrecoverable; starting empty only costs a
    // re-upload of files that haven't changed, which the next verified upload
    // records again
    logger.warn(`[sync-index] ${filePath} is corrupt (${error.message}); starting empty`);
  }

  return index;
}

/**
 * The index for a destination key, loaded on first use.
 *
 * Concurrent callers for the same key share one load, so a burst of uploads at
 * activation can't create two instances that overwrite each other's file.
 */
export function getSyncIndex(key: string): Promise<SyncIndex> {
  const existing = loaded.get(key);
  if (existing) {
    return Promise.resolve(existing);
  }

  const pending = loading.get(key);
  if (pending) {
    return pending;
  }

  const filePath = indexFilePath(key);
  const load = filePath
    ? loadFromDisk(key, filePath)
    : Promise.resolve(new SyncIndex(key, null));

  const tracked = load.then(index => {
    loading.delete(key);
    loaded.set(key, index);
    return index;
  });
  loading.set(key, tracked);
  return tracked;
}

/**
 * Writes every loaded index that has unsaved changes.
 *
 * All of them are attempted even when one fails; the first failure is rethrown
 * afterwards so the caller can log it.
 */
export async function flushSyncIndex(): Promise<void> {
  let firstError: any = null;

  await Promise.all(
    Array.from(loaded.values()).map(index =>
      index.save().catch(error => {
        if (!firstError) {
          firstError = error;
        }
      })
    )
  );

  if (firstError) {
    throw firstError;
  }
}

/**
 * Stable, filename-safe identity of one destination.
 *
 * A sha1 of the normalised components: base dir (unix separators, no trailing
 * slash, folded to lower case on case-insensitive platforms), host (lower
 * case: hostnames are case-insensitive), port, remote path (normalised, no
 * trailing slash) and profile (null and "" are the same thing).
 */
export function indexKeyFor(input: {
  baseDir: string;
  host: string;
  port: number;
  remotePath: string;
  profile: string | null;
}): string {
  const baseDir = foldCase(stripTrailingSlash(upath.toUnix(input.baseDir)));
  const host = (input.host || '').trim().toLowerCase();
  const remotePath = stripTrailingSlash(upath.normalize(input.remotePath || ''));
  const profile = input.profile || '';

  return crypto
    .createHash('sha1')
    .update([baseDir, host, String(input.port), remotePath, profile].join('\n'))
    .digest('hex');
}

function stripTrailingSlash(value: string): string {
  const stripped = value.replace(/\/+$/, '');
  // "/" is a legitimate remote root; don't reduce it to ""
  return stripped === '' && value.charAt(0) === '/' ? '/' : stripped;
}

/**
 * Path of `fsPath` relative to `baseDir`, with "/" separators and no leading
 * "./". Empty when both are the same path; a path outside `baseDir` comes back
 * in "../" form (or absolute across drives on Windows) and is the caller's
 * problem.
 */
export function toRelPath(baseDir: string, fsPath: string): string {
  return normalizeRelPath(upath.relative(upath.toUnix(baseDir), upath.toUnix(fsPath)));
}

// test seam: the module keeps process-wide state
export function __resetForTest() {
  loaded.forEach(index => index._dispose());
  loaded.clear();
  loading.clear();
  storageRoot = undefined;
}
