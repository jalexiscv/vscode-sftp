import * as path from 'path';
import logger from '../logger';
import fsPromises from '../helper/fsPromises';
import { STATE_KEY_STORAGE_VERSION, STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED } from '../constants';

/**
 * Discards what the extension wrote under the workspace storage — the sync
 * indexes and the activity log — the first time a new version of the
 * extension activates in that workspace.
 *
 * Those files are derived data: the index is rebuilt from the server (or
 * seeded from the local tree) and the log only keeps the last session's
 * retries. Carrying them across versions means carrying whatever a previous
 * version got wrong, and a 4 MB index of a 90k-file tree is loaded and
 * serialised by code that may read it differently now. Starting clean once
 * per upgrade is cheaper than every migration path, and the extension says
 * so in the output channel. The version that wrote the storage is remembered
 * in `workspaceState`; a workspace opened for the first time records the
 * version and removes nothing.
 *
 * Key lifecycle methods:
 * - {@link discardStorageOnVersionChange} runs at activation, before the
 *   index and the log are loaded.
 */

/** The two `Memento` methods used, so tests can pass a plain object. */
export interface StorageMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: any): Thenable<void>;
}

export interface StorageResetOptions {
  /** `context.storageUri.fsPath`; undefined when no workspace is open */
  storagePath: string | undefined;
  /** the installed extension's version; undefined when the host does not say */
  version: string | undefined;
  state: StorageMemento;
}

export interface StorageResetResult {
  /** whether files were removed */
  discarded: boolean;
  /** the version that wrote the storage, when known */
  previousVersion?: string;
  /** the version recorded from now on */
  version?: string;
  /** absolute paths removed */
  removed: string[];
}

// what syncIndex.ts and activityLog.ts write under the storage path; kept
// here as names rather than imported so this module runs before either
const SYNC_INDEX_DIR = 'sync-index';
const ACTIVITY_LOG_FILE = 'activity-log.json';

function isMissing(error: any): boolean {
  return Boolean(error) && error.code === 'ENOENT';
}

async function unlinkQuietly(fsPath: string, removed: string[]): Promise<void> {
  try {
    await fsPromises.unlink(fsPath);
    removed.push(fsPath);
  } catch (error) {
    if (!isMissing(error)) {
      logger.warn(`[storage] cannot remove ${fsPath}: ${error.message}`);
    }
  }
}

/** Empties and removes the sync-index folder; a file that resists is left. */
async function removeSyncIndexes(storagePath: string, removed: string[]): Promise<void> {
  const dir = path.join(storagePath, SYNC_INDEX_DIR);
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (!isMissing(error)) {
      logger.warn(`[storage] cannot list ${dir}: ${error.message}`);
    }
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // nothing of ours; left alone, which also keeps the rmdir below from
      // removing what we did not write
      continue;
    }
    await unlinkQuietly(path.join(dir, entry.name), removed);
  }

  try {
    await fsPromises.rmdir(dir);
  } catch (error) {
    if (!isMissing(error)) {
      logger.debug(`[storage] ${dir} left in place: ${error.message}`);
    }
  }
}

/**
 * Removes the generated files when the installed version differs from the
 * one that wrote them, and records the installed version. Never rejects: a
 * file that cannot be removed is logged and the activation goes on with it.
 */
export async function discardStorageOnVersionChange(
  options: StorageResetOptions
): Promise<StorageResetResult> {
  const { storagePath, version, state } = options;
  const result: StorageResetResult = { discarded: false, removed: [] };
  if (!version) {
    logger.debug('[storage] extension version unknown; generated files kept');
    return result;
  }
  result.version = version;

  const previous = state.get<string>(STATE_KEY_STORAGE_VERSION);
  if (previous === version) {
    result.previousVersion = previous;
    return result;
  }
  if (typeof previous === 'string') {
    result.previousVersion = previous;
  }

  if (storagePath) {
    const root = path.resolve(storagePath);
    await removeSyncIndexes(root, result.removed);
    await unlinkQuietly(path.join(root, ACTIVITY_LOG_FILE), result.removed);
    await unlinkQuietly(path.join(root, ACTIVITY_LOG_FILE + '.tmp'), result.removed);
  }

  if (result.removed.length > 0) {
    result.discarded = true;
    logger.info(
      `[storage] version ${previous || 'before 1.27.0'} -> ${version}: ${result.removed.length} ` +
        'generated file(s) discarded (sync index, activity log); the index starts empty and is ' +
        'rebuilt from the server or seeded from the local tree'
    );
    // the notice about the index not being built is due again: the reason it
    // was dismissed no longer holds
    await Promise.resolve(state.update(STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED, undefined)).then(
      undefined,
      error => logger.error(error, 'reset unbuilt-index notice')
    );
  }

  await Promise.resolve(state.update(STATE_KEY_STORAGE_VERSION, version)).then(undefined, error =>
    logger.error(error, 'record storage version')
  );
  return result;
}

/** The installed version, as the host reports it; undefined on hosts that don't. */
export function extensionVersionOf(context: any): string | undefined {
  const extension = context && context.extension;
  const packageJSON = extension && extension.packageJSON;
  const version = packageJSON && packageJSON.version;
  return typeof version === 'string' && version ? version : undefined;
}
