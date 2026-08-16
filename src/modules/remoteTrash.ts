import * as vscode from 'vscode';
import logger from '../logger';
import app from '../app';
import { upath, FileService, ServiceConfig, FileType } from '../core';
import { resolveRemoteTrashConfig } from '../core/fileService';
import { STATE_KEY_TRASH_INDEX } from '../constants';
import { isNotFoundError } from '../helper';

/**
 * A holding area on the server for files this extension deletes.
 *
 * Automatic deletion mirroring is only defensible if it is reversible. Instead
 * of `unlink`, a deletion renames the remote path under a trash directory,
 * preserving its path relative to `remotePath` so the original location can be
 * reconstructed exactly. Renames are cheap and server-side, so this costs
 * nothing in bandwidth — unlike a download-before-delete backup.
 *
 * The index lives in workspaceState rather than on the server: it must survive
 * a lost connection, and writing it remotely would need another round trip per
 * deletion.
 */

export interface TrashEntry {
  id: string;
  /** where the file was before it was deleted */
  originalRemotePath: string;
  /** where it sits now, inside the trash directory */
  trashRemotePath: string;
  /** the local path it mirrored, when the deletion came from a local one */
  localPath?: string;
  /** FileService.baseDir, used to find the service again on restore */
  serviceBaseDir: string;
  serviceName?: string;
  profile?: string | null;
  deletedAt: number;
  isDirectory: boolean;
  /** folder name shared by every entry deleted in the same batch */
  batchStamp: string;
}

const MAX_INDEX_ENTRIES = 200;

let extensionContext: vscode.ExtensionContext | null = null;
let index: TrashEntry[] = [];
const listeners: Array<() => void> = [];

export function initRemoteTrash(context: vscode.ExtensionContext) {
  extensionContext = context;
  const stored = context.workspaceState.get<TrashEntry[]>(STATE_KEY_TRASH_INDEX);
  index = Array.isArray(stored) ? stored : [];
  notify();
}

function notify() {
  listeners.forEach(listener => {
    try {
      listener();
    } catch (error) {
      logger.error(error, 'remoteTrash listener');
    }
  });
}

export function onDidChangeTrash(listener: () => void): vscode.Disposable {
  listeners.push(listener);
  return {
    dispose() {
      const i = listeners.indexOf(listener);
      if (i !== -1) {
        listeners.splice(i, 1);
      }
    },
  };
}

function persist() {
  if (!extensionContext) {
    return;
  }

  Promise.resolve(extensionContext.workspaceState.update(STATE_KEY_TRASH_INDEX, index)).then(
    undefined,
    error => logger.error(error, 'persist trash index')
  );
}

/**
 * Absolute remote path of the trash directory.
 *
 * A leading "/" makes it absolute on the server, which is how a user puts the
 * trash outside a web-served document root — the common reason to move it.
 */
export function resolveTrashRoot(config: ServiceConfig): string {
  const trash = resolveRemoteTrashConfig(config);
  const root =
    trash.path.charAt(0) === '/'
      ? upath.normalize(trash.path)
      : upath.join(config.remotePath, trash.path);

  assertSafeTrashRoot(root, config.remotePath);
  return root;
}

/**
 * Refuses a trash root that would make emptying it destroy real data.
 *
 * `"path": "."` resolves straight back to `remotePath`, and `Empty Remote Trash`
 * would then `rmdir` the document root recursively. `"/"` is worse. A root that
 * is an ancestor of `remotePath` has the same problem, and one equal to it also
 * makes `isInsideTrash` true for everything, quietly turning every deletion
 * into a hard one.
 */
function assertSafeTrashRoot(root: string, remotePath: string) {
  const normalizedRoot = upath.normalize(root).replace(/\/+$/, '');
  const normalizedRemote = upath.normalize(remotePath).replace(/\/+$/, '');

  const isRootOfServer = normalizedRoot === '' || normalizedRoot === '/';
  const isRemoteItself = normalizedRoot === normalizedRemote;
  const containsRemote =
    normalizedRoot !== '' && normalizedRemote.indexOf(normalizedRoot + '/') === 0;

  if (isRootOfServer || isRemoteItself || containsRemote) {
    throw new Error(
      `Unsafe "remoteTrash.path": it resolves to "${normalizedRoot || '/'}", which contains ` +
        `"${normalizedRemote}". Emptying the trash would delete your files. ` +
        'Use a subfolder of remotePath, or an absolute path outside it.'
    );
  }
}

export function isTrashEnabled(config: ServiceConfig): boolean {
  return resolveRemoteTrashConfig(config).enabled;
}

/** True when the path is inside the trash, so callers never recurse into it. */
export function isInsideTrash(remotePath: string, config: ServiceConfig): boolean {
  const root = resolveTrashRoot(config);
  const normalized = upath.normalize(remotePath);
  return normalized === root || normalized.indexOf(root + '/') === 0;
}

/**
 * Name of the per-batch folder inside the trash.
 *
 * Exported so the delete monitor stamps a whole batch identically instead of
 * rolling its own format — two formats in one trash directory made batches
 * impossible to group, and a coarser one made two deletions of the same file
 * collide on the same path.
 */
export function trashBatchStamp(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
  );
}

/**
 * Moves a remote path into the trash. Returns null when trash is disabled, so
 * the caller falls back to a real delete.
 *
 * Throws only when the move itself fails in a way the caller should know about;
 * the caller decides whether to hard-delete instead.
 */
export async function moveToTrash(
  fileService: FileService,
  config: ServiceConfig,
  remoteFsPath: string,
  option: { localPath?: string; batchStamp?: string } = {}
): Promise<TrashEntry | null> {
  if (!isTrashEnabled(config)) {
    return null;
  }

  if (isInsideTrash(remoteFsPath, config)) {
    // deleting from within the trash is a purge, not a new trashing
    return null;
  }

  const remoteFs = await fileService.getRemoteFileSystem(config);
  const stat = await remoteFs.lstat(remoteFsPath);
  const isDirectory = stat.type === FileType.Directory;

  const trashRoot = resolveTrashRoot(config);
  const stamp = option.batchStamp || trashBatchStamp(new Date());
  // keep the path relative to remotePath so a restore is unambiguous even when
  // two files share a basename
  const relative = upath.relative(config.remotePath, remoteFsPath);

  // A path that resolves outside remotePath would make upath.join climb back
  // out of the trash directory and rename the file somewhere arbitrary on the
  // server. Throwing rather than returning null is deliberate: null means
  // "trash is off, delete normally", and deleting a path we just judged
  // suspicious is the one thing that must not happen here.
  if (!relative || relative === '..' || relative.indexOf('../') === 0) {
    throw new Error(
      `Refusing to delete "${remoteFsPath}": it resolves outside remotePath ` +
        `("${config.remotePath}"), so it cannot be safely mapped into the trash.`
    );
  }

  const trashRemotePath = upath.join(trashRoot, stamp, relative);

  await remoteFs.ensureDir(upath.dirname(trashRemotePath));
  await remoteFs.rename(remoteFsPath, trashRemotePath);

  const entry: TrashEntry = {
    id: `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    originalRemotePath: remoteFsPath,
    trashRemotePath,
    localPath: option.localPath,
    serviceBaseDir: fileService.baseDir,
    serviceName: fileService.name,
    profile: app.state.profile,
    deletedAt: Date.now(),
    isDirectory,
    batchStamp: stamp,
  };

  index.unshift(entry);
  if (index.length > MAX_INDEX_ENTRIES) {
    index.length = MAX_INDEX_ENTRIES;
  }
  persist();
  notify();

  logger.info(`[trash] ${remoteFsPath} -> ${trashRemotePath}`);
  return entry;
}

export function getTrashEntries(): TrashEntry[] {
  return index.slice();
}

export function getLastTrashEntries(): TrashEntry[] {
  if (index.length === 0) {
    return [];
  }

  // Entries deleted together share a batch stamp. Deriving the batch from the
  // trash path instead used two nested dirname() calls, which widened to the
  // whole trash when the newest file sat at the root of remotePath and narrowed
  // to one subtree when it was nested.
  const newest = index[0];
  return index.filter(
    entry =>
      entry.serviceBaseDir === newest.serviceBaseDir &&
      entry.batchStamp === newest.batchStamp &&
      entry.profile === newest.profile
  );
}

/** Restores one entry to its original remote path. */
export async function restoreFromTrash(
  entry: TrashEntry,
  fileService: FileService,
  config: ServiceConfig
): Promise<void> {
  const remoteFs = await fileService.getRemoteFileSystem(config);

  let occupied = false;
  try {
    await remoteFs.lstat(entry.originalRemotePath);
    occupied = true;
  } catch (error) {
    // Only a genuinely missing path means "nothing is in the way". A timeout or
    // a permission error here would otherwise read as free, and over FTP a
    // RNFR/RNTO onto an existing path silently overwrites it.
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  if (occupied) {
    throw new Error(
      `Cannot restore: "${entry.originalRemotePath}" already exists on the server. ` +
        'Remove or rename it first.'
    );
  }

  await remoteFs.ensureDir(upath.dirname(entry.originalRemotePath));
  await remoteFs.rename(entry.trashRemotePath, entry.originalRemotePath);

  removeFromIndex(entry.id);
  logger.info(`[trash] restored ${entry.originalRemotePath}`);
}

export function removeFromIndex(id: string) {
  const i = index.findIndex(entry => entry.id === id);
  if (i !== -1) {
    index.splice(i, 1);
    persist();
    notify();
  }
}

export function forgetService(baseDir: string) {
  const before = index.length;
  index = index.filter(entry => entry.serviceBaseDir !== baseDir);
  if (index.length !== before) {
    persist();
    notify();
  }
}

/**
 * Deletes trashed items older than `retentionDays`.
 *
 * Best effort by design: it runs on activation, and a server that is down or a
 * path already gone by other means must not surface as an error to the user.
 */
/**
 * Groups a service's entries by the profile they were deleted under.
 *
 * Every trash operation has to run against the server the file actually came
 * from. Resolving the config with whatever profile happens to be active would
 * connect to a different host: the purge would fail there, and a restore would
 * recreate the deleted file's directory tree on the wrong server.
 */
function entriesByProfile(
  baseDir: string,
  predicate: (entry: TrashEntry) => boolean
): Map<string | null, TrashEntry[]> {
  const grouped = new Map<string | null, TrashEntry[]>();

  index
    .filter(entry => entry.serviceBaseDir === baseDir && predicate(entry))
    .forEach(entry => {
      const key = entry.profile === undefined ? null : entry.profile;
      const bucket = grouped.get(key);
      if (bucket) {
        bucket.push(entry);
      } else {
        grouped.set(key, [entry]);
      }
    });

  return grouped;
}

export async function purgeExpired(fileService: FileService): Promise<number> {
  let purged = 0;

  const groups = entriesByProfile(fileService.baseDir, () => true);
  for (const [profile, entries] of Array.from(groups.entries())) {
    let config: ServiceConfig;
    try {
      config = fileService.getConfig(profile as any);
    } catch (error) {
      // the profile is gone from sftp.json; keep the entries rather than
      // silently dropping files we can no longer reach
      logger.debug(`[trash] purge skipped for profile ${profile}: ${error.message}`);
      continue;
    }

    const { retentionDays } = resolveRemoteTrashConfig(config);
    if (!retentionDays) {
      continue;
    }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const expired = entries.filter(entry => entry.deletedAt < cutoff);
    if (expired.length === 0) {
      continue;
    }

    const remoteFs = await fileService.getRemoteFileSystem(config);

    // Sweep the trash directory itself, not just the index. Entries pushed out
    // of the index by MAX_INDEX_ENTRIES would otherwise sit on the server for
    // ever: unreachable for a restore and invisible to a purge.
    await purgeExpiredBatchFolders(remoteFs, resolveTrashRoot(config), retentionDays);

    for (const entry of expired) {
      try {
        if (entry.isDirectory) {
          await remoteFs.rmdir(entry.trashRemotePath, true);
        } else {
          await remoteFs.unlink(entry.trashRemotePath);
        }
        purged++;
        removeFromIndex(entry.id);
      } catch (error) {
        if (isNotFoundError(error)) {
          // already gone by other means: the entry is dead weight and a restore
          // would fail anyway
          removeFromIndex(entry.id);
          continue;
        }

        // a network or permission failure must not orphan the file: keep the
        // entry so the next activation retries it
        logger.debug(`[trash] purge deferred for ${entry.trashRemotePath}: ${error.message}`);
      }
    }
  }

  if (purged > 0) {
    logger.info(`[trash] purged ${purged} expired item(s)`);
  }
  return purged;
}

/** Empties the trash directory of one service, across all of its profiles. */
export async function emptyTrash(fileService: FileService): Promise<void> {
  const profiles = Array.from(entriesByProfile(fileService.baseDir, () => true).keys());
  // with no tracked entries there is still a trash directory to clear, under
  // whichever profile is current
  const targets = profiles.length > 0 ? profiles : [app.state.profile];

  for (const profile of targets) {
    let config: ServiceConfig;
    try {
      config = fileService.getConfig(profile as any);
    } catch (error) {
      logger.debug(`[trash] empty skipped for profile ${profile}: ${error.message}`);
      continue;
    }

    const remoteFs = await fileService.getRemoteFileSystem(config);
    const trashRoot = resolveTrashRoot(config);

    try {
      await remoteFs.rmdir(trashRoot, true);
    } catch (error) {
      // an empty or absent trash is not an error worth reporting
      logger.debug(`[trash] empty: ${error.message}`);
    }
  }

  forgetService(fileService.baseDir);
}

/**
 * Removes whole batch folders older than the retention window.
 *
 * The folder name is the batch timestamp, so the server itself carries the age
 * of its contents and the sweep needs no index. Anything that doesn't parse as
 * a timestamp is left alone — it wasn't put there by this extension.
 */
async function purgeExpiredBatchFolders(
  remoteFs: any,
  trashRoot: string,
  retentionDays: number
): Promise<void> {
  let entries: Array<{ name: string; fspath: string }>;
  try {
    entries = await remoteFs.list(trashRoot);
  } catch (error) {
    // no trash directory yet, or it is unreachable; nothing to sweep
    return;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    const at = parseBatchStamp(entry.name);
    if (at === null || at >= cutoff) {
      continue;
    }

    try {
      await remoteFs.rmdir(entry.fspath, true);
      logger.info(`[trash] purged expired batch ${entry.name}`);
    } catch (error) {
      logger.debug(`[trash] could not purge batch ${entry.name}: ${error.message}`);
    }
  }
}

/** Epoch millis encoded in a `YYYYMMDD-HHmmss` folder name, or null. */
export function parseBatchStamp(name: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  const when = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );

  // Date rolls out-of-range components over instead of rejecting them, so
  // "20261345-995999" would silently become a valid, differently-dated folder.
  // This sweep deletes folders recursively, so it only accepts a name that
  // reads back exactly as it was written.
  const roundTrips =
    when.getFullYear() === Number(year) &&
    when.getMonth() === Number(month) - 1 &&
    when.getDate() === Number(day) &&
    when.getHours() === Number(hour) &&
    when.getMinutes() === Number(minute) &&
    when.getSeconds() === Number(second);

  return roundTrips ? when.getTime() : null;
}

/** Trash roots of every profile that has entries, for the confirmation dialog. */
export function listTrashRoots(fileService: FileService): string[] {
  const profiles = Array.from(entriesByProfile(fileService.baseDir, () => true).keys());
  const targets = profiles.length > 0 ? profiles : [app.state.profile];
  const roots: string[] = [];

  targets.forEach(profile => {
    try {
      const root = resolveTrashRoot(fileService.getConfig(profile as any));
      if (roots.indexOf(root) === -1) {
        roots.push(root);
      }
    } catch (error) {
      logger.debug(`[trash] cannot resolve trash root for profile ${profile}: ${error.message}`);
    }
  });

  return roots;
}

// test seam: the module keeps process-wide state
export function __resetForTest() {
  extensionContext = null;
  index = [];
  listeners.length = 0;
}
