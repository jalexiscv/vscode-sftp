jest.mock('fs');
// the collector only needs to know which service owns a path and what is in
// flight; the real registry would drag the connection layer in
jest.mock('../serviceManager', () => ({
  getFileService: jest.fn(),
  getRunningTransformTasks: jest.fn(() => []),
}));
// the default handler's upload is the observable outcome here, not a transfer
jest.mock('../../fileHandlers', () => ({
  uploadFile: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../host', () => ({
  ...jest.requireActual('../../host'),
  getWorkspaceFolders: () => [{ uri: { fsPath: require('path').resolve(require('path').sep, 'ws') } }],
}));

import * as path from 'path';
import { vol } from 'memfs';
import { TransferDirection } from '../../core';
import { uploadFile } from '../../fileHandlers';
import { getFileService, getRunningTransformTasks } from '../serviceManager';
import {
  setPaused,
  suppressAutoSync,
  __resetForTest as resetSyncControl,
} from '../syncControl';
import {
  enqueueChange,
  setBatchHandler,
  flushNow,
  pendingCount,
  onDidChangePending,
  testHooks,
  ChangeBatch,
  PendingChange,
  __resetForTest,
} from '../changeCollector';

const { queueKey, isGitDriven, BATCH_INTERVAL } = testHooks;

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const root = path.resolve(path.sep, 'ws');
const p = (...segments: string[]) => path.join(root, ...segments);

const uploadFileMock = uploadFile as jest.Mock;
const getFileServiceMock = getFileService as jest.Mock;
const getRunningTransformTasksMock = getRunningTransformTasks as jest.Mock;

function uri(fsPath: string) {
  return { scheme: 'file', fsPath } as any;
}

function fakeService(baseDir: string, config: any = {}) {
  return {
    baseDir,
    name: path.basename(baseDir),
    getConfig: () => ({ ignore: null, ...config }),
  } as any;
}

// resolves a path to the fake service whose base dir contains it
function installServices(...services: any[]) {
  getFileServiceMock.mockImplementation((target: { fsPath: string }) => {
    const fsPath = CASE_INSENSITIVE ? target.fsPath.toLowerCase() : target.fsPath;
    return services.find(service => {
      const base = CASE_INSENSITIVE ? service.baseDir.toLowerCase() : service.baseDir;
      return fsPath.indexOf(base + path.sep) === 0;
    });
  });
}

function collectBatches(): ChangeBatch[] {
  const seen: ChangeBatch[] = [];
  setBatchHandler(async batch => {
    seen.push(batch);
  });
  return seen;
}

function change(overrides: Partial<PendingChange> = {}): PendingChange {
  return {
    uri: uri(p('src', 'a.ts')),
    fsPath: p('src', 'a.ts'),
    source: 'save',
    queuedAt: 0,
    gitBusyWhenQueued: false,
    gitHeadWhenQueued: 'abc',
    ...overrides,
  };
}

beforeEach(() => {
  __resetForTest();
  resetSyncControl();
  vol.reset();
  uploadFileMock.mockClear();
  uploadFileMock.mockImplementation(() => Promise.resolve());
  getFileServiceMock.mockReset();
  getRunningTransformTasksMock.mockReset();
  getRunningTransformTasksMock.mockImplementation(() => []);
  installServices(fakeService(p('src')));
});

afterEach(async () => {
  // never leave a pass running into the next test
  await flushNow();
  __resetForTest();
});

describe('queueKey', () => {
  test('normalises the path', () => {
    expect(queueKey(p('src', 'sub', '..', 'a.ts'))).toBe(queueKey(p('src', 'a.ts')));
  });

  if (CASE_INSENSITIVE) {
    test('folds case on a case-insensitive filesystem', () => {
      expect(queueKey(p('Src', 'A.ts'))).toBe(queueKey(p('src', 'a.ts')));
    });
  } else {
    test('keeps case on a case-sensitive filesystem', () => {
      expect(queueKey(p('Src', 'A.ts'))).not.toBe(queueKey(p('src', 'a.ts')));
    });
  }
});

describe('dedupe', () => {
  test('a second change of the same path within the window replaces the first', async () => {
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    expect(pendingCount()).toBe(1);

    await flushNow();

    expect(seen.length).toBe(1);
    expect(seen[0].items.length).toBe(1);
    expect(seen[0].items[0].source).toBe('watcher');
  });

  if (CASE_INSENSITIVE) {
    test('a save and a watcher event that differ only in casing are one change', async () => {
      const seen = collectBatches();

      enqueueChange(uri(p('src', 'A.ts')), 'save');
      enqueueChange(uri(p('src', 'a.ts')), 'watcher');

      await flushNow();

      expect(seen[0].items.length).toBe(1);
    });
  }

  test('different paths stay separate', async () => {
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    enqueueChange(uri(p('src', 'b.ts')), 'save');
    expect(pendingCount()).toBe(2);

    await flushNow();

    expect(seen[0].items.map(i => path.basename(i.fsPath)).sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('pending count', () => {
  test('reflects the queue and notifies on every change', async () => {
    collectBatches();
    const listener = jest.fn();
    const subscription = onDidChangePending(listener);

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    expect(pendingCount()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    await flushNow();
    expect(pendingCount()).toBe(0);
    // once more when the queue drains
    expect(listener).toHaveBeenCalledTimes(2);

    subscription.dispose();
    enqueueChange(uri(p('src', 'b.ts')), 'save');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('batches', () => {
  test('groups the items by service and calls the handler once per service', async () => {
    const alpha = fakeService(p('alpha'));
    const beta = fakeService(p('beta'));
    installServices(alpha, beta);
    const seen = collectBatches();

    enqueueChange(uri(p('alpha', 'a.ts')), 'save');
    enqueueChange(uri(p('beta', 'b.ts')), 'watcher');
    enqueueChange(uri(p('alpha', 'sub', 'c.ts')), 'scan');

    await flushNow();

    expect(seen.length).toBe(2);
    const forAlpha = seen.find(batch => batch.service === alpha)!;
    const forBeta = seen.find(batch => batch.service === beta)!;
    expect(forAlpha.items.map(i => path.basename(i.fsPath)).sort()).toEqual(['a.ts', 'c.ts']);
    expect(forBeta.items.map(i => path.basename(i.fsPath))).toEqual(['b.ts']);
  });

  test('orders the items of a batch deepest first, as the watcher did', async () => {
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    enqueueChange(uri(p('src', 'deep', 'deeper', 'c.ts')), 'save');
    enqueueChange(uri(p('src', 'deep', 'b.ts')), 'save');

    await flushNow();

    expect(seen[0].items.map(i => path.basename(i.fsPath))).toEqual(['c.ts', 'b.ts', 'a.ts']);
  });

  test('carries the source and the git snapshot of each item', async () => {
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'poll');
    await flushNow();

    const [item] = seen[0].items;
    expect(item.source).toBe('poll');
    expect(item.fsPath).toBe(p('src', 'a.ts'));
    expect(typeof item.queuedAt).toBe('number');
    expect(item.gitBusyWhenQueued).toBe(false);
    expect(item.gitHeadWhenQueued).toBeNull();
    expect(seen[0].gitDriven).toBe(false);
  });

  test('a handler that throws does not stop the other services', async () => {
    const alpha = fakeService(p('alpha'));
    const beta = fakeService(p('beta'));
    installServices(alpha, beta);
    const handled: string[] = [];
    setBatchHandler(async batch => {
      handled.push(batch.service.name);
      if (batch.service === alpha) {
        throw new Error('alpha is down');
      }
    });

    enqueueChange(uri(p('alpha', 'a.ts')), 'save');
    enqueueChange(uri(p('beta', 'b.ts')), 'save');

    await expect(flushNow()).resolves.toBeUndefined();
    expect(handled.sort()).toEqual(['alpha', 'beta']);
  });

  test('setBatchHandler(null) restores the default upload', async () => {
    setBatchHandler(async () => undefined);
    setBatchHandler(null);

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    await flushNow();

    expect(uploadFileMock).toHaveBeenCalledTimes(1);
  });
});

describe('admission', () => {
  test('drops everything while automatic sync is paused', async () => {
    const seen = collectBatches();
    setPaused(true);

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    await flushNow();

    expect(seen).toEqual([]);
    expect(pendingCount()).toBe(0);
  });

  test('drops everything while the extension is rewriting local files', async () => {
    const seen = collectBatches();

    await suppressAutoSync(async () => {
      enqueueChange(uri(p('src', 'a.ts')), 'watcher');
      await flushNow();
    });

    expect(seen).toEqual([]);
  });

  test('drops a path no config covers', async () => {
    const seen = collectBatches();

    enqueueChange(uri(p('elsewhere', 'a.ts')), 'save');
    enqueueChange(uri(p('src', 'b.ts')), 'save');
    await flushNow();

    expect(seen.length).toBe(1);
    expect(seen[0].items.map(i => path.basename(i.fsPath))).toEqual(['b.ts']);
  });

  test('drops a path outside the workspace', async () => {
    const other = path.resolve(path.sep, 'outside');
    installServices(fakeService(p('src')), fakeService(other));
    const seen = collectBatches();

    enqueueChange(uri(path.join(other, 'a.ts')), 'save');
    await flushNow();

    expect(seen).toEqual([]);
  });

  test('drops a non-file uri', async () => {
    const seen = collectBatches();

    enqueueChange({ scheme: 'untitled', fsPath: p('src', 'a.ts') } as any, 'save');
    await flushNow();

    expect(seen).toEqual([]);
  });

  test('drops a path the config ignores', async () => {
    installServices(
      fakeService(p('src'), { ignore: (fsPath: string) => /\.log$/.test(fsPath) })
    );
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'debug.log')), 'watcher');
    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    await flushNow();

    expect(seen[0].items.map(i => path.basename(i.fsPath))).toEqual(['a.ts']);
  });

  test('drops a path with an unusable config, without failing the batch', async () => {
    const broken = {
      baseDir: p('src'),
      name: 'src',
      getConfig: () => {
        throw new Error('Unkown Profile');
      },
    };
    installServices(broken);
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    await expect(flushNow()).resolves.toBeUndefined();

    expect(seen).toEqual([]);
  });

  test('drops a path that is being downloaded right now', async () => {
    getRunningTransformTasksMock.mockImplementation(() => [
      { transferType: TransferDirection.REMOTE_TO_LOCAL, localFsPath: p('src', 'a.ts') },
      // an upload in flight is not a reason to skip: it is ours
      { transferType: TransferDirection.LOCAL_TO_REMOTE, localFsPath: p('src', 'b.ts') },
    ]);
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    enqueueChange(uri(p('src', 'b.ts')), 'watcher');
    await flushNow();

    expect(seen[0].items.map(i => path.basename(i.fsPath))).toEqual(['b.ts']);
  });
});

describe('default handler', () => {
  test('uploads each item once', async () => {
    enqueueChange(uri(p('src', 'a.ts')), 'save');
    enqueueChange(uri(p('src', 'b.ts')), 'watcher');
    await flushNow();

    expect(uploadFileMock).toHaveBeenCalledTimes(2);
    const uploaded = uploadFileMock.mock.calls.map(([target]) => path.basename(target.fsPath));
    expect(uploaded.sort()).toEqual(['a.ts', 'b.ts']);
  });

  test('an in-editor save seen by the watcher too is one upload, not two', async () => {
    // this is the bug the collector exists for
    enqueueChange(uri(p('src', 'a.ts')), 'save');
    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    await flushNow();

    expect(uploadFileMock).toHaveBeenCalledTimes(1);
  });

  test('a failed upload is contained: the others go through and nothing rejects', async () => {
    uploadFileMock.mockImplementation((target: { fsPath: string }) =>
      path.basename(target.fsPath) === 'a.ts'
        ? Promise.reject(new Error('EACCES'))
        : Promise.resolve()
    );

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    enqueueChange(uri(p('src', 'b.ts')), 'save');
    await expect(flushNow()).resolves.toBeUndefined();

    expect(uploadFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('flushNow', () => {
  test('resolves only after the handler has finished', async () => {
    let finished = false;
    setBatchHandler(
      () =>
        new Promise<void>(resolve => {
          setTimeout(() => {
            finished = true;
            resolve();
          }, 20);
        })
    );

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    await flushNow();

    expect(finished).toBe(true);
  });

  test('a change queued while a pass runs is handled in a follow-up pass', async () => {
    const seen = collectBatches();
    let reentered = false;
    setBatchHandler(async batch => {
      seen.push(batch);
      if (!reentered) {
        reentered = true;
        enqueueChange(uri(p('src', 'late.ts')), 'watcher');
      }
    });

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    await flushNow();

    expect(seen.length).toBe(2);
    expect(seen[1].items.map(i => path.basename(i.fsPath))).toEqual(['late.ts']);
    expect(pendingCount()).toBe(0);
  });

  test('is a no-op on an empty queue', async () => {
    const seen = collectBatches();
    await flushNow();
    expect(seen).toEqual([]);
  });
});

describe('git awareness', () => {
  const gitNow = (state: { busy: boolean; head: string | null }) => () => state;

  test('isGitDriven: git was busy when the change was queued', () => {
    expect(isGitDriven(change({ gitBusyWhenQueued: true }), gitNow({ busy: false, head: 'abc' }))).toBe(
      true
    );
  });

  test('isGitDriven: git is busy now', () => {
    expect(isGitDriven(change(), gitNow({ busy: true, head: 'abc' }))).toBe(true);
  });

  test('isGitDriven: HEAD moved since the change was queued', () => {
    expect(isGitDriven(change({ gitHeadWhenQueued: 'abc' }), gitNow({ busy: false, head: 'def' }))).toBe(
      true
    );
  });

  test('isGitDriven: nothing changed', () => {
    expect(isGitDriven(change({ gitHeadWhenQueued: 'abc' }), gitNow({ busy: false, head: 'abc' }))).toBe(
      false
    );
  });

  test('isGitDriven: outside a repository it is never git', () => {
    expect(isGitDriven(change({ gitHeadWhenQueued: null }), gitNow({ busy: false, head: 'abc' }))).toBe(
      false
    );
  });

  test('a checkout between queueing and processing flags the batch', async () => {
    const head = path.join(root, '.git', 'HEAD');
    vol.fromJSON({ [head]: 'ref: refs/heads/main\n', [p('src', 'a.ts')]: 'x' });
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    expect(seen).toEqual([]);
    // git checkout feature
    vol.writeFileSync(head, 'ref: refs/heads/feature\n');

    await flushNow();

    expect(seen[0].gitDriven).toBe(true);
    expect(seen[0].items[0].gitHeadWhenQueued).toBe('refs/heads/main');
  });

  test('a repeat of the same path keeps the earliest git snapshot', async () => {
    const head = path.join(root, '.git', 'HEAD');
    vol.fromJSON({ [head]: 'ref: refs/heads/main\n' });
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    vol.writeFileSync(head, 'ref: refs/heads/feature\n');
    // the watcher reports the same write after the checkout already landed
    enqueueChange(uri(p('src', 'a.ts')), 'watcher');

    await flushNow();

    expect(seen[0].items[0].gitHeadWhenQueued).toBe('refs/heads/main');
    expect(seen[0].gitDriven).toBe(true);
  });

  test('a plain edit in a quiet repository is not git', async () => {
    vol.fromJSON({ [path.join(root, '.git', 'HEAD')]: 'ref: refs/heads/main\n' });
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    await flushNow();

    expect(seen[0].gitDriven).toBe(false);
  });
});

describe('batching window', () => {
  // lodash.debounce reads Date.now to decide whether the wait is over, so the
  // clock has to move together with the fake timers
  let now = 0;
  let clock: jest.SpyInstance;

  const advance = (ms: number) => {
    now += ms;
    jest.advanceTimersByTime(ms);
  };

  beforeAll(() => {
    jest.useFakeTimers({ legacyFakeTimers: true } as any);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    now = 1000;
    clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    clock.mockRestore();
  });

  test('waits for the burst to settle before processing', async () => {
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    advance(BATCH_INTERVAL - 1);
    expect(seen).toEqual([]);

    // the handler is reached synchronously from the timer, so this is the
    // timer firing, not the flush below
    advance(1);
    expect(seen.length).toBe(1);

    await flushNow();
    expect(seen.length).toBe(1);
  });

  test('a change inside the window restarts it and joins the batch', async () => {
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    advance(BATCH_INTERVAL - 100);
    enqueueChange(uri(p('src', 'b.ts')), 'watcher');
    advance(200);
    // the first change is past its own window, but the second restarted it
    expect(seen).toEqual([]);

    advance(BATCH_INTERVAL);
    expect(seen.length).toBe(1);
    expect(seen[0].items.map(i => path.basename(i.fsPath)).sort()).toEqual(['a.ts', 'b.ts']);

    await flushNow();
    expect(seen.length).toBe(1);
  });
});
