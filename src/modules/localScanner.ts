import * as path from 'path';
import logger from '../logger';
import upath from '../core/upath';
import fsPromises, { DirEntry } from '../helper/fsPromises';

/**
 * Walks a local directory tree and reports every file with its size and mtime.
 *
 * This is the reconciliation half of external-change detection: watchers miss
 * whatever happened while VS Code was closed, so on activation (and on demand)
 * the tree is scanned and compared against the sync index. The scanner itself
 * knows nothing about the index or the server — it only produces the local
 * side of that comparison, cheaply and without touching file contents.
 *
 * It goes through node's `fs` rather than `vscode.workspace.findFiles` so the
 * service's `ignore` function can prune whole subtrees before they are read
 * (findFiles would list `node_modules` and filter afterwards), and so memfs can
 * stand in for the filesystem in tests.
 *
 * Key lifecycle methods:
 * - {@link scanLocalTree} runs one scan; cooperative cancellation and progress
 *   reporting are passed in via {@link ScanOptions}.
 */

export interface LocalFileRecord {
  fsPath: string;
  size: number;
  /** mtime in ms */
  mtime: number;
}

export interface ScanOptions {
  /**
   * The service's `config.ignore`: receives an absolute path and returns true
   * to skip it. Applied to directories too, which prunes the whole subtree;
   * they are flagged as such so `dir/` patterns can match them.
   */
  ignore?: ((fsPath: string, isDirectory?: boolean) => boolean) | null;
  /** directories read in parallel; default {@link DEFAULT_CONCURRENCY} */
  concurrency?: number;
  /** polled between directories; once true the scan stops and returns what it has */
  isCancelled?: () => boolean;
  onProgress?: (scannedFiles: number, scannedDirs: number) => void;
  /**
   * Follow symbolic links (default false). Off, a link is neither listed as a
   * file nor descended into: a link to a parent would loop, and uploading the
   * target's content under the link's name is rarely what the user meant.
   * On, a link whose target is one of the directories on the way down to it
   * (an ancestor, or a link back to one) is skipped, so a loop is cut where
   * it starts instead of at ENAMETOOLONG.
   */
  followSymlinks?: boolean;
}

export interface ScanResult {
  files: LocalFileRecord[];
  /** directories actually read (the root counts) */
  dirs: number;
  cancelled: boolean;
  durationMs: number;
}

const DEFAULT_CONCURRENCY = 8;

// windows and macOS both default to case-insensitive filesystems, so two real
// paths that differ only in case are the same directory there
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * One directory waiting to be read. `real` is its canonical path (links
 * resolved) and `parent` the directory it was found in, so the chain of
 * parents is the list of real directories on the way down to it.
 */
export interface PendingDir {
  dir: string;
  real: string;
  parent: PendingDir | null;
}

// one spelling for the comparison: "/" separators whatever realpath and
// path.join produced, case folded where the filesystem does not care
function comparable(fsPath: string): string {
  const unix = upath.toUnix(fsPath).replace(/\/+$/, '');
  return CASE_INSENSITIVE_FS ? unix.toLowerCase() : unix;
}

function isAncestorOrSelf(ancestor: string, descendant: string): boolean {
  const a = comparable(ancestor);
  const d = comparable(descendant);
  return d === a || d.indexOf(a + '/') === 0;
}

/**
 * Whether entering the directory at `targetReal` from `from` would loop: true
 * when `targetReal` is, or contains, any directory on the chain from the scan
 * root down to `from`. A link to a sibling or to an unrelated tree is not a
 * loop and is followed (its content may then be listed twice, once under each
 * name, which is what "follow symlinks" means).
 */
export function wouldLoop(targetReal: string, from: PendingDir | null): boolean {
  for (let node = from; node; node = node.parent) {
    if (isAncestorOrSelf(targetReal, node.real)) {
      return true;
    }
  }
  return false;
}

/**
 * Scans `baseDir` recursively.
 *
 * Never rejects because of the tree itself: an unreadable directory or a file
 * that vanishes mid-scan is logged at debug level and skipped, so one locked
 * folder can't abort a 50k-file reconciliation. A missing `baseDir` likewise
 * yields an empty result.
 */
export async function scanLocalTree(
  baseDir: string,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const startedAt = Date.now();
  const concurrency = Math.max(1, options.concurrency || DEFAULT_CONCURRENCY);
  const ignore = options.ignore || null;
  const isCancelled = options.isCancelled || (() => false);
  const followSymlinks = Boolean(options.followSymlinks);

  const files: LocalFileRecord[] = [];
  let dirs = 0;
  let cancelled = false;

  const rootDir = path.resolve(baseDir);
  // the root's real path seeds the loop check: a link back to the base dir
  // itself is the most common loop. Only needed when links are followed; a
  // missing base dir has no real path and yields an empty scan anyway.
  let rootReal = rootDir;
  if (followSymlinks) {
    try {
      rootReal = await fsPromises.realpath(rootDir);
    } catch (error) {
      logger.debug(`[scan] cannot resolve ${rootDir}: ${error.message}`);
    }
  }

  // directories still to read; a plain stack rather than a queue keeps the
  // traversal depth-first-ish, so memory stays bounded by tree depth times fan-out
  const pending: PendingDir[] = [{ dir: rootDir, real: rootReal, parent: null }];

  const report = () => {
    if (options.onProgress) {
      options.onProgress(files.length, dirs);
    }
  };

  const readDir = async (node: PendingDir): Promise<void> => {
    const dir = node.dir;
    let entries: DirEntry[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      logger.debug(`[scan] cannot read ${dir}: ${error.message}`);
      return;
    }
    dirs++;

    for (const entry of entries) {
      const fsPath = path.join(dir, entry.name);

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      // a plain subdirectory's real path is its parent's plus the name; only
      // a followed link needs the filesystem to say where it really goes
      let real = path.join(node.real, entry.name);

      if (entry.isSymbolicLink()) {
        if (!followSymlinks) {
          continue;
        }

        // stat follows the link; a dangling one is simply skipped
        try {
          const target = await fsPromises.stat(fsPath);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
          if (isDirectory) {
            real = await fsPromises.realpath(fsPath);
          }
        } catch (error) {
          logger.debug(`[scan] cannot resolve link ${fsPath}: ${error.message}`);
          continue;
        }
      }

      if (!isDirectory && !isFile) {
        // sockets, fifos, devices: nothing to upload
        continue;
      }

      if (ignore && ignore(fsPath, isDirectory)) {
        continue;
      }

      if (isDirectory) {
        if (entry.isSymbolicLink() && wouldLoop(real, node)) {
          logger.debug(`[scan] not following ${fsPath}: ${real} is already on the way here`);
          continue;
        }
        pending.push({ dir: fsPath, real, parent: node });
        continue;
      }

      try {
        // the directory entry doesn't carry size/mtime; one stat per file is
        // the price of the comparison. `stat` rather than `lstat` so a followed
        // link reports its target's metadata, which is what gets uploaded.
        const stat = followSymlinks ? await fsPromises.stat(fsPath) : await fsPromises.lstat(fsPath);
        files.push({ fsPath, size: stat.size, mtime: stat.mtime.getTime() });
      } catch (error) {
        logger.debug(`[scan] cannot stat ${fsPath}: ${error.message}`);
      }
    }

    report();
  };

  // A bounded pool over `pending`: up to `concurrency` directories are read at
  // once, and each one feeds the directories it finds back into the pool. The
  // scan is over when the pool drains with nothing left to pick up.
  await new Promise<void>(resolve => {
    let active = 0;

    const pump = () => {
      if (!cancelled && isCancelled()) {
        cancelled = true;
      }

      while (!cancelled && active < concurrency && pending.length > 0) {
        const node = pending.pop()!;
        active++;
        readDir(node).then(
          () => {
            active--;
            pump();
          },
          error => {
            // readDir swallows its own errors; this is a guard against a bug,
            // not an expected path — the scan must still terminate
            logger.error(error, `[scan] ${node.dir}`);
            active--;
            pump();
          }
        );
      }

      if (active === 0 && (cancelled || pending.length === 0)) {
        resolve();
      }
    };

    pump();
  });

  return { files, dirs, cancelled, durationMs: Date.now() - startedAt };
}
