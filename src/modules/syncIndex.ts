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
 * An index is *seeded* ({@link SyncIndex.isSeeded}) once it is known to cover
 * the whole tree: after `SFTP: Rebuild Sync Index`, or after a manual scan
 * whose upload the user confirmed and that finished. Until then the index only
 * holds what individual uploads recorded, and a file it does not know may be
 * either new or simply never uploaded from this machine — so the automatic
 * scans leave such files alone instead of treating them as new.
 *
 * Key lifecycle methods:
 * - {@link initSyncIndex} picks the storage directory; call once on activation.
 * - {@link getSyncIndex} loads an index lazily by key.
 * - {@link SyncIndex.set} / {@link SyncIndex.remove} / {@link SyncIndex.rename}
 *   mutate entries; writes are debounced and atomic (`.tmp` + rename).
 * - {@link SyncIndex.markSeeded} records that the index covers the tree.
 * - {@link flushSyncIndex} forces every loaded index to disk; call on deactivate.
 */

export interface IndexEntry {
  /** size of the LOCAL file at the moment of the verified upload (or of the skip) */
  size: number;
  /** mtime of the LOCAL file at the moment of the verified upload (or of the skip), in ms */
  mtime: number;
  /** when the upload was verified, ms epoch; 0 for an entry that was never verified */
  verifiedAt: number;
  remoteSize?: number;
  remoteMtime?: number;
  /**
   * `verified`: the local file of this size/mtime is on the server;
   * `failed`: the last upload attempt failed, the file is due again whatever
   * its stat; `skipped`: the user chose not to upload this version, so it is
   * left alone while its size and mtime stay the same.
   */
  status: 'verified' | 'failed' | 'skipped';
  error?: string;
  /**
   * true on a `verified` entry the user asserted rather than the extension
   * checked ("mark as uploaded"): the file is taken to be on the server in
   * this version, nothing was transferred or compared.
   */
  assumed?: boolean;
}

interface IndexFile {
  version: number;
  key: string;
  entries: { [relPath: string]: IndexEntry };
  /** when the index was seeded from the server or by a confirmed scan; absent until then */
  seededAt?: number;
}

const INDEX_FILE_VERSION = 1;

// subfolder of the storage path, so the index files don't mingle with whatever
// else the extension may store there later
const INDEX_DIR_NAME = 'sync-index';

// A burst of uploads updates the index once per file; coalescing the writes
// keeps a 50k-entry index from being serialised hundreds of times per batch.
const SAVE_DEBOUNCE_MS = 1000;

// While a plan runs (see holdSyncIndexSaves) the index changes once per
// uploaded file for minutes on end; a 90k-entry index serialised every second
// for the whole run is what kept the extension host busy on big trees. Held
// saves still land this often, so a crash mid-run loses a minute at most.
const SAVE_DEBOUNCE_HELD_MS = 60 * 1000;

// callers holding the saves back; see holdSyncIndexSaves
let saveHolds = 0;

// On windows, renaming over a file that an antivirus or an indexer holds open
// fails with EPERM for a few milliseconds; two short retries cover that window
// without turning a flush on deactivate into a long wait.
const RENAME_RETRY_DELAYS_MS = [100, 200];

// A save that keeps failing is rescheduled on its own this many times in a
// row; past that it waits for the next change (or flush) rather than logging
// the same error every second for the rest of the session.
const MAX_AUTO_RETRIES = 5;

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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let storageRoot: string | undefined;
const loaded = new Map<string, SyncIndex>();
const loading = new Map<string, Promise<SyncIndex>>();

/**
 * The index of one destination: the entries in memory plus the rules for
 * getting them to disk without ever losing the previous copy.
 *
 * Mutations only mark the index dirty; a debounced save serialises the whole
 * map to `<file>.tmp` and renames it over the real file, so a crash mid-write
 * leaves the last complete index rather than a truncated one. A failed rename
 * is retried briefly, then the `.tmp` is removed and the save rescheduled. An
 * index whose file could not be read or parsed at load time starts empty but
 * never overwrites that file: the first save moves it to
 * `<file>.corrupt-<timestamp>` and only then writes.
 *
 * Key lifecycle methods:
 * - {@link get} / {@link set} / {@link remove} / {@link rename} read and change
 *   entries by relative path, case-insensitively where the filesystem is.
 * - {@link save} writes now and settles with the write; the debounced path
 *   calls it too and logs its failure.
 */
export class SyncIndex {
  readonly key: string;

  // folded relPath -> entry with its original casing, so lookups are
  // case-insensitive where the filesystem is, and the view shows the real name
  private _entries = new Map<string, { relPath: string; entry: IndexEntry }>();
  private _dirty = false;
  private _saveTimer: any = null;
  // writes are chained so two overlapping saves never race on the .tmp file
  private _writeChain: Promise<void> = Promise.resolve();
  // set when the file on disk could not be read or parsed: what is there may
  // be the only copy of a real index, so the first write moves it aside first
  private _loadFailed = false;
  private _preservedOriginal = false;
  private _consecutiveFailures = 0;
  // see isSeeded(); persisted with the entries, absent until the index is built
  private _seededAt: number | undefined;

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

  /**
   * True when the file on disk was unreadable or unparsable at load time. The
   * index then started empty, and its first save keeps that file aside.
   */
  get loadFailed(): boolean {
    return this._loadFailed;
  }

  /**
   * Whether the index is known to cover the whole local tree (it was rebuilt
   * from the server, or a confirmed manual scan went through). An index that
   * only grew from individual uploads is not: a file it lacks may have been on
   * the server all along, so automatic scans must not upload it unasked.
   */
  isSeeded(): boolean {
    return this._seededAt !== undefined;
  }

  /** ms epoch of the seeding, or undefined while the index is not seeded. */
  get seededAt(): number | undefined {
    return this._seededAt;
  }

  /** Records that the index covers the tree; persisted with the entries. */
  markSeeded(at: number = Date.now()): void {
    this._seededAt = at;
    this._markDirty();
  }

  /** Drops every entry; the seeded mark is kept (a rebuild clears, refills and re-marks). */
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
  _load(entries: { [relPath: string]: IndexEntry }, seededAt?: number): void {
    this._entries.clear();
    Object.keys(entries).forEach(relPath => {
      const normalized = normalizeRelPath(relPath);
      this._entries.set(foldCase(normalized), { relPath: normalized, entry: entries[relPath] });
    });
    // a file written before the mark existed has none: such an index is not
    // seeded, whatever its size, until the user builds it
    this._seededAt = typeof seededAt === 'number' ? seededAt : undefined;
    this._dirty = false;
  }

  /** Flags the file on disk as unreadable; see {@link loadFailed}. */
  _markLoadFailed(): void {
    this._loadFailed = true;
  }

  /** Drops a pending debounced save. Used when the module is reset. */
  _dispose(): void {
    this._cancelScheduledSave();
  }

  private _markDirty() {
    this._dirty = true;
    this._scheduleSave();
  }

  /**
   * Re-arms a pending debounced save with the current delay. Called when the
   * last hold is released, so a save armed for a minute lands in a second.
   */
  _rescheduleSave(): void {
    if (!this._saveTimer || !this._dirty) {
      return;
    }
    this._cancelScheduledSave();
    this._scheduleSave();
  }

  private _scheduleSave() {
    if (!this._filePath || this._saveTimer) {
      return;
    }

    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save().catch(error => logger.error(error, `save sync index ${this.key}`));
    }, saveHolds > 0 ? SAVE_DEBOUNCE_HELD_MS : SAVE_DEBOUNCE_MS);

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
    if (this._seededAt !== undefined) {
      data.seededAt = this._seededAt;
    }
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
      await this._preserveUnreadableOriginal(filePath);
      await fsPromises.writeFile(tmpPath, JSON.stringify(data), 'utf8');
      await this._replaceWithRetries(tmpPath, filePath);
      this._consecutiveFailures = 0;
    } catch (error) {
      this._dirty = true;
      throw error;
    }
  }

  /**
   * Moves an index file that failed to load out of the way, once, before the
   * first write over it. Throws when it cannot: overwriting what may be the
   * only copy of the real index is the one outcome to avoid.
   */
  private async _preserveUnreadableOriginal(filePath: string): Promise<void> {
    if (!this._loadFailed || this._preservedOriginal) {
      return;
    }

    const keptAs = `${filePath}.corrupt-${Date.now()}`;
    try {
      await fsPromises.rename(filePath, keptAs);
      logger.warn(`[sync-index] kept the unreadable ${filePath} as ${keptAs}`);
    } catch (error) {
      // gone in the meantime: nothing left to preserve
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
    this._preservedOriginal = true;
  }

  /**
   * Renames `.tmp` over the index file, retrying the transient failures. When
   * the retries run out, the `.tmp` is removed (never left as an orphan), the
   * entries stay dirty and another save is scheduled — bounded by
   * {@link MAX_AUTO_RETRIES} in a row — before the error is rethrown.
   */
  private async _replaceWithRetries(tmpPath: string, filePath: string): Promise<void> {
    let lastError: any;
    const attempts = RENAME_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        await delay(RENAME_RETRY_DELAYS_MS[attempt - 2]);
      }
      try {
        await fsPromises.rename(tmpPath, filePath);
        return;
      } catch (error) {
        lastError = error;
        logger.debug(
          `[sync-index] rename over ${filePath} failed (${error.message}), attempt ${attempt} of ${attempts}`
        );
      }
    }

    await fsPromises.unlink(tmpPath).catch(() => undefined);
    this._dirty = true;
    this._consecutiveFailures++;
    if (this._consecutiveFailures <= MAX_AUTO_RETRIES) {
      this._scheduleSave();
      logger.warn(`[sync-index] cannot replace ${filePath}: ${lastError.message}; will retry`);
    } else {
      logger.warn(
        `[sync-index] cannot replace ${filePath}: ${lastError.message}; giving up until the next change`
      );
    }
    throw lastError;
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

/**
 * Reads an index file. A missing file is the normal first run; anything else
 * that stops the load (EACCES, corrupt or unexpected JSON) starts the index
 * empty *and flags it*, so its first save keeps the file aside instead of
 * overwriting what may be the only copy — see {@link SyncIndex.loadFailed}.
 */
async function loadFromDisk(key: string, filePath: string): Promise<SyncIndex> {
  const index = new SyncIndex(key, filePath);
  const keptAside = 'starting empty; the file is kept aside before the next write';

  let raw: string;
  try {
    raw = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return index;
    }
    logger.warn(`[sync-index] cannot read ${filePath} (${error.message}); ${keptAside}`);
    index._markLoadFailed();
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
      logger.warn(`[sync-index] ${filePath} has an unexpected format; ${keptAside}`);
      index._markLoadFailed();
      return index;
    }

    index._load(parsed.entries, parsed.seededAt);
  } catch (error) {
    // an unparsable index is unrecoverable for us; starting empty only costs a
    // re-upload of files that haven't changed, which the next verified upload
    // records again. The copy is kept for whoever wants to look at it.
    logger.warn(`[sync-index] ${filePath} is corrupt (${error.message}); ${keptAside}`);
    index._markLoadFailed();
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
 * Slows the debounced saves of every index down to one per minute until the
 * returned function is called (once; further calls are no-ops). Long runs
 * hold the saves while they upload: each verified file marks the index dirty,
 * and a big index serialised every second for the length of the run was
 * measurable on the extension host. Explicit `save()` calls are unaffected,
 * and releasing the last hold re-arms a pending save with the normal delay.
 */
export function holdSyncIndexSaves(): () => void {
  saveHolds++;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    saveHolds--;
    if (saveHolds === 0) {
      loaded.forEach(index => index._rescheduleSave());
    }
  };
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
  saveHolds = 0;
}

// exported for tests
export const testHooks = {
  SAVE_DEBOUNCE_MS,
  SAVE_DEBOUNCE_HELD_MS,
};
