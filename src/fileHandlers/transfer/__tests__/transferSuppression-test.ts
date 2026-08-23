// The default vscode mock answers every lookup with "Nothing", and that makes
// `x instanceof Uri` true for any x — which is exactly the branch the file
// handlers take to tell a context from a Uri. Give them a real Uri class and
// keep "Nothing" for everything else.
jest.mock('vscode', () => {
  const Nothing = jest.requireActual('../../../../__mocks__/vscode.js');
  class Uri {
    static file(fsPath: string) {
      return new Uri(fsPath);
    }
    readonly scheme = 'file';
    constructor(readonly fsPath: string) {}
    toString() {
      return `file://${this.fsPath}`;
    }
  }
  return new Proxy({ Uri }, { get: (target, key) => (key in target ? target[key] : Nothing) });
});
// the registry is only consulted for Uri contexts; mocking it keeps the
// connection layer (and the fileHandlers <-> serviceManager cycle) out
jest.mock('../../../modules/serviceManager', () => ({ getFileService: jest.fn() }));
// the explorer refresh needs a live remote explorer; here it is irrelevant
jest.mock('../../shared', () => ({ refreshRemoteExplorer: jest.fn() }));

import * as path from 'path';
import { FileType } from '../../../core';
import { isSuppressed, __resetForTest as resetSyncControl } from '../../../modules/syncControl';
import { downloadFile, uploadFile, sync2Local, sync2Remote } from '../index';

/**
 * A download or a remote -> local sync writes (and, with `delete`, removes)
 * local files. The watcher, uploadOnSave and the delete monitor see those
 * events like any user edit, so the handlers that write locally must run
 * under `suppressAutoSync`; the ones that only upload must not, or a real
 * save made meanwhile would be swallowed.
 *
 * Everything below runs on stubbed file systems and a stubbed scheduler: no
 * task is executed, which is what lets legacy fake timers drive the 1.5 s
 * release tail without holding memfs hostage.
 */

const localFile = path.resolve(path.sep, 'local', 'site', 'a.txt');

function fakeStat() {
  return { type: FileType.File, mode: 0o644, mtime: 1000, atime: 1000, size: 1 };
}

// `seen` collects isSuppressed() as observed from inside the handler body
function fakeFs(seen: boolean[]) {
  return {
    pathResolver: path.posix,
    lstat: jest.fn(async () => {
      seen.push(isSuppressed());
      return fakeStat();
    }),
    list: jest.fn(async () => {
      seen.push(isSuppressed());
      return [];
    }),
    ensureDir: jest.fn(async () => undefined),
  } as any;
}

function contextFor(remoteFs: any, localFs: any) {
  const scheduler = {
    add: jest.fn(),
    run: jest.fn(async () => ({ succeeded: [], failed: [], cancelled: [] })),
  };
  return {
    fileService: {
      name: 'staging',
      getRemoteFileSystem: async () => remoteFs,
      getLocalFileSystem: () => localFs,
      createTransferScheduler: () => scheduler,
    } as any,
    config: {
      protocol: 'sftp',
      concurrency: 2,
      remotePath: '/remote',
      host: 'example.test',
      port: 22,
    } as any,
    target: { localFsPath: localFile, remoteFsPath: '/remote/site/a.txt' } as any,
  };
}

// a hair over SUPPRESSION_TAIL_MS (1500)
const PAST_THE_TAIL = 1600;

describe('transfer handlers and automatic-sync suppression', () => {
  // legacy timers on purpose: jest's modern implementation tries to hijack
  // `performance`, which is read-only on this node version and throws.
  // Installed once for the file, since a second install without a restore
  // also throws.
  beforeAll(() => jest.useFakeTimers({ legacyFakeTimers: true } as any));
  afterAll(() => jest.useRealTimers());

  beforeEach(() => {
    resetSyncControl();
  });

  test('a download suppresses while it runs and for the tail after it', async () => {
    const seen: boolean[] = [];
    const ctx = contextFor(fakeFs(seen), fakeFs(seen));
    expect(isSuppressed()).toBe(false);

    await downloadFile(ctx);

    // observed from inside: the remote lstat that collects the task
    expect(seen).toEqual([true]);
    // watcher events arrive after the syscall completes, so the release is
    // delayed; then it really is released
    expect(isSuppressed()).toBe(true);
    jest.advanceTimersByTime(PAST_THE_TAIL);
    expect(isSuppressed()).toBe(false);
  });

  test('a remote -> local sync suppresses while it runs and for the tail after it', async () => {
    const seen: boolean[] = [];
    const ctx = contextFor(fakeFs(seen), fakeFs(seen));

    await sync2Local(ctx);

    // both listings (remote source, local target) ran under suppression
    expect(seen).toEqual([true, true]);
    expect(isSuppressed()).toBe(true);
    jest.advanceTimersByTime(PAST_THE_TAIL);
    expect(isSuppressed()).toBe(false);
  });

  test('a local -> remote sync suppresses only when it also downloads', async () => {
    const seenOneWay: boolean[] = [];
    await sync2Remote(contextFor(fakeFs(seenOneWay), fakeFs(seenOneWay)));
    expect(seenOneWay).toEqual([false, false]);
    expect(isSuppressed()).toBe(false);

    const seenBothWays: boolean[] = [];
    await sync2Remote(contextFor(fakeFs(seenBothWays), fakeFs(seenBothWays)), {
      bothDiretions: true,
    });
    expect(seenBothWays).toEqual([true, true]);
    expect(isSuppressed()).toBe(true);
    jest.advanceTimersByTime(PAST_THE_TAIL);
    expect(isSuppressed()).toBe(false);
  });

  test('an upload does not suppress: a save made meanwhile must still go out', async () => {
    const seen: boolean[] = [];
    const ctx = contextFor(fakeFs(seen), fakeFs(seen));

    await uploadFile(ctx);

    expect(seen).toEqual([false]);
    expect(isSuppressed()).toBe(false);
  });

  test('a download that fails still releases after the tail', async () => {
    const seen: boolean[] = [];
    const remoteFs = fakeFs(seen);
    remoteFs.lstat = jest.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });

    await expect(downloadFile(contextFor(remoteFs, fakeFs(seen)))).rejects.toThrow('ECONNREFUSED');

    expect(isSuppressed()).toBe(true);
    jest.advanceTimersByTime(PAST_THE_TAIL);
    expect(isSuppressed()).toBe(false);
  });
});
