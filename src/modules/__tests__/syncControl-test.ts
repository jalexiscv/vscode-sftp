jest.mock('fs');

import { vol } from 'memfs';
import * as path from 'path';
import {
  readGitHead,
  isPaused,
  setPaused,
  togglePaused,
  onDidChangePauseState,
  isSuppressed,
  suppressAutoSync,
  isGitOperationInProgress,
  initSyncControl,
  __resetForTest,
} from '../syncControl';

function fakeContext(stored?: boolean) {
  const update = jest.fn().mockResolvedValue(undefined);
  return {
    context: { workspaceState: { get: jest.fn().mockReturnValue(stored), update } } as any,
    update,
  };
}

describe('syncControl', () => {
  beforeEach(() => {
    __resetForTest();
    vol.reset();
  });

  describe('pause state', () => {
    test('starts unpaused and toggles', () => {
      expect(isPaused()).toBe(false);
      expect(togglePaused()).toBe(true);
      expect(isPaused()).toBe(true);
      expect(togglePaused()).toBe(false);
    });

    test('notifies subscribers on change', () => {
      const listener = jest.fn();
      onDidChangePauseState(listener);

      setPaused(true);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    test('setting the same value does not notify', () => {
      const listener = jest.fn();
      onDidChangePauseState(listener);

      setPaused(false);
      expect(listener).not.toHaveBeenCalled();
    });

    test('dispose actually unsubscribes', () => {
      const listener = jest.fn();
      const subscription = onDidChangePauseState(listener);

      subscription.dispose();
      setPaused(true);
      expect(listener).not.toHaveBeenCalled();
    });

    test('restores the persisted state on init', () => {
      const { context } = fakeContext(true);
      initSyncControl(context);
      expect(isPaused()).toBe(true);
    });

    test('persists a change to workspace state', () => {
      const { context, update } = fakeContext(false);
      initSyncControl(context);

      setPaused(true);
      expect(update).toHaveBeenCalledWith('sftp.state.syncPaused', true);
    });
  });

  describe('suppression', () => {
    // legacy timers on purpose: jest's modern implementation tries to hijack
    // `performance`, which is read-only on this node version and throws.
    // Installed once for the block, since a second install without a restore
    // also throws.
    beforeAll(() => jest.useFakeTimers({ legacyFakeTimers: true } as any));
    afterAll(() => jest.useRealTimers());

    test('is active while the task runs', async () => {
      let seenDuringTask: boolean | null = null;

      const pending = suppressAutoSync(async () => {
        seenDuringTask = isSuppressed();
      });

      await pending;
      expect(seenDuringTask).toBe(true);
    });

    test('keeps suppressing for a tail after the task resolves', async () => {
      await suppressAutoSync(async () => undefined);

      // watcher events arrive after the syscall completes, so releasing
      // immediately would let the tail of the burst through
      expect(isSuppressed()).toBe(true);

      jest.advanceTimersByTime(1600);
      expect(isSuppressed()).toBe(false);
    });

    test('is reentrant: an inner task does not release the outer one', async () => {
      await suppressAutoSync(async () => {
        await suppressAutoSync(async () => undefined);
        jest.advanceTimersByTime(1600);
      });

      expect(isSuppressed()).toBe(true);
      jest.advanceTimersByTime(1600);
      expect(isSuppressed()).toBe(false);
    });

    test('releases even when the task throws', async () => {
      await expect(
        suppressAutoSync(async () => {
          throw new Error('transfer blew up');
        })
      ).rejects.toThrow('transfer blew up');

      jest.advanceTimersByTime(1600);
      expect(isSuppressed()).toBe(false);
    });
  });

  describe('isGitOperationInProgress', () => {
    const repo = path.join('c:', 'repo');

    test('is false for a plain directory', () => {
      vol.fromJSON({ [path.join(repo, 'src', 'a.ts')]: 'x' });
      expect(isGitOperationInProgress(path.join(repo, 'src'))).toBe(false);
    });

    test('detects a held index.lock', () => {
      vol.fromJSON({ [path.join(repo, '.git', 'index.lock')]: '' });
      expect(isGitOperationInProgress(repo)).toBe(true);
    });

    test('detects a merge in progress', () => {
      vol.fromJSON({ [path.join(repo, '.git', 'MERGE_HEAD')]: 'abc' });
      expect(isGitOperationInProgress(repo)).toBe(true);
    });

    test('detects an interactive rebase', () => {
      vol.fromJSON({ [path.join(repo, '.git', 'rebase-merge', 'head-name')]: 'x' });
      expect(isGitOperationInProgress(repo)).toBe(true);
    });

    test('walks up from a nested directory', () => {
      vol.fromJSON({
        [path.join(repo, '.git', 'index.lock')]: '',
        [path.join(repo, 'src', 'deep', 'a.ts')]: 'x',
      });
      expect(isGitOperationInProgress(path.join(repo, 'src', 'deep'))).toBe(true);
    });

    test('follows an absolute .git file to the real git dir (worktrees)', () => {
      // path.resolve keeps this absolute on both platforms; "c:/x" is absolute
      // on windows but an ordinary relative folder on linux, where the gitdir
      // then resolved against the repo and pointed nowhere
      const realGitDir = path.resolve(path.sep, 'repo-main', '.git', 'worktrees', 'wt');
      vol.fromJSON({
        [path.join(repo, '.git')]: 'gitdir: ' + realGitDir + '\n',
        [path.join(realGitDir, 'index.lock')]: '',
      });
      expect(isGitOperationInProgress(repo)).toBe(true);
    });

    test('follows a relative .git file to the real git dir (submodules)', () => {
      // what git actually writes for a submodule
      vol.fromJSON({
        [path.join(repo, 'sub', '.git')]: 'gitdir: ../.git/modules/sub\n',
        [path.join(repo, '.git', 'modules', 'sub', 'index.lock')]: '',
      });
      expect(isGitOperationInProgress(path.join(repo, 'sub'))).toBe(true);
    });

    test('is false when git is idle', () => {
      vol.fromJSON({ [path.join(repo, '.git', 'HEAD')]: 'ref: refs/heads/main' });
      expect(isGitOperationInProgress(repo)).toBe(false);
    });
  });

  describe('readGitHead', () => {
    // the marker files only exist *while* git runs; a plain checkout is over
    // long before a deletion batch is processed, and only the HEAD change
    // remains as evidence
    const repo = path.join('c:', 'repo');

    test('is null outside a repository', () => {
      vol.fromJSON({ [path.join(repo, 'a.ts')]: 'x' });
      expect(readGitHead(repo)).toBeNull();
    });

    test('resolves the commit a branch points at', () => {
      vol.fromJSON({
        [path.join(repo, '.git', 'HEAD')]: 'ref: refs/heads/main\n',
        [path.join(repo, '.git', 'refs', 'heads', 'main')]: 'abc123\n',
      });
      expect(readGitHead(repo)).toBe('abc123');
    });

    test('returns the commit directly on a detached HEAD', () => {
      vol.fromJSON({ [path.join(repo, '.git', 'HEAD')]: 'deadbeef\n' });
      expect(readGitHead(repo)).toBe('deadbeef');
    });

    test('falls back to the ref name when the ref file is packed away', () => {
      vol.fromJSON({ [path.join(repo, '.git', 'HEAD')]: 'ref: refs/heads/feature\n' });
      expect(readGitHead(repo)).toBe('refs/heads/feature');
    });

    test('changes when the checked-out branch changes', () => {
      vol.fromJSON({
        [path.join(repo, '.git', 'HEAD')]: 'ref: refs/heads/main\n',
        [path.join(repo, '.git', 'refs', 'heads', 'main')]: 'aaa\n',
        [path.join(repo, '.git', 'refs', 'heads', 'feature')]: 'bbb\n',
      });
      const before = readGitHead(repo);

      vol.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature\n');
      expect(readGitHead(repo)).not.toBe(before);
    });
  });
});
