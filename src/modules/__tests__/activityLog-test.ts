import * as activityLog from '../activityLog';

const { ActivityKind, ActivityStatus } = activityLog;

beforeEach(() => {
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
