import * as path from 'path';
import logger from '../logger';
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

  // directories still to read; a plain stack rather than a queue keeps the
  // traversal depth-first-ish, so memory stays bounded by tree depth times fan-out
  const pending: string[] = [path.resolve(baseDir)];

  const report = () => {
    if (options.onProgress) {
      options.onProgress(files.length, dirs);
    }
  };

  const readDir = async (dir: string): Promise<void> => {
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

      if (entry.isSymbolicLink()) {
        if (!followSymlinks) {
          continue;
        }

        // stat follows the link; a dangling one is simply skipped
        try {
          const target = await fsPromises.stat(fsPath);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
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
        pending.push(fsPath);
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
        const dir = pending.pop()!;
        active++;
        readDir(dir).then(
          () => {
            active--;
            pump();
          },
          error => {
            // readDir swallows its own errors; this is a guard against a bug,
            // not an expected path — the scan must still terminate
            logger.error(error, `[scan] ${dir}`);
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
