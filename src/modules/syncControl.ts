import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import logger from '../logger';
import { STATE_KEY_SYNC_PAUSED } from '../constants';

/**
 * The kill switch and the mute button for every *automatic* transfer.
 *
 * Two independent mechanisms live here:
 *
 * - **Pause** is the user's decision, persisted per workspace. While paused,
 *   automatic paths (uploadOnSave, the watcher, the local-delete monitor,
 *   rename mirroring) do nothing; explicit commands still run, because an
 *   explicit command *is* the user overriding the pause.
 * - **Suppression** is the extension protecting itself. A `Sync Remote -> Local`
 *   with `syncOption.delete` removes local files; without suppression the
 *   watcher would see those deletions and mirror them straight back to the
 *   server, destroying what was just synced. Suppression is reference counted
 *   because transfers overlap.
 */

type Listener = () => void;

let extensionContext: vscode.ExtensionContext | null = null;
let paused = false;
let suppressionDepth = 0;
const listeners: Listener[] = [];

function notify() {
  listeners.forEach(listener => {
    try {
      listener();
    } catch (error) {
      logger.error(error, 'syncControl listener');
    }
  });
}

export function initSyncControl(context: vscode.ExtensionContext) {
  extensionContext = context;
  paused = Boolean(context.workspaceState.get(STATE_KEY_SYNC_PAUSED));
  if (paused) {
    logger.info('[sync-control] automatic sync is paused (restored from workspace state)');
  }
  notify();
}

export function isPaused(): boolean {
  return paused;
}

export function setPaused(next: boolean) {
  if (paused === next) {
    return;
  }

  paused = next;
  logger.info(`[sync-control] automatic sync ${next ? 'paused' : 'resumed'}`);
  if (extensionContext) {
    // fire and forget: losing the persisted flag is harmless, the default is
    // "not paused" and the status bar always shows the live value
    Promise.resolve(extensionContext.workspaceState.update(STATE_KEY_SYNC_PAUSED, next)).then(
      undefined,
      error => logger.error(error, 'persist sync pause state')
    );
  }
  notify();
}

export function togglePaused(): boolean {
  setPaused(!paused);
  return paused;
}

export function onDidChangePauseState(listener: Listener): vscode.Disposable {
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

export function isSuppressed(): boolean {
  return suppressionDepth > 0;
}

/**
 * Runs `task` with local filesystem events ignored by the automatic paths.
 *
 * The trailing delay matters: `FileSystemWatcher` events arrive after the
 * syscall completes, so releasing suppression the instant the transfer resolves
 * would let the tail of the event burst through.
 */
export async function suppressAutoSync<T>(task: () => Promise<T>): Promise<T> {
  suppressionDepth += 1;
  try {
    return await task();
  } finally {
    setTimeout(() => {
      suppressionDepth = Math.max(0, suppressionDepth - 1);
    }, SUPPRESSION_TAIL_MS);
  }
}

// long enough to cover the watcher debounce (550ms) plus event delivery
const SUPPRESSION_TAIL_MS = 1500;

/**
 * True while git is rewriting the working tree.
 *
 * A checkout, rebase, merge or stash can delete hundreds of files in a burst
 * that is indistinguishable, at the filesystem level, from the user deleting
 * them. Git holds `index.lock` for the duration of those operations, and leaves
 * marker files for the multi-step ones, so their presence is a reliable
 * "don't mirror deletions right now" signal.
 */
export function isGitOperationInProgress(startDir: string): boolean {
  const gitDir = findGitDir(startDir);
  if (!gitDir) {
    return false;
  }

  const markers = [
    'index.lock',
    'MERGE_HEAD',
    'REBASE_HEAD',
    'rebase-merge',
    'rebase-apply',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
  ];

  return markers.some(marker => {
    try {
      return fs.existsSync(path.join(gitDir, marker));
    } catch (error) {
      return false;
    }
  });
}

/**
 * Identity of the checked-out commit, or null outside a repo.
 *
 * The marker files above only exist *while* git runs. A plain `git checkout`
 * finishes in well under the batching delay, so by the time the deletions are
 * processed there is nothing left to detect. What does survive is the change of
 * HEAD: capturing it when the deletion is queued and comparing it when the
 * batch runs catches exactly the case the markers miss.
 */
export function readGitHead(startDir: string): string | null {
  const gitDir = findGitDir(startDir);
  if (!gitDir) {
    return null;
  }

  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) {
      // detached HEAD: the file already holds the commit id
      return head;
    }

    try {
      return fs.readFileSync(path.join(gitDir, ref[1]), 'utf8').trim();
    } catch (error) {
      // packed refs, or a branch with no commits yet; the ref name still
      // changes on checkout, which is what we compare
      return ref[1];
    }
  } catch (error) {
    return null;
  }
}

function findGitDir(startDir: string): string | null {
  let current = path.resolve(startDir);

  // walk up to the filesystem root looking for .git
  for (let depth = 0; depth < 64; depth++) {
    const candidate = path.join(current, '.git');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
      if (stat.isFile()) {
        // worktree or submodule: ".git" is a file pointing at the real dir
        const content = fs.readFileSync(candidate, 'utf8');
        const match = /^gitdir:\s*(.+)$/m.exec(content);
        if (match) {
          const resolved = match[1].trim();
          return path.isAbsolute(resolved) ? resolved : path.join(current, resolved);
        }
      }
    } catch (error) {
      // not here, keep walking
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }

  return null;
}

// test seam: the module keeps process-wide state
export function __resetForTest() {
  extensionContext = null;
  paused = false;
  suppressionDepth = 0;
  listeners.length = 0;
}
