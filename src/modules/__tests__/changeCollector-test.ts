jest.mock('fs');
// the collector only needs to know which service owns a path and what is in
// flight; the real registry would drag the connection layer in
jest.mock('../serviceManager', () => ({
  getFileService: jest.fn(),
  getRunningTransformTasks: jest.fn(() => []),
  getAllFileService: jest.fn(() => []),
}));
// the default handler ends in the confirmation gate; what it is handed is the
// observable outcome here, not a transfer
jest.mock('../planConfirmation', () => ({
  confirmAndRunPlan: jest.fn(() => Promise.resolve({ decision: 'run', summary: {} })),
}));

import * as path from 'path';
import { vol } from 'memfs';
import { TransferDirection } from '../../core';
import { getFileService, getRunningTransformTasks } from '../serviceManager';
import { confirmAndRunPlan } from '../planConfirmation';
import {
  setPaused,
  suppressAutoSync,
  __resetForTest as resetSyncControl,
} from '../syncControl';
import { initSyncIndex, __resetForTest as resetSyncIndex } from '../syncIndex';
import { indexFor } from '../syncIndexFeeder';
import { getPlans, __resetForTest as resetPlans } from '../uploadPlan';
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

const { queueKey, isGitDriven, planSourceFor, BATCH_INTERVAL, MAX_WAIT, RECENTLY_HANDLED_TTL } = testHooks;

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const root = path.resolve(path.sep, 'ws');
const p = (...segments: string[]) => path.join(root, ...segments);

const getFileServiceMock = getFileService as jest.Mock;
const getRunningTransformTasksMock = getRunningTransformTasks as jest.Mock;
const confirmAndRunPlanMock = confirmAndRunPlan as jest.Mock;

function uri(fsPath: string) {
  return { scheme: 'file', fsPath } as any;
}

let nextServiceId = 1;

function fakeService(baseDir: string, config: any = {}) {
  const resolved = { ignore: null, host: 'example.test', port: 22, remotePath: '/remote', ...config };
  return {
    id: nextServiceId++,
    baseDir,
    name: path.basename(baseDir),
    getConfig: jest.fn(() => resolved),
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
    gitHeadWhenQueued: 'refs/heads/main',
    ...overrides,
  };
}

const names = (batch: ChangeBatch) => batch.items.map(i => path.basename(i.fsPath));

beforeEach(() => {
  __resetForTest();
  resetSyncControl();
  resetSyncIndex();
  resetPlans();
  initSyncIndex({ storagePath: undefined });
  vol.reset();
  confirmAndRunPlanMock.mockClear();
  getFileServiceMock.mockReset();
  getRunningTransformTasksMock.mockReset();
  getRunningTransformTasksMock.mockImplementation(() => []);
  installServices(fakeService(p('src')));
});

afterEach(async () => {
  // never leave a pass running into the next test
  await flushNow();
  __resetForTest();
  resetSyncIndex();
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

    enqueueChange(uri(p('src', 'a.ts')), 'scan');
    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    expect(pendingCount()).toBe(1);

    await flushNow();

    expect(seen.length).toBe(1);
    expect(seen[0].items.length).toBe(1);
    expect(seen[0].items[0].source).toBe('watcher');
  });

  if (CASE_INSENSITIVE) {
    test('two events that differ only in casing are one change', async () => {
      const seen = collectBatches();

      enqueueChange(uri(p('src', 'A.ts')), 'watcher');
      enqueueChange(uri(p('src', 'a.ts')), 'watcher');

      await flushNow();

      expect(seen[0].items.length).toBe(1);
    });
  }

  test('different paths stay separate', async () => {
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    enqueueChange(uri(p('src', 'b.ts')), 'watcher');
    expect(pendingCount()).toBe(2);

    await flushNow();

    expect(names(seen[0]).sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('saves', () => {
  test('a save is processed at once, without waiting for the window', async () => {
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'save');

    // the handler is reached synchronously: no timer, no flush
    expect(seen.length).toBe(1);
    expect(seen[0].items[0].source).toBe('save');
    expect(pendingCount()).toBe(0);
  });

  test("the watcher's echo of a save is dropped, so the save is one upload", async () => {
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    expect(pendingCount()).toBe(0);

    await flushNow();

    expect(seen.length).toBe(1);
  });

  test('a watcher event for the same path after the TTL is a new change', async () => {
    const seen = collectBatches();
    const realNow = Date.now;
    let now = 10000;
    Date.now = () => now;
    try {
      enqueueChange(uri(p('src', 'a.ts')), 'save');
      now += RECENTLY_HANDLED_TTL + 1;
      enqueueChange(uri(p('src', 'a.ts')), 'watcher');
      await flushNow();
    } finally {
      Date.now = realNow;
    }

    expect(seen.length).toBe(2);
    expect(seen[1].items[0].source).toBe('watcher');
  });

  test('saves queued while a pass runs are processed right after it, watcher changes wait', async () => {
    const seen: ChangeBatch[] = [];
    let firstPass = true;
    setBatchHandler(async batch => {
      seen.push(batch);
      if (firstPass) {
        firstPass = false;
        enqueueChange(uri(p('src', 'b.ts')), 'save');
        enqueueChange(uri(p('src', 'c.ts')), 'watcher');
      }
    });

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    // the follow-up for the save is immediate; c.ts stays for its window
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(seen.length).toBe(2);
    expect(names(seen[1])).toEqual(['b.ts']);
    expect(pendingCount()).toBe(1);

    await flushNow();
    expect(names(seen[2])).toEqual(['c.ts']);
  });
});

describe('pending count', () => {
  test('reflects the queue and notifies on every change', async () => {
    collectBatches();
    const listener = jest.fn();
    const subscription = onDidChangePending(listener);

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    expect(pendingCount()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    await flushNow();
    expect(pendingCount()).toBe(0);
    // once more when the queue drains
    expect(listener).toHaveBeenCalledTimes(2);

    subscription.dispose();
    enqueueChange(uri(p('src', 'b.ts')), 'watcher');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('batches', () => {
  test('groups the items by service and calls the handler once per service', async () => {
    const alpha = fakeService(p('alpha'));
    const beta = fakeService(p('beta'));
    installServices(alpha, beta);
    const seen = collectBatches();

    enqueueChange(uri(p('alpha', 'a.ts')), 'watcher');
    enqueueChange(uri(p('beta', 'b.ts')), 'watcher');
    enqueueChange(uri(p('alpha', 'sub', 'c.ts')), 'scan');

    await flushNow();

    expect(seen.length).toBe(2);
    const forAlpha = seen.find(batch => batch.service === alpha)!;
    const forBeta = seen.find(batch => batch.service === beta)!;
    expect(names(forAlpha).sort()).toEqual(['a.ts', 'c.ts']);
    expect(names(forBeta)).toEqual(['b.ts']);
  });

  test('orders the items of a batch deepest first, as the watcher did', async () => {
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    enqueueChange(uri(p('src', 'deep', 'deeper', 'c.ts')), 'watcher');
    enqueueChange(uri(p('src', 'deep', 'b.ts')), 'watcher');

    await flushNow();

    expect(names(seen[0])).toEqual(['c.ts', 'b.ts', 'a.ts']);
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

    enqueueChange(uri(p('alpha', 'a.ts')), 'watcher');
    enqueueChange(uri(p('beta', 'b.ts')), 'watcher');

    await expect(flushNow()).resolves.toBeUndefined();
    expect(handled.sort()).toEqual(['alpha', 'beta']);
  });

  test('the config is resolved once per burst, not once per event', async () => {
    const service = fakeService(p('src'));
    installServices(service);
    collectBatches();

    for (let i = 0; i < 20; i++) {
      enqueueChange(uri(p('src', `f${i}.ts`)), 'watcher');
    }
    await flushNow();
    expect(service.getConfig).toHaveBeenCalledTimes(1);

    // the cache is dropped when the queue drains: a new burst asks again
    enqueueChange(uri(p('src', 'g.ts')), 'watcher');
    await flushNow();
    expect(service.getConfig).toHaveBeenCalledTimes(2);
  });
});

describe('admission', () => {
  test('drops everything while automatic sync is paused', async () => {
    const seen = collectBatches();
    setPaused(true);

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    enqueueChange(uri(p('src', 'b.ts')), 'watcher');
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

  test('drops a path no config covers, before it reaches the queue', async () => {
    const seen = collectBatches();

    enqueueChange(uri(p('elsewhere', 'a.ts')), 'watcher');
    expect(pendingCount()).toBe(0);
    enqueueChange(uri(p('src', 'b.ts')), 'watcher');
    await flushNow();

    expect(seen.length).toBe(1);
    expect(names(seen[0])).toEqual(['b.ts']);
  });

  test('admits a path outside the workspace folder when a service covers it', async () => {
    const other = path.resolve(path.sep, 'outside');
    installServices(fakeService(p('src')), fakeService(other));
    const seen = collectBatches();

    enqueueChange(uri(path.join(other, 'a.ts')), 'watcher');
    await flushNow();

    expect(seen.length).toBe(1);
    expect(names(seen[0])).toEqual(['a.ts']);
  });

  test('drops a non-file uri', async () => {
    const seen = collectBatches();

    enqueueChange({ scheme: 'untitled', fsPath: p('src', 'a.ts') } as any, 'save');
    await flushNow();

    expect(seen).toEqual([]);
  });

  test('drops a path the config ignores, before it reaches the queue', async () => {
    installServices(
      fakeService(p('src'), { ignore: (fsPath: string) => /\.log$/.test(fsPath) })
    );
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'debug.log')), 'watcher');
    expect(pendingCount()).toBe(0);
    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    await flushNow();

    expect(names(seen[0])).toEqual(['a.ts']);
  });

  test('drops a path with an unusable config, without failing the batch', async () => {
    const broken = {
      id: 99,
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
    ]);
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    enqueueChange(uri(p('src', 'b.ts')), 'watcher');
    await flushNow();

    expect(names(seen[0])).toEqual(['b.ts']);
  });

  test('defers, rather than drops, a change to a path whose upload is in flight', async () => {
    getRunningTransformTasksMock.mockImplementation(() => [
      { transferType: TransferDirection.LOCAL_TO_REMOTE, localFsPath: p('src', 'a.ts') },
    ]);
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    enqueueChange(uri(p('src', 'b.ts')), 'watcher');
    await flushNow();

    expect(names(seen[0])).toEqual(['b.ts']);
    // still queued, waiting for the upload to finish
    expect(pendingCount()).toBe(1);

    getRunningTransformTasksMock.mockImplementation(() => []);
    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    await flushNow();

    expect(names(seen[1])).toEqual(['a.ts']);
    expect(pendingCount()).toBe(0);
  });
});

describe('default handler', () => {
  const plansOf = () => getPlans();

  test('turns the batch into one plan per service and hands it to the confirmation', async () => {
    vol.fromJSON({ [p('src', 'a.ts')]: 'aaa', [p('src', 'b.ts')]: 'bb' });

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    enqueueChange(uri(p('src', 'b.ts')), 'watcher');
    await flushNow();

    expect(confirmAndRunPlanMock).toHaveBeenCalledTimes(1);
    const [plan, options] = confirmAndRunPlanMock.mock.calls[0];
    expect(plansOf()).toEqual([plan]);
    expect(plan.serviceName).toBe('src');
    expect(plan.source).toBe('watcher');
    expect(plan.items.map((i: any) => path.basename(i.localPath)).sort()).toEqual(['a.ts', 'b.ts']);
    const a = plan.items.find((i: any) => path.basename(i.localPath) === 'a.ts');
    expect(a.reason).toBe('new');
    expect(a.localSize).toBe(3);
    expect(a.remotePath).toBe('/remote/a.ts');
    // the threshold comes from the config; the run is not awaited
    expect(options).toEqual({
      serviceName: 'src',
      host: 'example.test',
      confirmThreshold: 20,
      awaitRun: false,
    });
  });

  test('an in-editor save seen by the watcher too is one plan item, not two', async () => {
    vol.fromJSON({ [p('src', 'a.ts')]: 'x' });

    enqueueChange(uri(p('src', 'a.ts')), 'save');
    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    await flushNow();

    expect(confirmAndRunPlanMock).toHaveBeenCalledTimes(1);
    expect(plansOf()[0].items.length).toBe(1);
    expect(plansOf()[0].source).toBe('command');
  });

  test('a file already in the index is "modified"; a git-driven batch is a git plan', async () => {
    const head = path.join(root, '.git', 'HEAD');
    vol.fromJSON({
      [p('src', 'a.ts')]: 'x',
      [p('src', 'b.ts')]: 'y',
      [head]: 'ref: refs/heads/main\n',
    });
    const service = getFileServiceMock({ fsPath: p('src', 'a.ts') });
    const index = await indexFor(service);
    index.set('a.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });
    setBatchHandler(null);

    // the batch handler is private; drive it through the public path with a
    // git snapshot that moved
    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    enqueueChange(uri(p('src', 'b.ts')), 'watcher');
    vol.writeFileSync(head, 'ref: refs/heads/feature\n');
    await flushNow();

    const [plan] = plansOf();
    expect(plan.source).toBe('git');
    const reasons = plan.items.map((i: any) => [path.basename(i.localPath), i.reason]).sort();
    expect(reasons).toEqual([['a.ts', 'modified'], ['b.ts', 'new']]);
  });

  test('a directory in the batch is expanded into its files, without duplicates', async () => {
    vol.fromJSON({
      [p('src', 'dir', 'one.ts')]: '1',
      [p('src', 'dir', 'deep', 'two.ts')]: '22',
      [p('src', 'dir', 'skip.log')]: 'log',
    });
    installServices(fakeService(p('src'), { ignore: (fsPath: string) => /\.log$/.test(fsPath) }));

    enqueueChange(uri(p('src', 'dir')), 'watcher');
    enqueueChange(uri(p('src', 'dir', 'one.ts')), 'watcher');
    await flushNow();

    const [plan] = plansOf();
    expect(plan.items.map((i: any) => path.basename(i.localPath)).sort()).toEqual(['one.ts', 'two.ts']);
  });

  test('a path that vanished before the batch is left out; an empty batch makes no plan', async () => {
    enqueueChange(uri(p('src', 'gone.ts')), 'watcher');
    await flushNow();

    expect(plansOf()).toEqual([]);
    expect(confirmAndRunPlanMock).not.toHaveBeenCalled();
  });

  test('setBatchHandler(null) restores the default plan-and-run', async () => {
    vol.fromJSON({ [p('src', 'a.ts')]: 'x' });
    setBatchHandler(async () => undefined);
    setBatchHandler(null);

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    await flushNow();

    expect(confirmAndRunPlanMock).toHaveBeenCalledTimes(1);
  });

  test('planSourceFor: git wins, then watcher, poll, scan; saves alone are a command', () => {
    const batchOf = (gitDriven: boolean, ...sources: any[]) => ({
      service: {} as any,
      gitDriven,
      items: sources.map(source => change({ source })),
    });
    expect(planSourceFor(batchOf(true, 'save'))).toBe('git');
    expect(planSourceFor(batchOf(false, 'save', 'watcher'))).toBe('watcher');
    expect(planSourceFor(batchOf(false, 'poll', 'scan'))).toBe('poll');
    expect(planSourceFor(batchOf(false, 'scan'))).toBe('scan');
    expect(planSourceFor(batchOf(false, 'save'))).toBe('command');
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

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
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

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    await flushNow();

    expect(seen.length).toBe(2);
    expect(names(seen[1])).toEqual(['late.ts']);
    expect(pendingCount()).toBe(0);
  });

  test('is a no-op on an empty queue', async () => {
    const seen = collectBatches();
    await flushNow();
    expect(seen).toEqual([]);
  });
});

describe('git awareness', () => {
  const gitNow = (state: { busy: boolean; ref: string | null }) => () => state;

  test('isGitDriven: git was busy when the change was queued', () => {
    expect(
      isGitDriven(change({ gitBusyWhenQueued: true }), gitNow({ busy: false, ref: 'refs/heads/main' }))
    ).toBe(true);
  });

  test('isGitDriven: git is busy now', () => {
    expect(isGitDriven(change(), gitNow({ busy: true, ref: 'refs/heads/main' }))).toBe(true);
  });

  test('isGitDriven: HEAD moved to another ref since the change was queued', () => {
    expect(isGitDriven(change(), gitNow({ busy: false, ref: 'refs/heads/feature' }))).toBe(true);
    expect(isGitDriven(change(), gitNow({ busy: false, ref: 'detached:abc123' }))).toBe(true);
  });

  test('isGitDriven: nothing changed', () => {
    expect(isGitDriven(change(), gitNow({ busy: false, ref: 'refs/heads/main' }))).toBe(false);
  });

  test('isGitDriven: outside a repository it is never git', () => {
    expect(
      isGitDriven(change({ gitHeadWhenQueued: null }), gitNow({ busy: false, ref: 'refs/heads/main' }))
    ).toBe(false);
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

  test('a checkout to a detached HEAD flags the batch', async () => {
    const head = path.join(root, '.git', 'HEAD');
    vol.fromJSON({ [head]: 'ref: refs/heads/main\n' });
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    vol.writeFileSync(head, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n');

    await flushNow();

    expect(seen[0].gitDriven).toBe(true);
  });

  test('a commit on the same branch is not a checkout', async () => {
    const gitDir = path.join(root, '.git');
    vol.fromJSON({
      [path.join(gitDir, 'HEAD')]: 'ref: refs/heads/main\n',
      [path.join(gitDir, 'refs', 'heads', 'main')]: 'aaaa\n',
    });
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    // git commit: the branch moves, HEAD still points at it
    vol.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), 'bbbb\n');

    await flushNow();

    expect(seen[0].gitDriven).toBe(false);
  });

  test('a `git status` taking index.lock for an instant is not git', async () => {
    const gitDir = path.join(root, '.git');
    vol.fromJSON({ [path.join(gitDir, 'HEAD')]: 'ref: refs/heads/main\n' });
    vol.writeFileSync(path.join(gitDir, 'index.lock'), '');
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    await flushNow();

    expect(seen[0].gitDriven).toBe(false);
    expect(seen[0].items[0].gitBusyWhenQueued).toBe(false);
  });

  test('an index.lock held for longer than a moment is git', async () => {
    const gitDir = path.join(root, '.git');
    vol.fromJSON({ [path.join(gitDir, 'HEAD')]: 'ref: refs/heads/main\n' });
    const lock = path.join(gitDir, 'index.lock');
    vol.writeFileSync(lock, '');
    const old = new Date(Date.now() - 5000);
    vol.utimesSync(lock, old, old);
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    await flushNow();

    expect(seen[0].gitDriven).toBe(true);
  });

  test('a merge or rebase marker is git whatever the lock', async () => {
    const gitDir = path.join(root, '.git');
    vol.fromJSON({
      [path.join(gitDir, 'HEAD')]: 'ref: refs/heads/main\n',
      [path.join(gitDir, 'MERGE_HEAD')]: 'cccc\n',
    });
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    await flushNow();

    expect(seen[0].gitDriven).toBe(true);
  });

  test('a repeat of the same path keeps the earliest git snapshot', async () => {
    const head = path.join(root, '.git', 'HEAD');
    vol.fromJSON({ [head]: 'ref: refs/heads/main\n' });
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'scan');
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

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
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

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    advance(BATCH_INTERVAL - 100);
    enqueueChange(uri(p('src', 'b.ts')), 'watcher');
    advance(200);
    // the first change is past its own window, but the second restarted it
    expect(seen).toEqual([]);

    advance(BATCH_INTERVAL);
    expect(seen.length).toBe(1);
    expect(names(seen[0]).sort()).toEqual(['a.ts', 'b.ts']);

    await flushNow();
    expect(seen.length).toBe(1);
  });

  test('a file rewritten continuously cannot starve the batch: maxWait caps the window', async () => {
    const seen = collectBatches();

    // a log rewritten every 300 ms, for ever
    for (let elapsed = 0; elapsed <= MAX_WAIT; elapsed += 300) {
      enqueueChange(uri(p('src', 'app.log')), 'watcher');
      advance(300);
    }

    expect(seen.length).toBeGreaterThanOrEqual(1);
    await flushNow();
  });

  test('an ignored path does not restart the window', async () => {
    installServices(
      fakeService(p('src'), { ignore: (fsPath: string) => /\.log$/.test(fsPath) })
    );
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'watcher');
    advance(BATCH_INTERVAL - 100);
    enqueueChange(uri(p('src', 'noise.log')), 'watcher');
    advance(100);

    // fired at its own window, the ignored event did not push it back
    expect(seen.length).toBe(1);
    await flushNow();
  });

  test('a save does not wait for the window', () => {
    const seen = collectBatches();

    enqueueChange(uri(p('src', 'a.ts')), 'save');

    expect(seen.length).toBe(1);
  });
});
