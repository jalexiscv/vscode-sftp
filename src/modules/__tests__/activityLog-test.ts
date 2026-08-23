jest.mock('fs');
// The default vscode mock answers every lookup with "Nothing"; a retry rebuilt
// on load wraps the local path in a Uri, so give it a real one to assert on.
jest.mock('vscode', () => {
  const Nothing = jest.requireActual('../../../__mocks__/vscode.js');
  class Uri {
    static file(fsPath: string) {
      return new Uri(fsPath);
    }
    readonly scheme = 'file';
    constructor(readonly fsPath: string) {}
  }
  return new Proxy({ Uri }, { get: (target, key) => (key in target ? target[key] : Nothing) });
});
// the rebuilt retries call the handlers; here they only need to be observable
jest.mock('../../fileHandlers', () => ({
  uploadFile: jest.fn(() => Promise.resolve()),
  downloadFile: jest.fn(() => Promise.resolve()),
}));

import * as path from 'path';
import { vol } from 'memfs';
import { uploadFile, downloadFile } from '../../fileHandlers';
import * as activityLog from '../activityLog';

const { ActivityKind, ActivityStatus } = activityLog;

// absolute on both platforms; "c:/..." is a relative folder on linux
const storage = path.resolve(path.sep, 'storage', 'workspace-1');
const logFile = path.join(storage, 'activity-log.json');

// memfs reports its keys in its own form, so existence is asked of the volume
// and only the *number* of files is compared
function storedFiles(): string[] {
  return Object.keys(vol.toJSON());
}

function logFileExists(): boolean {
  return vol.existsSync(logFile);
}

function readLog(): { version: number; entries: any[] } {
  return JSON.parse(vol.readFileSync(logFile, 'utf8') as string);
}

function writeLog(entries: any[], version = 1) {
  vol.mkdirSync(storage, { recursive: true });
  vol.writeFileSync(logFile, JSON.stringify({ version, entries }));
}

beforeEach(() => {
  activityLog.__resetForTest();
  vol.reset();
  (uploadFile as jest.Mock).mockClear();
  (downloadFile as jest.Mock).mockClear();
});

afterEach(() => {
  // drop any debounced save left behind before the volume is reset again
  activityLog.__resetForTest();
});

describe('activityLog.record', () => {
  test('assigns increasing ids starting from 1', () => {
    const first = activityLog.record({ kind: ActivityKind.Upload });
    const second = activityLog.record({ kind: ActivityKind.Download });
    const third = activityLog.record({ kind: ActivityKind.Delete });

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(third).toBe(3);
  });

  test('__resetForTest rewinds the id counter and drops the entries', () => {
    activityLog.record({ kind: ActivityKind.Upload });
    activityLog.record({ kind: ActivityKind.Upload });

    activityLog.__resetForTest();

    expect(activityLog.getEntries()).toEqual([]);
    expect(activityLog.record({ kind: ActivityKind.Upload })).toBe(1);
  });

  test('defaults to Pending, stamps startedAt and leaves finishedAt open', () => {
    const before = Date.now();
    const id = activityLog.record({ kind: ActivityKind.Upload, localPath: '/tmp/a.php' });
    const entry = activityLog.getEntry(id)!;

    expect(entry.status).toBe(ActivityStatus.Pending);
    expect(entry.startedAt).toBeGreaterThanOrEqual(before);
    expect(entry.finishedAt).toBeUndefined();
    expect(entry.localPath).toBe('/tmp/a.php');
  });

  test('honours an explicit status in the draft', () => {
    const id = activityLog.record({
      kind: ActivityKind.Delete,
      status: ActivityStatus.Skipped,
    });

    expect(activityLog.getEntry(id)!.status).toBe(ActivityStatus.Skipped);
  });

  test('exposes the entries newest first', () => {
    const first = activityLog.record({ kind: ActivityKind.Upload });
    const second = activityLog.record({ kind: ActivityKind.Download });
    const third = activityLog.record({ kind: ActivityKind.Rename });

    expect(activityLog.getEntries().map(e => e.id)).toEqual([third, second, first]);
  });

  test('getEntries hands out a copy, not the live array', () => {
    activityLog.record({ kind: ActivityKind.Upload });
    const snapshot = activityLog.getEntries();
    snapshot.length = 0;

    expect(activityLog.getEntries()).toHaveLength(1);
  });

  test('keeps at most 500 entries and drops the oldest ones', () => {
    for (let i = 0; i < 505; i++) {
      activityLog.record({ kind: ActivityKind.Upload, localPath: `/tmp/${i}.php` });
    }

    const entries = activityLog.getEntries();
    expect(entries).toHaveLength(500);
    // newest first, so the head is the last id recorded and the tail is the
    // oldest survivor: ids 1..5 have been evicted
    expect(entries[0].id).toBe(505);
    expect(entries[entries.length - 1].id).toBe(6);
    expect(activityLog.getEntry(5)).toBeUndefined();
  });
});

describe('activityLog.update / succeed / fail', () => {
  test('succeed sets Success and stamps finishedAt', () => {
    const id = activityLog.record({ kind: ActivityKind.Upload });
    activityLog.succeed(id);

    const entry = activityLog.getEntry(id)!;
    expect(entry.status).toBe(ActivityStatus.Success);
    expect(typeof entry.finishedAt).toBe('number');
    expect(entry.finishedAt!).toBeGreaterThanOrEqual(entry.startedAt);
  });

  test('fail stores the message of an Error', () => {
    const id = activityLog.record({ kind: ActivityKind.Upload });
    activityLog.fail(id, new Error('connection reset'));

    const entry = activityLog.getEntry(id)!;
    expect(entry.status).toBe(ActivityStatus.Failed);
    expect(entry.error).toBe('connection reset');
    expect(typeof entry.finishedAt).toBe('number');
  });

  test('fail accepts a plain string too', () => {
    const id = activityLog.record({ kind: ActivityKind.Delete });
    activityLog.fail(id, 'remote said no');

    expect(activityLog.getEntry(id)!.error).toBe('remote said no');
  });

  test('fail falls back to the stringified error when the message is empty', () => {
    const id = activityLog.record({ kind: ActivityKind.Delete });
    activityLog.fail(id, new Error(''));

    expect(activityLog.getEntry(id)!.error).toBe('Error');
  });

  test('update merges arbitrary fields', () => {
    const id = activityLog.record({ kind: ActivityKind.Upload, localPath: '/tmp/a.php' });
    activityLog.update(id, { remotePath: '/var/www/a.php', profile: 'staging' });

    const entry = activityLog.getEntry(id)!;
    expect(entry.remotePath).toBe('/var/www/a.php');
    expect(entry.profile).toBe('staging');
    expect(entry.localPath).toBe('/tmp/a.php');
  });

  test('a Pending update does not stamp finishedAt', () => {
    const id = activityLog.record({ kind: ActivityKind.Upload });
    activityLog.update(id, { status: ActivityStatus.Pending });

    expect(activityLog.getEntry(id)!.finishedAt).toBeUndefined();
  });

  test('finishedAt is stamped once and never moved', () => {
    const id = activityLog.record({ kind: ActivityKind.Upload });
    activityLog.succeed(id);
    const finishedAt = activityLog.getEntry(id)!.finishedAt;

    activityLog.fail(id, 'late failure');

    const entry = activityLog.getEntry(id)!;
    expect(entry.status).toBe(ActivityStatus.Failed);
    expect(entry.finishedAt).toBe(finishedAt);
  });

  test('updating an unknown id is a no-op', () => {
    const id = activityLog.record({ kind: ActivityKind.Upload });
    activityLog.update(id + 999, { status: ActivityStatus.Failed });

    expect(activityLog.getEntry(id)!.status).toBe(ActivityStatus.Pending);
    expect(activityLog.getEntries()).toHaveLength(1);
  });
});

describe('activityLog.log', () => {
  test('records an already-finished operation with a finishedAt', () => {
    const id = activityLog.log({
      kind: ActivityKind.Delete,
      status: ActivityStatus.Success,
      remotePath: '/var/www/gone.php',
    });

    const entry = activityLog.getEntry(id)!;
    expect(entry.status).toBe(ActivityStatus.Success);
    expect(typeof entry.finishedAt).toBe('number');
  });

  test('a Pending log entry stays open', () => {
    const id = activityLog.log({
      kind: ActivityKind.Sync,
      status: ActivityStatus.Pending,
    });

    expect(activityLog.getEntry(id)!.finishedAt).toBeUndefined();
  });
});

describe('activityLog.getFailedEntries', () => {
  test('returns only failed entries that carry a retry thunk', () => {
    const retry = () => Promise.resolve();

    const retryable = activityLog.record({ kind: ActivityKind.Upload, retry });
    const notRetryable = activityLog.record({ kind: ActivityKind.Upload });
    const succeeded = activityLog.record({ kind: ActivityKind.Upload, retry });
    const stillPending = activityLog.record({ kind: ActivityKind.Upload, retry });

    activityLog.fail(retryable, 'boom');
    activityLog.fail(notRetryable, 'boom');
    activityLog.succeed(succeeded);

    const failed = activityLog.getFailedEntries();
    expect(failed.map(e => e.id)).toEqual([retryable]);
    expect(failed.map(e => e.id)).not.toContain(notRetryable);
    expect(failed.map(e => e.id)).not.toContain(stillPending);
  });

  test('is empty when nothing failed', () => {
    const id = activityLog.record({
      kind: ActivityKind.Upload,
      retry: () => Promise.resolve(),
    });
    activityLog.succeed(id);

    expect(activityLog.getFailedEntries()).toEqual([]);
  });
});

describe('activityLog.clear', () => {
  test('drops every entry but keeps the id counter moving forward', () => {
    activityLog.record({ kind: ActivityKind.Upload });
    const last = activityLog.record({ kind: ActivityKind.Upload });

    activityLog.clear();

    expect(activityLog.getEntries()).toEqual([]);
    expect(activityLog.record({ kind: ActivityKind.Upload })).toBe(last + 1);
  });
});

describe('activityLog.onDidChange', () => {
  test('fires on record, update and clear', () => {
    const listener = jest.fn();
    activityLog.onDidChange(listener);

    const id = activityLog.record({ kind: ActivityKind.Upload });
    expect(listener).toHaveBeenCalledTimes(1);

    activityLog.succeed(id);
    expect(listener).toHaveBeenCalledTimes(2);

    activityLog.clear();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  test('does not fire when update targets an unknown id', () => {
    const listener = jest.fn();
    activityLog.onDidChange(listener);

    activityLog.update(4242, { status: ActivityStatus.Failed });

    expect(listener).not.toHaveBeenCalled();
  });

  test('dispose really unsubscribes', () => {
    const listener = jest.fn();
    const disposable = activityLog.onDidChange(listener);

    activityLog.record({ kind: ActivityKind.Upload });
    expect(listener).toHaveBeenCalledTimes(1);

    disposable.dispose();
    activityLog.record({ kind: ActivityKind.Upload });
    activityLog.clear();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('disposing one listener leaves the others subscribed', () => {
    const first = jest.fn();
    const second = jest.fn();
    const firstDisposable = activityLog.onDidChange(first);
    activityLog.onDidChange(second);

    firstDisposable.dispose();
    activityLog.record({ kind: ActivityKind.Upload });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('a throwing listener does not stop the others', () => {
    const boom = jest.fn(() => {
      throw new Error('listener blew up');
    });
    const survivor = jest.fn();
    activityLog.onDidChange(boom);
    activityLog.onDidChange(survivor);

    expect(() => activityLog.record({ kind: ActivityKind.Upload })).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(1);
    expect(survivor).toHaveBeenCalledTimes(1);
  });
});

describe('activityLog persistence', () => {
  describe('saving', () => {
    test('flush writes activity-log.json under the storage path, without the retry', async () => {
      await activityLog.initActivityLog({ storagePath: storage });
      const id = activityLog.record({
        kind: ActivityKind.Upload,
        localPath: '/ws/a.php',
        remotePath: '/remote/a.php',
        serviceName: 'site',
        profile: 'prod',
        retry: () => Promise.resolve(),
      });
      activityLog.fail(id, 'size mismatch');

      await activityLog.flushActivityLog();

      expect(logFileExists()).toBe(true);
      expect(storedFiles()).toHaveLength(1);
      const data = readLog();
      expect(data.version).toBe(1);
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0]).toMatchObject({
        id,
        kind: 'upload',
        status: 'failed',
        localPath: '/ws/a.php',
        remotePath: '/remote/a.php',
        serviceName: 'site',
        profile: 'prod',
        error: 'size mismatch',
      });
      expect(data.entries[0]).not.toHaveProperty('retry');
      expect(typeof data.entries[0].startedAt).toBe('number');
      expect(typeof data.entries[0].finishedAt).toBe('number');
    });

    test('nothing is written without a storage path', async () => {
      await activityLog.initActivityLog({ storagePath: undefined });
      activityLog.record({ kind: ActivityKind.Upload });
      await activityLog.flushActivityLog();
      expect(storedFiles()).toEqual([]);
    });

    test('nothing is written when nothing changed', async () => {
      await activityLog.initActivityLog({ storagePath: storage });
      await activityLog.flushActivityLog();
      expect(storedFiles()).toEqual([]);
    });

    test('keeps the newest 200 entries on disk even though memory holds 500', async () => {
      await activityLog.initActivityLog({ storagePath: storage });
      for (let i = 1; i <= 250; i++) {
        activityLog.record({ kind: ActivityKind.Upload, localPath: `/ws/${i}.php` });
      }

      await activityLog.flushActivityLog();

      const { entries } = readLog();
      expect(entries).toHaveLength(200);
      expect(entries[0].id).toBe(250);
      expect(entries[199].id).toBe(51);
    });

    test('clear is persisted too, so the entries do not come back', async () => {
      await activityLog.initActivityLog({ storagePath: storage });
      activityLog.record({ kind: ActivityKind.Upload });
      await activityLog.flushActivityLog();
      expect(readLog().entries).toHaveLength(1);

      activityLog.clear();
      await activityLog.flushActivityLog();
      expect(readLog().entries).toEqual([]);
    });

    test('writes go through a .tmp that is renamed away', async () => {
      await activityLog.initActivityLog({ storagePath: storage });
      activityLog.record({ kind: ActivityKind.Upload });
      await activityLog.flushActivityLog();
      expect(logFileExists()).toBe(true);
      expect(storedFiles()).toHaveLength(1);
      expect(vol.existsSync(logFile + '.tmp')).toBe(false);
    });

    describe('debounce', () => {
      beforeAll(() => jest.useFakeTimers({ legacyFakeTimers: true } as any));
      afterAll(() => jest.useRealTimers());

      test('a change is written on its own about a second later', async () => {
        await activityLog.initActivityLog({ storagePath: storage });
        activityLog.record({ kind: ActivityKind.Upload });
        activityLog.record({ kind: ActivityKind.Download });
        expect(storedFiles()).toEqual([]);

        jest.advanceTimersByTime(999);
        await activityLog.flushActivityLog();
        // flush with nothing in flight and the timer still armed: the timer
        // was cancelled by the flush, which wrote the file itself
        expect(logFileExists()).toBe(true);
        expect(readLog().entries).toHaveLength(2);
      });

      test('the timer fires the save by itself', async () => {
        await activityLog.initActivityLog({ storagePath: storage });
        activityLog.record({ kind: ActivityKind.Upload });
        expect(storedFiles()).toEqual([]);

        jest.advanceTimersByTime(1000);
        // the write is async; wait for it through a flush with nothing dirty
        await activityLog.flushActivityLog();
        expect(readLog().entries).toHaveLength(1);
      });
    });
  });

  describe('loading', () => {
    test('restores the entries newest first and continues the ids', async () => {
      writeLog([
        { id: 12, kind: 'delete', status: 'success', remotePath: '/remote/b.php', startedAt: 2, finishedAt: 3 },
        { id: 11, kind: 'upload', status: 'success', localPath: '/ws/a.php', startedAt: 1, finishedAt: 2 },
      ]);

      await activityLog.initActivityLog({ storagePath: storage });

      expect(activityLog.getEntries().map(e => e.id)).toEqual([12, 11]);
      expect(activityLog.getEntry(11)!.localPath).toBe('/ws/a.php');
      expect(activityLog.record({ kind: ActivityKind.Upload })).toBe(13);
      expect(activityLog.getEntries().map(e => e.id)).toEqual([13, 12, 11]);
    });

    test('a pending entry becomes cancelled, with the reason', async () => {
      writeLog([{ id: 1, kind: 'upload', status: 'pending', localPath: '/ws/a.php', startedAt: 1 }]);

      await activityLog.initActivityLog({ storagePath: storage });

      const entry = activityLog.getEntry(1)!;
      expect(entry.status).toBe(ActivityStatus.Cancelled);
      expect(entry.error).toBe('interrupted by a window reload');
    });

    test('uploads and downloads get a retry back that re-runs the handler on the local path', async () => {
      writeLog([
        { id: 3, kind: 'rename', status: 'failed', localPath: '/ws/c.php', fromPath: '/ws/old.php', startedAt: 3 },
        { id: 2, kind: 'download', status: 'failed', localPath: '/ws/b.php', startedAt: 2 },
        { id: 1, kind: 'upload', status: 'failed', localPath: '/ws/a.php', startedAt: 1 },
      ]);

      await activityLog.initActivityLog({ storagePath: storage });

      const upload = activityLog.getEntry(1)!;
      const download = activityLog.getEntry(2)!;
      const rename = activityLog.getEntry(3)!;
      expect(typeof upload.retry).toBe('function');
      expect(typeof download.retry).toBe('function');
      expect(rename.retry).toBeUndefined();

      await upload.retry!();
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect((uploadFile as jest.Mock).mock.calls[0][0].fsPath).toBe('/ws/a.php');

      await download.retry!();
      expect(downloadFile).toHaveBeenCalledTimes(1);
      expect((downloadFile as jest.Mock).mock.calls[0][0].fsPath).toBe('/ws/b.php');

      // so "Retry All Failed" sees them after a reload
      expect(activityLog.getFailedEntries().map(e => e.id)).toEqual([2, 1]);
    });

    test('an upload without a local path gets no retry', async () => {
      writeLog([{ id: 1, kind: 'upload', status: 'failed', remotePath: '/remote/a.php', startedAt: 1 }]);
      await activityLog.initActivityLog({ storagePath: storage });
      expect(activityLog.getEntry(1)!.retry).toBeUndefined();
    });

    test('loads at most 200 entries', async () => {
      const entries: any[] = [];
      for (let id = 300; id >= 1; id--) {
        entries.push({ id, kind: 'upload', status: 'success', startedAt: id });
      }
      writeLog(entries);

      await activityLog.initActivityLog({ storagePath: storage });

      const loaded = activityLog.getEntries();
      expect(loaded).toHaveLength(200);
      expect(loaded[0].id).toBe(300);
      expect(loaded[199].id).toBe(101);
      expect(activityLog.record({ kind: ActivityKind.Upload })).toBe(301);
    });

    test('skips rows that do not look like entries', async () => {
      writeLog([
        { id: 2, kind: 'upload', status: 'success', startedAt: 2 },
        { nonsense: true },
        null,
        { id: 'x', kind: 'upload', status: 'success', startedAt: 1 },
      ]);

      await activityLog.initActivityLog({ storagePath: storage });
      expect(activityLog.getEntries().map(e => e.id)).toEqual([2]);
    });

    test('a missing file is the first run', async () => {
      await activityLog.initActivityLog({ storagePath: storage });
      expect(activityLog.getEntries()).toEqual([]);
      expect(activityLog.record({ kind: ActivityKind.Upload })).toBe(1);
    });

    test('a corrupt file or another version starts empty without throwing', async () => {
      vol.mkdirSync(storage, { recursive: true });
      vol.writeFileSync(logFile, '{ not json');
      await expect(activityLog.initActivityLog({ storagePath: storage })).resolves.toBeUndefined();
      expect(activityLog.getEntries()).toEqual([]);

      activityLog.__resetForTest();
      writeLog([{ id: 1, kind: 'upload', status: 'success', startedAt: 1 }], 99);
      await activityLog.initActivityLog({ storagePath: storage });
      expect(activityLog.getEntries()).toEqual([]);
    });

    test('what was loaded is what a later save writes back', async () => {
      writeLog([{ id: 5, kind: 'upload', status: 'failed', localPath: '/ws/a.php', startedAt: 1 }]);
      await activityLog.initActivityLog({ storagePath: storage });
      activityLog.record({ kind: ActivityKind.Delete, remotePath: '/remote/x.php' });

      await activityLog.flushActivityLog();

      const { entries } = readLog();
      expect(entries.map(e => e.id)).toEqual([6, 5]);
      expect(entries[1]).not.toHaveProperty('retry');
    });

    test('notifies listeners once the entries are in', async () => {
      writeLog([{ id: 1, kind: 'upload', status: 'success', startedAt: 1 }]);
      const listener = jest.fn();
      activityLog.onDidChange(listener);

      await activityLog.initActivityLog({ storagePath: storage });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
