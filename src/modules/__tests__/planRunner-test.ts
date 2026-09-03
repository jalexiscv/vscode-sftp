jest.mock('fs');
// a real Uri class: the handler context tells a Uri from a context with
// instanceof, and UResource.from needs Uri.file/parse to build real objects
jest.mock('vscode', () => require('../../../test/helper/vscodeMock').createVscodeMock());
// the explorer refresh needs a live remote explorer; here it only has to be
// observable
jest.mock('../../fileHandlers/shared', () => ({
  refreshRemoteExplorer: jest.fn(() => Promise.resolve()),
}));
// the registry would drag the connection layer in; the runner only needs
// "which service owns this path"
jest.mock('../serviceManager', () => ({
  getFileService: jest.fn(),
  getRunningTransformTasks: jest.fn(() => []),
  getAllFileService: jest.fn(() => []),
}));
// the open documents decide whether an automatic plan may touch a file; the
// default vscode mock has none
jest.mock('../../host', () => ({
  ...jest.requireActual('../../host'),
  getOpenTextDocuments: jest.fn(() => []),
}));

import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { vol } from 'memfs';
import app from '../../app';
import FileService from '../../core/fileService';
import RemoteFs from '../../../test/helper/localRemoteFs';
import { refreshRemoteExplorer } from '../../fileHandlers/shared';
import { getOpenTextDocuments } from '../../host';
import { getFileService } from '../serviceManager';
import { initSyncIndex, __resetForTest as resetSyncIndex } from '../syncIndex';
import { indexFor } from '../syncIndexFeeder';
import {
  createPlan,
  getPlan,
  UploadPlan,
  UploadPlanItemDraft,
  __resetForTest as resetPlans,
} from '../uploadPlan';
import {
  runPlan,
  skipItem,
  isPlanRunning,
  onDidChangeRunning,
  whenIdle,
  __resetForTest as resetRunner,
} from '../planRunner';

/**
 * The plan runner end to end over memfs: items become tasks on one scheduler,
 * and every outcome (verified, failed, skipped, stale, cancelled) is written
 * back to the plan.
 */

// a failed verification retries with a real delay; the cases here disable
// retries, but keep the budget generous for slow machines
jest.setTimeout(30000);

const getFileServiceMock = getFileService as jest.Mock;
const refreshMock = refreshRemoteExplorer as jest.Mock;

type TestFs = InstanceType<typeof RemoteFs> & { put: any };

function createRemoteFs(Ctor: new (...args: any[]) => any = RemoteFs as any): TestFs {
  return new Ctor(path, { clientOption: {} as any, remoteTimeOffsetInHours: 0 });
}

const baseConfig = {
  protocol: 'sftp',
  concurrency: 2,
  useTempFile: false,
  openSsh: false,
  remotePath: '/remote',
  host: 'example.test',
  port: 22,
  ignore: null,
  verifyUpload: 'stat',
  uploadRetries: 0,
};

function createService(remoteFs: TestFs, configOverrides: any = {}): FileService {
  const service = new FileService('/local', '/local', {} as any);
  service.name = 'staging';
  (service as any).getRemoteFileSystem = () => Promise.resolve(remoteFs);
  (service as any).getConfig = () => ({ ...baseConfig, ...configOverrides });
  getFileServiceMock.mockImplementation(() => service);
  return service;
}

// the helper defines its methods as non-writable prototype properties, so a
// plain assignment is rejected; shadow them on the instance instead
function override(remoteFs: TestFs, method: string, impl: (...args: any[]) => any) {
  Object.defineProperty(remoteFs, method, { value: impl, configurable: true });
}

function failPutFor(remoteFs: TestFs, shouldFail: (target: string) => boolean) {
  const put = remoteFs.put.bind(remoteFs);
  override(remoteFs, 'put', (input: Readable, target: string, option: any) => {
    if (shouldFail(target)) {
      return Promise.reject(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
    }
    return put(input, target, option);
  });
}

// a target whose put rewrites the *local* source after consuming it: what a
// build watcher does to a file while it is being uploaded
function rewriteSourceDuringPut(remoteFs: TestFs, times: number) {
  const put = remoteFs.put.bind(remoteFs);
  let rewrites = 0;
  override(remoteFs, 'put', async (input: Readable, target: string, option: any) => {
    await put(input, target, option);
    if (rewrites < times) {
      rewrites++;
      const local = target.replace('/remote', '/local');
      fs.appendFileSync(local, '+');
    }
  });
}

function draft(fsPath: string, overrides: Partial<UploadPlanItemDraft> = {}): UploadPlanItemDraft {
  const stat = fs.statSync(fsPath);
  return {
    localPath: fsPath,
    remotePath: fsPath.replace('/local', '/remote'),
    reason: 'modified',
    localSize: stat.size,
    localMtime: stat.mtime.getTime(),
    ...overrides,
  };
}

function planOf(items: UploadPlanItemDraft[], profile: string | null = null): UploadPlan {
  return createPlan({ serviceName: 'staging', profile, source: 'scan', items });
}

function itemOf(plan: UploadPlan, name: string) {
  return getPlan(plan.id)!.items.find(item => path.basename(item.localPath) === name)!;
}

let startSpinner: jest.SpyInstance;
let stopSpinner: jest.SpyInstance;

beforeAll(() => {
  // the spinner arms an interval; not what is under test here
  startSpinner = jest.spyOn(app.sftpBarItem, 'startSpinner').mockImplementation(() => undefined);
  stopSpinner = jest.spyOn(app.sftpBarItem, 'stopSpinner').mockImplementation(() => undefined);
});

afterAll(() => {
  startSpinner.mockRestore();
  stopSpinner.mockRestore();
});

const getOpenTextDocumentsMock = getOpenTextDocuments as jest.Mock;

beforeEach(() => {
  vol.reset();
  fs.mkdirSync('/remote', { recursive: true } as any);
  resetPlans();
  resetRunner();
  resetSyncIndex();
  initSyncIndex({ storagePath: undefined });
  refreshMock.mockClear();
  getFileServiceMock.mockReset();
  getOpenTextDocumentsMock.mockReset();
  getOpenTextDocumentsMock.mockImplementation(() => []);
  app.state.profile = null;
});

describe('runPlan', () => {
  test('uploads every pending item through one scheduler and verifies them', async () => {
    vol.fromJSON({ '/local/dir/a.txt': 'aaa', '/local/dir/b.txt': 'bb' }, '/');
    createService(createRemoteFs());
    const plan = planOf([draft('/local/dir/a.txt'), draft('/local/dir/b.txt')]);

    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ total: 2, verified: 2, failed: 0, pending: 0 });
    expect(fs.readFileSync('/remote/dir/a.txt', 'utf8')).toBe('aaa');
    expect(fs.readFileSync('/remote/dir/b.txt', 'utf8')).toBe('bb');
    const a = itemOf(plan, 'a.txt');
    expect(a.status).toBe('verified');
    expect(a.attempts).toBe(1);
    expect(a.startedAt).toBeDefined();
    expect(a.finishedAt).toBeDefined();
    expect(getPlan(plan.id)!.finishedAt).toBeDefined();
    // the explorer sees the new files, once per service
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  test('a failed task marks its item failed with the error and the attempts; the rest go through', async () => {
    vol.fromJSON({ '/local/a.txt': 'a', '/local/b.txt': 'b' }, '/');
    const remoteFs = createRemoteFs();
    failPutFor(remoteFs, target => path.basename(target) === 'b.txt');
    createService(remoteFs);
    const plan = planOf([draft('/local/a.txt'), draft('/local/b.txt')]);

    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ verified: 1, failed: 1 });
    const b = itemOf(plan, 'b.txt');
    expect(b.status).toBe('failed');
    expect(b.error).toBe('Permission denied');
    expect(b.attempts).toBe(1);
    expect(itemOf(plan, 'a.txt').status).toBe('verified');
  });

  test('a file that vanished locally is skipped, not failed', async () => {
    vol.fromJSON({ '/local/a.txt': 'a', '/local/gone.txt': 'g' }, '/');
    createService(createRemoteFs());
    const plan = planOf([draft('/local/a.txt'), draft('/local/gone.txt')]);
    fs.unlinkSync('/local/gone.txt');

    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ verified: 1, skipped: 1, failed: 0 });
    const gone = itemOf(plan, 'gone.txt');
    expect(gone.status).toBe('skipped');
    expect(gone.error).toBe('missing locally');
  });

  test('a file that changed before its upload is refreshed, not stale', async () => {
    vol.fromJSON({ '/local/a.txt': 'one' }, '/');
    createService(createRemoteFs());
    // the plan still holds the stat of an older version
    const plan = planOf([draft('/local/a.txt', { localSize: 1, localMtime: 1 })]);

    await runPlan(plan.id);

    const a = itemOf(plan, 'a.txt');
    expect(a.status).toBe('verified');
    expect(a.localSize).toBe(3);
    expect(a.localMtime).toBe(fs.statSync('/local/a.txt').mtime.getTime());
    expect(fs.readFileSync('/remote/a.txt', 'utf8')).toBe('one');
  });

  test('a file rewritten during its upload is stale and uploaded once more', async () => {
    vol.fromJSON({ '/local/s.txt': 'v1' }, '/');
    const remoteFs = createRemoteFs();
    rewriteSourceDuringPut(remoteFs, 1);
    createService(remoteFs);
    const plan = planOf([draft('/local/s.txt')]);

    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ verified: 1, stale: 0 });
    const s = itemOf(plan, 's.txt');
    expect(s.status).toBe('verified');
    expect(s.localSize).toBe(3);
    // the second pass sent the rewritten content
    expect(fs.readFileSync('/remote/s.txt', 'utf8')).toBe('v1+');
  });

  test('a file that keeps changing stays stale after the second pass', async () => {
    vol.fromJSON({ '/local/s.txt': 'v1' }, '/');
    const remoteFs = createRemoteFs();
    rewriteSourceDuringPut(remoteFs, 5);
    createService(remoteFs);
    const plan = planOf([draft('/local/s.txt')]);

    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ stale: 1, verified: 0 });
    const s = itemOf(plan, 's.txt');
    expect(s.status).toBe('stale');
    expect(s.error).toBe('changed during upload');
    // exactly two uploads: the first and the one retry
    expect(fs.readFileSync('/remote/s.txt', 'utf8')).toBe('v1+');
    expect(fs.readFileSync('/local/s.txt', 'utf8')).toBe('v1++');
  });

  test('itemPaths narrows the run to those items', async () => {
    vol.fromJSON({ '/local/a.txt': 'a', '/local/b.txt': 'b' }, '/');
    createService(createRemoteFs());
    const plan = planOf([draft('/local/a.txt'), draft('/local/b.txt')]);

    const summary = await runPlan(plan.id, { itemPaths: ['/local/a.txt'] });

    expect(summary).toMatchObject({ verified: 1, pending: 1 });
    expect(itemOf(plan, 'a.txt').status).toBe('verified');
    expect(itemOf(plan, 'b.txt').status).toBe('pending');
    expect(fs.existsSync('/remote/b.txt')).toBe(false);
  });

  test('only pending, stale and failed items run; a failed one can be retried', async () => {
    vol.fromJSON({ '/local/a.txt': 'a', '/local/b.txt': 'b' }, '/');
    const remoteFs = createRemoteFs();
    let failB = true;
    failPutFor(remoteFs, target => failB && path.basename(target) === 'b.txt');
    createService(remoteFs);
    const plan = planOf([
      draft('/local/a.txt'),
      draft('/local/b.txt'),
      draft('/local/a.txt', { localPath: '/local/skipped.txt', status: 'skipped' } as any),
    ]);

    await runPlan(plan.id);
    expect(itemOf(plan, 'b.txt').status).toBe('failed');
    expect(itemOf(plan, 'skipped.txt').status).toBe('skipped');

    failB = false;
    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ verified: 2, failed: 0, skipped: 1 });
    expect(itemOf(plan, 'b.txt').status).toBe('verified');
    expect(itemOf(plan, 'b.txt').error).toBeUndefined();
  });

  test('a second call while the plan runs joins the run instead of starting another', async () => {
    vol.fromJSON({ '/local/a.txt': 'a' }, '/');
    const remoteFs = createRemoteFs();
    let puts = 0;
    const put = remoteFs.put.bind(remoteFs);
    override(remoteFs, 'put', (...args: any[]) => {
      puts++;
      return put(...args);
    });
    createService(remoteFs);
    const plan = planOf([draft('/local/a.txt')]);

    const first = runPlan(plan.id);
    const second = runPlan(plan.id);
    expect(second).toBe(first);
    expect(isPlanRunning(plan.id)).toBe(true);

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(puts).toBe(1);
    expect(isPlanRunning(plan.id)).toBe(false);
  });

  test('onDidChangeRunning fires when a run starts and ends; whenIdle waits for it', async () => {
    vol.fromJSON({ '/local/a.txt': 'a' }, '/');
    createService(createRemoteFs());
    const plan = planOf([draft('/local/a.txt')]);
    const states: boolean[] = [];
    const subscription = onDidChangeRunning(() => states.push(isPlanRunning(plan.id)));

    const run = runPlan(plan.id);
    expect(states).toEqual([true]);
    await whenIdle();
    expect(isPlanRunning(plan.id)).toBe(false);
    expect(states).toEqual([true, false]);
    await run;
    subscription.dispose();
  });

  test('rejects only for an unknown plan', async () => {
    await expect(runPlan('nope')).rejects.toThrow('Upload plan "nope" not found');
  });

  test('a plan built under another profile is not run against the active one', async () => {
    vol.fromJSON({ '/local/a.txt': 'a' }, '/');
    const service = createService(createRemoteFs());
    (service as any).getAvailableProfiles = () => ['dev', 'prod'];
    app.state.profile = 'prod';
    const plan = planOf([draft('/local/a.txt')], 'dev');

    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ failed: 1 });
    expect(itemOf(plan, 'a.txt').error).toBe(
      'plan was built for profile "dev" but "prod" is active'
    );
    expect(fs.existsSync('/remote/a.txt')).toBe(false);
  });

  test('a path the config ignores is skipped, one no service covers fails', async () => {
    vol.fromJSON({ '/local/a.txt': 'a', '/local/debug.log': 'l', '/elsewhere/x.txt': 'x' }, '/');
    const service = createService(createRemoteFs(), {
      ignore: (fsPath: string) => /\.log$/.test(fsPath),
    });
    getFileServiceMock.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath.indexOf('/local') === 0 ? service : undefined
    );
    const plan = planOf([draft('/local/a.txt'), draft('/local/debug.log'), draft('/elsewhere/x.txt')]);

    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ verified: 1, skipped: 1, failed: 1 });
    expect(itemOf(plan, 'debug.log').error).toBe('ignored by config');
    expect(itemOf(plan, 'x.txt').error).toBe('no configuration covers this path');
  });

  test('a path uploadExclude matches is skipped, and the item says why', async () => {
    vol.fromJSON({ '/local/a.txt': 'a', '/local/storage/app.log': 'l' }, '/');
    const service = createService(createRemoteFs(), {
      uploadExclude: (fsPath: string) => /storage/.test(fsPath),
    });
    getFileServiceMock.mockImplementation(() => service);
    const plan = planOf([draft('/local/a.txt'), draft('/local/storage/app.log')]);

    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ verified: 1, skipped: 1, failed: 0 });
    expect(itemOf(plan, 'app.log').error).toBe('excluded from upload (uploadExclude)');
    expect(fs.existsSync('/remote/storage')).toBe(false);
  });

  test('a connection failure fails every item of the service with the message', async () => {
    vol.fromJSON({ '/local/a.txt': 'a', '/local/b.txt': 'b' }, '/');
    const service = createService(createRemoteFs());
    (service as any).getRemoteFileSystem = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const plan = planOf([draft('/local/a.txt'), draft('/local/b.txt')]);

    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ failed: 2 });
    expect(itemOf(plan, 'a.txt').error).toBe('connect ECONNREFUSED');
  });

  test('a cancelled task puts its item back to pending', async () => {
    vol.fromJSON({ '/local/a.txt': 'a' }, '/');
    const remoteFs = createRemoteFs();
    const service = createService(remoteFs);
    override(
      remoteFs,
      'put',
      (input: Readable) =>
        new Promise<void>((resolve, reject) => {
          input.once('error', reject);
          // the user hits "Cancel All Transfers" mid-upload
          service.cancelTransferTasks();
        })
    );
    const plan = planOf([draft('/local/a.txt')]);

    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ pending: 1, failed: 0, verified: 0 });
    expect(itemOf(plan, 'a.txt').status).toBe('pending');
  });

  test('the live remotePath wins over the one stored in the item', async () => {
    vol.fromJSON({ '/local/a.txt': 'a' }, '/');
    createService(createRemoteFs(), { remotePath: '/elsewhere' });
    const plan = planOf([draft('/local/a.txt')]);

    await runPlan(plan.id);

    expect(itemOf(plan, 'a.txt').remotePath).toBe('/elsewhere/a.txt');
    expect(fs.readFileSync('/elsewhere/a.txt', 'utf8')).toBe('a');
  });
});

  test('"Cancel All Transfers" puts every item whose task never ran back to pending, not only the running one', async () => {
    vol.fromJSON({ '/local/a.txt': 'a', '/local/b.txt': 'b', '/local/c.txt': 'c' }, '/');
    const remoteFs = createRemoteFs();
    const service = createService(remoteFs, { concurrency: 1 });
    let cancelled = false;
    const put = remoteFs.put.bind(remoteFs);
    override(remoteFs, 'put', (input: Readable, target: string, option: any) => {
      if (cancelled) {
        return put(input, target, option);
      }
      cancelled = true;
      return new Promise<void>((resolve, reject) => {
        input.once('error', reject);
        // the user hits "Cancel All Transfers" while the first file uploads;
        // the other two are still queued and never get a task.done
        service.cancelTransferTasks();
      });
    });
    const plan = planOf([draft('/local/a.txt'), draft('/local/b.txt'), draft('/local/c.txt')]);

    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ pending: 3, uploading: 0, failed: 0, verified: 0 });
    expect(getPlan(plan.id)!.items.map(item => item.status)).toEqual(['pending', 'pending', 'pending']);
    // the plan is not left open for ever and can be run again
    expect(isPlanRunning(plan.id)).toBe(false);
    const again = await runPlan(plan.id);
    expect(again).toMatchObject({ verified: 3, pending: 0 });
    expect(fs.readFileSync('/remote/c.txt', 'utf8')).toBe('c');
  });

  test('an automatic plan skips a file that is open with unsaved changes; a command plan uploads it', async () => {
    vol.fromJSON({ '/local/dirty.txt': 'on disk', '/local/clean.txt': 'clean' }, '/');
    createService(createRemoteFs());
    const save = jest.fn(() => Promise.resolve(true));
    getOpenTextDocumentsMock.mockImplementation(() => [
      { fileName: '/local/dirty.txt', isDirty: true, isClosed: false, save },
      { fileName: '/local/clean.txt', isDirty: false, isClosed: false, save },
    ]);

    const scanPlan = planOf([draft('/local/dirty.txt'), draft('/local/clean.txt')]);
    const summary = await runPlan(scanPlan.id);

    expect(summary).toMatchObject({ verified: 1, skipped: 1, failed: 0 });
    expect(itemOf(scanPlan, 'dirty.txt').status).toBe('skipped');
    expect(itemOf(scanPlan, 'dirty.txt').error).toBe('unsaved changes in the editor');
    expect(save).not.toHaveBeenCalled();
    expect(fs.existsSync('/remote/dirty.txt')).toBe(false);
    expect(fs.readFileSync('/remote/clean.txt', 'utf8')).toBe('clean');

    // the user asked for it: the transfer layer saves the document first
    const commandPlan = createPlan({
      serviceName: 'staging',
      profile: null,
      source: 'command',
      items: [draft('/local/dirty.txt')],
    });
    const commandSummary = await runPlan(commandPlan.id);
    expect(commandSummary).toMatchObject({ verified: 1, skipped: 0 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync('/remote/dirty.txt', 'utf8')).toBe('on disk');
  });

  test('the remote directory is ensured once per directory, not once per file', async () => {
    const files: { [fsPath: string]: string } = {};
    for (let i = 0; i < 10; i++) {
      files[`/local/dir/f${i}.txt`] = `${i}`;
    }
    files['/local/other/x.txt'] = 'x';
    vol.fromJSON(files, '/');
    const remoteFs = createRemoteFs();
    const ensured: string[] = [];
    const ensureDir = remoteFs.ensureDir.bind(remoteFs);
    override(remoteFs, 'ensureDir', (dir: string) => {
      ensured.push(dir);
      return ensureDir(dir);
    });
    createService(remoteFs);
    const plan = planOf(Object.keys(files).map(fsPath => draft(fsPath)));

    const summary = await runPlan(plan.id);

    expect(summary).toMatchObject({ verified: 11, failed: 0 });
    expect(ensured.sort()).toEqual(['/remote/dir', '/remote/other']);
    expect(fs.readFileSync('/remote/dir/f9.txt', 'utf8')).toBe('9');
  });
});

describe('skipItem', () => {
  test('takes a pending, failed or stale item out; leaves the others alone', async () => {
    vol.fromJSON({ '/local/a.txt': 'a', '/local/b.txt': 'b' }, '/');
    createService(createRemoteFs());
    const plan = planOf([draft('/local/a.txt'), draft('/local/b.txt')]);
    await runPlan(plan.id, { itemPaths: ['/local/a.txt'] });

    skipItem(plan.id, '/local/b.txt');
    skipItem(plan.id, '/local/a.txt');
    skipItem('nope', '/local/b.txt');

    expect(itemOf(plan, 'b.txt').status).toBe('skipped');
    expect(itemOf(plan, 'b.txt').error).toBe('skipped by user');
    expect(itemOf(plan, 'a.txt').status).toBe('verified');
    expect(getPlan(plan.id)!.finishedAt).toBeDefined();
  });

  test('remembers the skipped version in the sync index', async () => {
    vol.fromJSON({ '/local/b.txt': 'bb' }, '/');
    const service = createService(createRemoteFs());
    const plan = planOf([draft('/local/b.txt')]);

    skipItem(plan.id, '/local/b.txt');
    // the index write is best effort and not awaited by skipItem
    await new Promise(resolve => setTimeout(resolve, 10));

    const index = await indexFor(service);
    expect(index.get('b.txt')).toMatchObject({
      size: 2,
      mtime: fs.statSync('/local/b.txt').mtime.getTime(),
      status: 'skipped',
    });
  });
});
