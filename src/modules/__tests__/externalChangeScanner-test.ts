jest.mock('fs');
// the scanner only needs the list of services; the real registry would drag
// the connection layer in
jest.mock('../serviceManager', () => ({
  getAllFileService: jest.fn(() => []),
  getFileService: jest.fn(),
  getRunningTransformTasks: jest.fn(() => []),
}));
// the confirmation gate (and the runner behind it) is observed, not exercised
jest.mock('../planConfirmation', () => ({
  confirmAndRunPlan: jest.fn((plan: any) =>
    Promise.resolve({ decision: 'run', summary: require('../uploadPlan').summarize(plan) })
  ),
}));
// the default vscode mock returns a value that never settles when awaited;
// the prompts and the progress notification need real answers
jest.mock('../../host', () => ({
  ...jest.requireActual('../../host'),
  showInformationMessage: jest.fn(() => Promise.resolve(undefined)),
  showChoiceMessage: jest.fn(() => Promise.resolve(undefined)),
  executeCommand: jest.fn(() => Promise.resolve()),
  withProgress: jest.fn((_options: any, task: any) =>
    task(
      { report: () => undefined },
      { isCancellationRequested: false, onCancellationRequested: () => undefined }
    )
  ),
}));

import * as path from 'path';
import { vol } from 'memfs';
import app from '../../app';
import { STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED } from '../../constants';
import { getAllFileService } from '../serviceManager';
import { confirmAndRunPlan } from '../planConfirmation';
import { showInformationMessage, showChoiceMessage } from '../../host';
import { setPaused, __resetForTest as resetSyncControl } from '../syncControl';
import { initSyncIndex, __resetForTest as resetSyncIndex } from '../syncIndex';
import { indexFor } from '../syncIndexFeeder';
import { getPlans, createPlan, __resetForTest as resetPlans } from '../uploadPlan';
import { computeCounters } from '../uploadStatus';
import RemoteFs from '../../../test/helper/localRemoteFs';
import {
  runScan,
  scanService,
  scanAll,
  rebuildSyncIndex,
  rebuildSyncIndexInteractive,
  formatRebuildSummary,
  markLocalTreeAsUploaded,
  markLocalTreeAsUploadedInteractive,
  formatMarkUploadedSummary,
  init,
  destroy,
  testHooks,
  __resetForTest,
} from '../externalChangeScanner';

/**
 * Reconciliation by scan: what gets planned, what gets skipped, what an
 * unbuilt index holds back, and how the index is seeded from the server.
 */

const {
  isTriggerEnabled,
  pollTick,
  onWindowStateChanged,
  onPauseStateChanged,
  FOCUS_MIN_INTERVAL_MS,
  BUILD_INDEX_LABEL,
  MARK_ALL_UPLOADED_LABEL,
  DONT_SHOW_AGAIN_LABEL,
} = testHooks;

const getAllFileServiceMock = getAllFileService as jest.Mock;
const confirmAndRunPlanMock = confirmAndRunPlan as jest.Mock;
const showInformationMessageMock = showInformationMessage as jest.Mock;
const showChoiceMessageMock = showChoiceMessage as jest.Mock;

// the real gate, for the cases where the answer matters (it is mocked above
// so the rest of the file can observe what it is handed)
const realConfirmAndRunPlan = jest.requireActual('../planConfirmation').confirmAndRunPlan;

// a context whose workspaceState remembers what it is told
function fakeContext(state: { [key: string]: any } = {}) {
  return {
    subscriptions: [],
    workspaceState: {
      get: jest.fn((key: string) => state[key]),
      update: jest.fn((key: string, value: any) => {
        state[key] = value;
        return Promise.resolve();
      }),
    },
  } as any;
}

const baseDir = path.resolve(path.sep, 'ws');
const p = (...segments: string[]) => path.join(baseDir, ...segments);

function createRemoteFs() {
  // posix paths for the remote side, as a real server would report them
  return new RemoteFs(path.posix, { clientOption: {} as any, remoteTimeOffsetInHours: 0 });
}

let remoteFs = createRemoteFs();

function fakeService(config: any = {}, watcher?: any) {
  return {
    id: 1,
    name: 'staging',
    baseDir,
    workspace: baseDir,
    // the watcher block is root config: getConfig() carries it too
    getConfig: () => ({
      host: 'example.test',
      port: 22,
      remotePath: '/remote',
      protocol: 'sftp',
      ignore: null,
      watcher,
      ...config,
    }),
    getRemoteFileSystem: () => Promise.resolve(remoteFs),
    getWatcherConfig: () => watcher,
    cancelTransferTasks: jest.fn(),
  } as any;
}

// a local file whose index entry matches it exactly
async function indexed(service: any, relPath: string) {
  const stat = vol.statSync(p(...relPath.split('/')));
  const index = await indexFor(service);
  index.set(relPath, {
    size: stat.size,
    mtime: stat.mtime.getTime(),
    verifiedAt: 1,
    status: 'verified',
  });
  return index;
}

let showMsg: jest.SpyInstance;

beforeAll(() => {
  // the status bar arms reset timers per message, which would keep the
  // worker alive after the run
  showMsg = jest.spyOn(app.sftpBarItem, 'showMsg').mockImplementation(() => undefined);
});

afterAll(() => {
  showMsg.mockRestore();
});

beforeEach(() => {
  vol.reset();
  remoteFs = createRemoteFs();
  __resetForTest();
  resetSyncControl();
  resetSyncIndex();
  resetPlans();
  initSyncIndex({ storagePath: undefined });
  confirmAndRunPlanMock.mockClear();
  showInformationMessageMock.mockClear();
  showChoiceMessageMock.mockReset();
  showChoiceMessageMock.mockImplementation(() => Promise.resolve(undefined));
  getAllFileServiceMock.mockReset();
  getAllFileServiceMock.mockImplementation(() => []);
  app.state.profile = null;
});

afterEach(() => {
  destroy();
  resetSyncIndex();
});

describe('runScan', () => {
  test('an empty index plans nothing and offers to build it, once per service', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a' });
    const service = fakeService();

    const outcome = await runScan(service, 'startup');

    expect(outcome.status).toBe('empty-index');
    expect(outcome.plan).toBeNull();
    expect(confirmAndRunPlanMock).not.toHaveBeenCalled();
    expect(showInformationMessageMock).toHaveBeenCalledTimes(1);
    expect(showInformationMessageMock.mock.calls[0][0]).toContain('sync index for staging is empty');
    expect(showInformationMessageMock.mock.calls[0].slice(1)).toEqual([
      BUILD_INDEX_LABEL,
      MARK_ALL_UPLOADED_LABEL,
      DONT_SHOW_AGAIN_LABEL,
    ]);

    await runScan(service, 'resume');
    expect(showInformationMessageMock).toHaveBeenCalledTimes(1);
  });

  test('"Build index now" rebuilds the index from the server', async () => {
    vol.fromJSON({ [p('a.ts')]: 'same', '/remote/a.ts': 'same' });
    showInformationMessageMock.mockResolvedValueOnce('Build index now');
    const service = fakeService();

    await runScan(service, 'startup');
    await new Promise(resolve => setTimeout(resolve, 30));

    expect((await indexFor(service)).get('a.ts')).toBeDefined();
    // the summary of the rebuild
    expect(showInformationMessageMock).toHaveBeenCalledTimes(2);
    expect(showInformationMessageMock.mock.calls[1][0]).toContain('Indexed 1 files');
  });

  test('a manual scan with an empty index plans every file as new', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a', [p('dir', 'b.ts')]: 'b' });
    const service = fakeService();

    const outcome = await runScan(service, 'manual');

    expect(outcome.status).toBe('planned');
    expect(outcome.plan!.items.map(i => i.reason)).toEqual(['new', 'new']);
    expect(showInformationMessageMock).not.toHaveBeenCalled();
  });

  test('up to date when every file matches its verified entry', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a', [p('dir', 'b.ts')]: 'b' });
    const service = fakeService();
    await indexed(service, 'a.ts');
    await indexed(service, 'dir/b.ts');

    const outcome = await runScan(service, 'startup');

    expect(outcome).toMatchObject({ status: 'up-to-date', plan: null, filesScanned: 2 });
    expect(getPlans()).toEqual([]);
    expect(await scanService(service, 'startup')).toBeNull();
  });

  test('a changed file becomes a scan plan handed to the confirmation', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a', [p('b.ts')]: 'bb' });
    const service = fakeService({ externalChanges: { confirmThreshold: 7 } });
    await indexed(service, 'a.ts');
    const index = await indexFor(service);
    index.set('b.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });

    const outcome = await runScan(service, 'startup');

    expect(outcome.status).toBe('planned');
    expect(outcome.decision).toBe('run');
    const plan = outcome.plan!;
    expect(plan.source).toBe('scan');
    expect(plan.serviceName).toBe('staging');
    expect(plan.items.length).toBe(1);
    expect(plan.items[0]).toMatchObject({
      localPath: p('b.ts'),
      remotePath: '/remote/b.ts',
      reason: 'modified',
      localSize: 2,
    });
    // the service goes along so a "Skip" can be remembered in its index
    expect(confirmAndRunPlanMock).toHaveBeenCalledWith(plan, {
      serviceName: 'staging',
      host: 'example.test',
      confirmThreshold: 7,
      service,
    });
    expect(await scanService(service, 'manual')).not.toBeNull();
  });

  test('a poll produces a poll plan', async () => {
    vol.fromJSON({ [p('a.ts')]: 'new' });
    const service = fakeService({}, { files: '**/*', pollInterval: 1000 });
    const index = await indexFor(service);
    index.set('a.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });

    const outcome = await runScan(service, 'poll');

    expect(outcome.plan!.source).toBe('poll');
  });

  test('automatic triggers are skipped while paused; a manual scan runs', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a' });
    const service = fakeService();
    await indexed(service, 'a.ts');
    setPaused(true);

    expect((await runScan(service, 'startup')).status).toBe('skipped');
    expect((await runScan(service, 'poll')).status).toBe('skipped');
    expect((await runScan(service, 'manual')).status).toBe('up-to-date');
  });

  test('the externalChanges flags gate their triggers', () => {
    const config = (external: any, pollInterval?: number) =>
      ({ externalChanges: external, watcher: { pollInterval } } as any);

    expect(isTriggerEnabled(config({ scanOnStartup: false }), 'startup')).toBe(false);
    expect(isTriggerEnabled(config({ scanOnStartup: false }), 'config')).toBe(false);
    expect(isTriggerEnabled(config({ scanOnStartup: false }), 'resume')).toBe(true);
    expect(isTriggerEnabled(config({ scanOnResume: false }), 'resume')).toBe(false);
    expect(isTriggerEnabled(config({ scanOnResume: false }), 'focus')).toBe(false);
    expect(isTriggerEnabled(config({ scanOnResume: false }), 'startup')).toBe(true);
    expect(isTriggerEnabled(config({}, 0), 'poll')).toBe(false);
    expect(isTriggerEnabled(config({}, 5000), 'poll')).toBe(true);
    expect(isTriggerEnabled(config({ scanOnStartup: false, scanOnResume: false }), 'manual')).toBe(
      true
    );
  });

  test('a disabled trigger reports skipped', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a' });
    const service = fakeService({ externalChanges: { scanOnStartup: false } });
    await indexed(service, 'a.ts');

    const outcome = await runScan(service, 'startup');

    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toMatch(/disabled/);
  });

  test('an automatic scan waits while an earlier scan plan is pending review; a manual one supersedes it', async () => {
    vol.fromJSON({ [p('a.ts')]: 'new' });
    const service = fakeService();
    const index = await indexFor(service);
    index.set('a.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });
    // the user chose "Review plan" on the previous scan
    confirmAndRunPlanMock.mockResolvedValueOnce({ decision: 'review', summary: {} });
    const first = await runScan(service, 'startup');
    expect(first.plan!.items[0].status).toBe('pending');

    const second = await runScan(service, 'focus');
    expect(second.status).toBe('skipped');
    expect(second.reason).toMatch(/pending review/);

    const third = await runScan(service, 'manual');
    expect(third.status).toBe('planned');
    expect(first.plan!.items[0].status).toBe('skipped');
    expect(first.plan!.items[0].error).toBe('superseded by a newer scan');
    expect(getPlans().length).toBe(2);
  });

  test('a scan already running for the service is joined, not duplicated', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a' });
    const service = fakeService();
    await indexed(service, 'a.ts');

    const first = runScan(service, 'startup');
    const second = runScan(service, 'focus');

    expect(second).toBe(first);
    expect((await first).status).toBe('up-to-date');
  });

  test('a cooperative cancellation stops the scan', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a' });
    const service = fakeService();
    await indexed(service, 'a.ts');

    const outcome = await runScan(service, 'manual', { isCancelled: () => true });

    expect(outcome.status).toBe('cancelled');
    expect(getPlans()).toEqual([]);
  });

  test('an unusable config is an error outcome, not a throw', async () => {
    const broken = fakeService();
    broken.getConfig = () => {
      throw new Error('Unkown Profile');
    };

    const outcome = await runScan(broken, 'startup');

    expect(outcome.status).toBe('error');
    expect(outcome.reason).toBe('Unkown Profile');
  });

  test('scanAll scans every service, one after another', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a' });
    const one = fakeService();
    const two = { ...fakeService(), id: 2, name: 'other', baseDir: path.resolve(path.sep, 'other') };
    await indexed(one, 'a.ts');
    getAllFileServiceMock.mockImplementation(() => [one, two]);

    await scanAll('startup');

    // "one" was up to date, "two" had an empty index and was told so
    expect(showInformationMessageMock).toHaveBeenCalledTimes(1);
    expect(showInformationMessageMock.mock.calls[0][0]).toContain('other');
  });
});

describe('first use: an index that was never built', () => {
  // five files the index has never seen, one it knows and that matches
  async function freshCheckout() {
    vol.fromJSON({
      [p('known.ts')]: 'k',
      [p('n1.ts')]: '1',
      [p('n2.ts')]: '2',
      [p('n3.ts')]: '3',
      [p('dir', 'n4.ts')]: '4',
      [p('dir', 'n5.ts')]: '5',
    });
    const service = fakeService();
    const index = await indexed(service, 'known.ts');
    return { service, index };
  }

  test('an automatic scan neither uploads nor asks about unindexed files; it says so once', async () => {
    const { service, index } = await freshCheckout();
    expect(index.isSeeded()).toBe(false);

    const outcome = await runScan(service, 'startup');

    expect(outcome.status).toBe('up-to-date');
    expect(outcome.plan).toBeNull();
    expect(outcome.ignoredNew).toBe(5);
    expect(confirmAndRunPlanMock).not.toHaveBeenCalled();
    expect(getPlans()).toEqual([]);
    // nothing for the status bar to count as pending either
    expect(computeCounters(0, getPlans())).toEqual({ pending: 0, failed: 0 });
    expect(showInformationMessageMock).toHaveBeenCalledTimes(1);
    expect(showInformationMessageMock.mock.calls[0][0]).toContain('is not built yet; 5 unindexed file(s)');
    expect(showInformationMessageMock.mock.calls[0].slice(1)).toEqual([
      BUILD_INDEX_LABEL,
      MARK_ALL_UPLOADED_LABEL,
      DONT_SHOW_AGAIN_LABEL,
    ]);

    // the next automatic scans stay quiet this session
    await runScan(service, 'focus');
    await runScan(service, 'poll');
    expect(showInformationMessageMock).toHaveBeenCalledTimes(1);
    expect(getPlans()).toEqual([]);
  });

  test('an automatic scan still plans the files the index knows and that changed', async () => {
    const { service } = await freshCheckout();
    vol.writeFileSync(p('known.ts'), 'known, but longer');

    const outcome = await runScan(service, 'resume');

    expect(outcome.status).toBe('planned');
    expect(outcome.ignoredNew).toBe(5);
    expect(outcome.plan!.items.map(i => [path.basename(i.localPath), i.reason])).toEqual([
      ['known.ts', 'modified'],
    ]);
    expect(confirmAndRunPlanMock).toHaveBeenCalledTimes(1);
  });

  test('a manual scan plans everything, and a confirmed run that finishes seeds the index', async () => {
    const { service, index } = await freshCheckout();
    confirmAndRunPlanMock.mockImplementationOnce((plan: any) => {
      // the run went through: every item verified (and, as the feeder would,
      // recorded in the index), the plan closed
      const { updateItem, summarize } = require('../uploadPlan');
      const { toRelPath } = require('../syncIndex');
      plan.items.forEach((item: any) => {
        updateItem(plan.id, item.localPath, { status: 'verified' });
        index.set(toRelPath(baseDir, item.localPath), {
          size: item.localSize,
          mtime: item.localMtime,
          verifiedAt: 1,
          status: 'verified',
        });
      });
      return Promise.resolve({ decision: 'run', summary: summarize(plan) });
    });

    const outcome = await runScan(service, 'manual');

    expect(outcome.status).toBe('planned');
    expect(outcome.ignoredNew).toBeUndefined();
    expect(outcome.plan!.items.length).toBe(5);
    expect(outcome.plan!.items.every(i => i.reason === 'new')).toBe(true);
    expect(index.isSeeded()).toBe(true);
    expect(showInformationMessageMock).not.toHaveBeenCalled();

    // from now on an automatic scan treats unindexed files as new (and asks
    // about them: see planConfirmation)
    vol.writeFileSync(p('later.ts'), 'later');
    const next = await runScan(service, 'startup');
    expect(next.status).toBe('planned');
    expect(next.plan!.items.map(i => [path.basename(i.localPath), i.reason])).toEqual([
      ['later.ts', 'new'],
    ]);
    expect(next.ignoredNew).toBeUndefined();
  });

  test('a manual scan whose plan is marked as uploaded seeds the index too', async () => {
    const { service, index } = await freshCheckout();
    confirmAndRunPlanMock.mockImplementationOnce((plan: any) => {
      const { updateItem, summarize } = require('../uploadPlan');
      plan.items.forEach((item: any) => updateItem(plan.id, item.localPath, { status: 'assumed' }));
      return Promise.resolve({ decision: 'assume', summary: summarize(plan) });
    });

    const outcome = await runScan(service, 'manual');

    expect(outcome.decision).toBe('assume');
    expect(index.isSeeded()).toBe(true);
  });

  test('"Mark all as uploaded" on the notice seeds the index from the local tree after a confirmation', async () => {
    const { service, index } = await freshCheckout();
    showInformationMessageMock.mockResolvedValueOnce(MARK_ALL_UPLOADED_LABEL);
    showChoiceMessageMock.mockImplementationOnce((_message: string, choices: string[]) =>
      Promise.resolve(choices[0])
    );

    await runScan(service, 'startup');
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(showChoiceMessageMock).toHaveBeenCalledTimes(1);
    const [message, choices, modal] = showChoiceMessageMock.mock.calls[0];
    expect(message).toContain('record 6 local file(s) as already uploaded to staging - example.test');
    expect(choices).toEqual(['Mark 6 file(s) as uploaded']);
    expect(modal).toEqual({ modal: true });
    expect(index.isSeeded()).toBe(true);
    expect(index.size).toBe(6);
    expect(index.get('dir/n5.ts')).toMatchObject({ status: 'verified', assumed: true });
    // the summary
    expect(showInformationMessageMock).toHaveBeenCalledTimes(2);
    expect(showInformationMessageMock.mock.calls[1][0]).toContain(
      '6 local file(s) recorded as uploaded'
    );

    // from now on only what changes is proposed, and the notice is gone
    vol.writeFileSync(p('n1.ts'), 'one, edited');
    const next = await runScan(service, 'startup');
    expect(next.plan!.items.map(i => [path.basename(i.localPath), i.reason])).toEqual([
      ['n1.ts', 'modified'],
    ]);
    expect(showInformationMessageMock).toHaveBeenCalledTimes(2);
  });

  test('a manual scan that was skipped, reviewed or cancelled does not seed the index', async () => {
    const { service, index } = await freshCheckout();
    confirmAndRunPlanMock.mockImplementationOnce((plan: any) =>
      Promise.resolve({ decision: 'review', summary: require('../uploadPlan').summarize(plan) })
    );

    await runScan(service, 'manual');
    expect(index.isSeeded()).toBe(false);

    // the run was interrupted: items still pending
    confirmAndRunPlanMock.mockImplementationOnce((plan: any) =>
      Promise.resolve({ decision: 'run', summary: require('../uploadPlan').summarize(plan) })
    );
    await runScan(service, 'manual');
    expect(index.isSeeded()).toBe(false);
  });

  test('a manual scan that finds the tree up to date seeds the index', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a' });
    const service = fakeService();
    const index = await indexed(service, 'a.ts');

    expect((await runScan(service, 'startup')).status).toBe('up-to-date');
    expect(index.isSeeded()).toBe(false);
    expect((await runScan(service, 'manual')).status).toBe('up-to-date');
    expect(index.isSeeded()).toBe(true);
  });

  test('"Don\'t show again" is remembered per workspace; a dismissed notice comes back next session only', async () => {
    const { service, index } = await freshCheckout();
    getAllFileServiceMock.mockImplementation(() => [service]);
    const state: { [key: string]: any } = {};
    init(fakeContext(state));
    await new Promise(resolve => setTimeout(resolve, 30));
    // the startup scan of init already showed the notice once
    expect(showInformationMessageMock).toHaveBeenCalledTimes(1);
    await runScan(service, 'focus');
    expect(showInformationMessageMock).toHaveBeenCalledTimes(1);

    // a new session: shown again, and this time dismissed for good
    __resetForTest();
    showInformationMessageMock.mockClear();
    showInformationMessageMock.mockResolvedValueOnce(DONT_SHOW_AGAIN_LABEL);
    init(fakeContext(state));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(showInformationMessageMock).toHaveBeenCalledTimes(1);
    expect(state[STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED]).toEqual([index.key]);

    // the session after that: nothing
    __resetForTest();
    showInformationMessageMock.mockClear();
    init(fakeContext(state));
    await new Promise(resolve => setTimeout(resolve, 30));
    await runScan(service, 'focus');
    expect(showInformationMessageMock).not.toHaveBeenCalled();

    // building the index clears the mark: it has no reason to exist any more
    await rebuildSyncIndex(service);
    expect(state[STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED]).toEqual([]);
  });

  test('"Skip" on a scan plan is remembered: the same versions are not planned again', async () => {
    vol.fromJSON({ [p('a.ts')]: 'aa', [p('b.ts')]: 'bbb' });
    const service = fakeService({ externalChanges: { confirmThreshold: 0 } });
    const index = await indexFor(service);
    index.set('a.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });
    index.set('b.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });
    confirmAndRunPlanMock.mockImplementationOnce(realConfirmAndRunPlan);
    showChoiceMessageMock.mockResolvedValueOnce('Skip');

    const first = await runScan(service, 'startup');
    expect(first.decision).toBe('skip');
    expect(index.get('a.ts')).toMatchObject({ size: 2, status: 'skipped' });
    expect(index.get('b.ts')).toMatchObject({ size: 3, status: 'skipped' });

    // next startup: nothing to ask about
    const second = await runScan(service, 'startup');
    expect(second.status).toBe('up-to-date');
    expect(getPlans().length).toBe(1);

    // until one of them changes
    vol.writeFileSync(p('b.ts'), 'b changed');
    const third = await runScan(service, 'startup');
    expect(third.status).toBe('planned');
    expect(third.plan!.items.map(i => [path.basename(i.localPath), i.reason])).toEqual([
      ['b.ts', 'modified'],
    ]);
  });

  test('once seeded, an automatic scan with new files asks even below the threshold', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a', [p('fresh.ts')]: 'f' });
    const service = fakeService({ externalChanges: { confirmThreshold: 20 } });
    const index = await indexed(service, 'a.ts');
    index.markSeeded();
    confirmAndRunPlanMock.mockImplementationOnce(realConfirmAndRunPlan);
    showChoiceMessageMock.mockResolvedValueOnce('Review plan');

    const outcome = await runScan(service, 'startup');

    expect(outcome.status).toBe('planned');
    expect(outcome.decision).toBe('review');
    expect(showChoiceMessageMock).toHaveBeenCalledTimes(1);
    expect(showChoiceMessageMock.mock.calls[0][1][0]).toBe('Review plan');
    expect(outcome.plan!.items[0].status).toBe('pending');
  });

  test('focus scans run one service after another, not in parallel', async () => {
    vol.fromJSON({ [p('a.ts')]: 'new' });
    const one = fakeService();
    const other = path.resolve(path.sep, 'other');
    vol.fromJSON({ [path.join(other, 'b.ts')]: 'new' });
    const two = { ...fakeService(), id: 2, name: 'other', baseDir: other };
    (await indexFor(one)).set('a.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });
    (await indexFor(two)).set('b.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });
    getAllFileServiceMock.mockImplementation(() => [one, two]);

    let release: () => void = () => undefined;
    confirmAndRunPlanMock.mockImplementationOnce(
      (plan: any) =>
        new Promise(resolve => {
          release = () =>
            resolve({ decision: 'run', summary: require('../uploadPlan').summarize(plan) });
        })
    );

    onWindowStateChanged({ focused: true } as any);
    await new Promise(resolve => setTimeout(resolve, 30));
    // the first confirmation is still open: the second service waits
    expect(getPlans().length).toBe(1);
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(getPlans().length).toBe(2);
  });

  test('a scan that blows up restores the status bar', async () => {
    vol.fromJSON({ [p('a.ts')]: 'new' });
    // no remote path: the plan items cannot be resolved, after "scanning…"
    const service = fakeService({ remotePath: undefined });
    (await indexFor(service)).set('a.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });

    await expect(runScan(service, 'manual')).rejects.toBeDefined();

    const lastMessage = showMsg.mock.calls[showMsg.mock.calls.length - 1];
    expect(lastMessage[0]).toBe('scan of staging failed');
    expect(lastMessage[1]).toBe(2000);
  });
});

describe('triggers', () => {
  let now: number;
  let clock: jest.SpyInstance;

  beforeEach(() => {
    now = 1700000000000;
    clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    clock.mockRestore();
  });

  async function serviceWithChange(watcher?: any) {
    vol.fromJSON({ [p('a.ts')]: 'new' });
    const service = fakeService({}, watcher);
    const index = await indexFor(service);
    index.set('a.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });
    getAllFileServiceMock.mockImplementation(() => [service]);
    return service;
  }

  const settle = () => new Promise(resolve => setTimeout(resolve, 30));

  test('the poll timer scans a service once its interval elapsed, not before', async () => {
    await serviceWithChange({ files: '**/*', pollInterval: 1000 });

    pollTick();
    now += 999;
    pollTick();
    await settle();
    expect(getPlans().length).toBe(0);

    now += 1;
    pollTick();
    await settle();
    expect(getPlans().length).toBe(1);
    expect(getPlans()[0].source).toBe('poll');
  });

  test('the poll timer ignores a service without pollInterval', async () => {
    await serviceWithChange({ files: '**/*', autoUpload: true });

    pollTick();
    now += 60000;
    pollTick();
    await settle();

    expect(getPlans().length).toBe(0);
  });

  test('regaining focus scans only when the last scan is old enough', async () => {
    const service = await serviceWithChange();
    const context = { subscriptions: [] } as any;
    init(context);
    // init seeds "just scanned" for the existing services and kicks the
    // startup scan, which here finds the change
    await settle();
    expect(getPlans().length).toBe(1);
    resetPlans();
    confirmAndRunPlanMock.mockResolvedValue({ decision: 'run', summary: {} });

    onWindowStateChanged({ focused: true } as any);
    await settle();
    expect(getPlans().length).toBe(0);

    now += FOCUS_MIN_INTERVAL_MS;
    onWindowStateChanged({ focused: true } as any);
    await settle();
    expect(getPlans().length).toBe(1);

    onWindowStateChanged({ focused: false } as any);
    await settle();
    expect(getPlans().length).toBe(1);
    expect(service.getWatcherConfig()).toBeUndefined();
  });

  test('resuming automatic sync scans; pausing does not', async () => {
    await serviceWithChange();
    init({ subscriptions: [] } as any);
    await settle();
    resetPlans();

    setPaused(true);
    onPauseStateChanged();
    await settle();
    expect(getPlans().length).toBe(0);

    setPaused(false);
    onPauseStateChanged();
    await settle();
    expect(getPlans().length).toBe(1);
  });

  test('destroy stops the scans in flight and the timer', async () => {
    await serviceWithChange({ files: '**/*', pollInterval: 1000 });
    init({ subscriptions: [] } as any);
    destroy();
    resetPlans();

    now += 5000;
    pollTick();
    await settle();

    expect(getPlans().length).toBe(0);
  });
});

describe('rebuildSyncIndex', () => {
  function setMtime(fsPath: string, ms: number) {
    vol.utimesSync(fsPath, new Date(ms), new Date(ms));
  }

  test('records the files present on both sides with the same size, and marks the index as built', async () => {
    vol.fromJSON({
      [p('same.txt')]: 'same',
      [p('dir', 'deep.txt')]: 'deep',
      [p('differ.txt')]: 'local version',
      [p('only-local.txt')]: 'x',
      [p('node_modules', 'dep.js')]: 'ignored',
      '/remote/same.txt': 'same',
      '/remote/dir/deep.txt': 'deep',
      '/remote/differ.txt': 'remote',
      '/remote/only-remote.txt': 'y',
      '/remote/.sftp-trash/old.txt': 'trash',
      '/remote/node_modules/dep.js': 'ignored',
    });
    const t = 1700000000000;
    setMtime(p('same.txt'), t);
    setMtime('/remote/same.txt', t + 1500);
    setMtime(p('dir', 'deep.txt'), t);
    setMtime('/remote/dir/deep.txt', t);
    const service = fakeService({ ignore: (fsPath: string) => /node_modules/.test(fsPath) });

    const summary = await rebuildSyncIndex(service);

    expect(summary).toEqual({
      indexed: 2,
      differ: 1,
      mtimeDiffer: 0,
      onlyLocal: 1,
      onlyRemote: 1,
      cancelled: false,
    });
    const index = await indexFor(service);
    expect(index.get('same.txt')).toMatchObject({ size: 4, mtime: t, remoteSize: 4, status: 'verified' });
    expect(index.get('dir/deep.txt')).toBeDefined();
    expect(index.get('differ.txt')).toBeUndefined();
    expect(index.get('only-local.txt')).toBeUndefined();
    expect(index.size).toBe(2);
    expect(index.isSeeded()).toBe(true);
  });

  test('a different mtime does not prevent indexing by size; it is only counted (not on ftp)', async () => {
    vol.fromJSON({ [p('a.txt')]: 'abc', '/remote/a.txt': 'abc' });
    const t = 1700000000000;
    setMtime(p('a.txt'), t);
    // a git/rsync deploy: same content, another mtime on the server
    setMtime('/remote/a.txt', t + 3000);

    const sftp = await rebuildSyncIndex(fakeService());
    expect(sftp).toMatchObject({ indexed: 1, differ: 0, mtimeDiffer: 1 });
    // the LOCAL mtime is the baseline the next scans compare against
    const index = await indexFor(fakeService());
    expect(index.get('a.txt')).toMatchObject({ size: 3, mtime: t, remoteMtime: t + 3000 });
    expect((await runScan(fakeService(), 'startup')).status).toBe('up-to-date');

    expect(await rebuildSyncIndex(fakeService({ protocol: 'ftp' }))).toMatchObject({
      indexed: 1,
      differ: 0,
      mtimeDiffer: 0,
    });
  });

  test('a remote directory matched by a "dir/" pattern is pruned', async () => {
    vol.fromJSON({
      [p('a.txt')]: 'a',
      '/remote/a.txt': 'a',
      '/remote/cache/x.txt': 'x',
      '/remote/cache/deep/y.txt': 'y',
    });
    const service = fakeService({
      ignore: (fsPath: string, isDirectory?: boolean) => isDirectory === true && /\/cache$/.test(fsPath),
    });

    const summary = await rebuildSyncIndex(service);

    expect(summary).toMatchObject({ indexed: 1, onlyRemote: 0 });
  });

  test('replaces the previous index, and leaves it alone when cancelled', async () => {
    vol.fromJSON({ [p('a.txt')]: 'a', '/remote/a.txt': 'a' });
    setMtime(p('a.txt'), 1700000000000);
    setMtime('/remote/a.txt', 1700000000000);
    const service = fakeService();
    const index = await indexFor(service);
    index.set('stale.txt', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });

    const cancelled = await rebuildSyncIndex(service, { isCancelled: () => true });
    expect(cancelled.cancelled).toBe(true);
    expect(index.get('stale.txt')).toBeDefined();

    await rebuildSyncIndex(service);
    expect(index.get('stale.txt')).toBeUndefined();
    expect(index.get('a.txt')).toBeDefined();
  });

  test('reports progress from both sides', async () => {
    vol.fromJSON({ [p('a.txt')]: 'a', [p('b.txt')]: 'b', '/remote/a.txt': 'a' });
    const progress: any[] = [];

    await rebuildSyncIndex(fakeService(), { onProgress: report => progress.push({ ...report }) });

    expect(progress[progress.length - 1]).toEqual({ localFiles: 2, remoteFiles: 1 });
  });

  test('a directory that fails to list is skipped, not fatal', async () => {
    vol.fromJSON({ [p('a.txt')]: 'a', '/remote/a.txt': 'a', '/remote/locked/x.txt': 'x' });
    const list = remoteFs.list.bind(remoteFs);
    Object.defineProperty(remoteFs, 'list', {
      value: (dir: string) =>
        /locked/.test(dir) ? Promise.reject(new Error('Permission denied')) : list(dir),
      configurable: true,
    });

    const summary = await rebuildSyncIndex(fakeService());

    expect(summary.onlyRemote).toBe(0);
    expect(summary.indexed + summary.differ).toBe(1);
  });

  test('formatRebuildSummary', () => {
    expect(
      formatRebuildSummary({
        indexed: 1234,
        differ: 12,
        mtimeDiffer: 0,
        onlyLocal: 3,
        onlyRemote: 0,
        cancelled: false,
      })
    ).toBe(`Indexed ${(1234).toLocaleString()} files; 12 differ in size, 3 only local.`);
    expect(
      formatRebuildSummary({
        indexed: 10,
        differ: 0,
        mtimeDiffer: 4,
        onlyLocal: 0,
        onlyRemote: 0,
        cancelled: false,
      })
    ).toBe(
      'Indexed 10 files; 0 differ in size. 4 of the indexed files have another mtime on the ' +
        'server (matched by size).'
    );
    expect(
      formatRebuildSummary({
        indexed: 0,
        differ: 0,
        mtimeDiffer: 0,
        onlyLocal: 0,
        onlyRemote: 0,
        cancelled: true,
      })
    ).toMatch(/cancelled/);
  });

  test('the interactive variant shows the summary', async () => {
    vol.fromJSON({ [p('a.txt')]: 'a', '/remote/a.txt': 'a' });
    setMtime(p('a.txt'), 1700000000000);
    setMtime('/remote/a.txt', 1700000000000);

    await rebuildSyncIndexInteractive(fakeService());

    expect(showInformationMessageMock).toHaveBeenCalledTimes(1);
    expect(showInformationMessageMock.mock.calls[0][0]).toBe(
      'SFTP: staging: Indexed 1 files; 0 differ in size.'
    );
  });

  test('createPlan is untouched by a rebuild (sanity)', () => {
    createPlan({ serviceName: 'staging', profile: null, source: 'scan', items: [] });
    expect(getPlans().length).toBe(1);
  });
});

describe('markLocalTreeAsUploaded', () => {
  test('records every local file as assumed-verified, replaces the old index and seeds it; the server is never listed', async () => {
    vol.fromJSON({
      [p('a.ts')]: 'a',
      [p('dir', 'b.ts')]: 'bb',
      [p('.git', 'HEAD')]: 'ref',
      '/remote/only-remote.ts': 'r',
    });
    const service = fakeService({ ignore: (fsPath: string) => /[\\/]\.git([\\/]|$)/.test(fsPath) });
    // it must not even connect
    service.getRemoteFileSystem = jest.fn(() => Promise.reject(new Error('no connection expected')));
    const index = await indexFor(service);
    index.set('gone.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });
    index.set('a.ts', { size: 9, mtime: 9, verifiedAt: 0, status: 'failed', error: 'EACCES' });
    const progress: number[] = [];

    const summary = await markLocalTreeAsUploaded(service, { onProgress: files => progress.push(files) });

    expect(summary).toEqual({ marked: 2, settledPlanItems: 0, cancelled: false });
    expect(service.getRemoteFileSystem).not.toHaveBeenCalled();
    expect(index.isSeeded()).toBe(true);
    expect(index.size).toBe(2);
    expect(index.get('gone.ts')).toBeUndefined();
    expect(index.get('a.ts')).toEqual({
      size: 1,
      mtime: vol.statSync(p('a.ts')).mtime.getTime(),
      verifiedAt: expect.any(Number),
      status: 'verified',
      assumed: true,
    });
    expect(index.get('dir/b.ts')).toMatchObject({ size: 2, status: 'verified', assumed: true });
    expect(index.get('.git/HEAD')).toBeUndefined();
    expect(progress.length).toBeGreaterThan(0);
    expect(formatMarkUploadedSummary(summary)).toBe(
      '2 local file(s) recorded as uploaded; from now on only files that change are proposed.'
    );

    // the next scan finds the tree up to date
    expect((await runScan(service, 'startup')).status).toBe('up-to-date');
  });

  test('settles the open items of this service\'s plans and leaves other services alone', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a', [p('b.ts')]: 'b' });
    const service = fakeService();
    const item = (name: string) => ({
      localPath: p(name),
      remotePath: `/remote/${name}`,
      reason: 'new' as const,
      localSize: 1,
      localMtime: 1,
    });
    const mine = createPlan({ serviceName: 'staging', profile: null, source: 'scan', items: [item('a.ts'), item('b.ts')] });
    const { updateItem } = require('../uploadPlan');
    updateItem(mine.id, p('b.ts'), { status: 'failed', error: 'EACCES' });
    const theirs = createPlan({ serviceName: 'other', profile: null, source: 'scan', items: [item('a.ts')] });

    const summary = await markLocalTreeAsUploaded(service);

    expect(summary.settledPlanItems).toBe(2);
    expect(mine.items.map(i => i.status)).toEqual(['assumed', 'assumed']);
    expect(mine.items[1].error).toBeUndefined();
    expect(mine.finishedAt).toBeDefined();
    expect(theirs.items[0].status).toBe('pending');
    expect(formatMarkUploadedSummary(summary)).toContain('2 pending plan item(s) were settled too.');
    // an automatic scan is no longer blocked behind the plan
    expect((await runScan(service, 'focus')).status).toBe('up-to-date');
  });

  test('a cancelled scan or a declined confirmation leaves the index as it was', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a' });
    const service = fakeService();
    const index = await indexFor(service);
    index.set('keep.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });

    const declined = await markLocalTreeAsUploaded(service, { confirm: () => Promise.resolve(false) });
    expect(declined).toEqual({ marked: 0, settledPlanItems: 0, cancelled: true });
    expect(formatMarkUploadedSummary(declined)).toContain('left as it was');

    const cancelled = await markLocalTreeAsUploaded(service, { isCancelled: () => true });
    expect(cancelled.cancelled).toBe(true);

    expect(index.isSeeded()).toBe(false);
    expect(index.size).toBe(1);
    expect(index.get('keep.ts')).toBeDefined();
  });

  test('the interactive form confirms with the count, then reports; a dismissed dialog writes nothing', async () => {
    vol.fromJSON({ [p('a.ts')]: 'a', [p('b.ts')]: 'b' });
    const service = fakeService();
    const index = await indexFor(service);

    // dismissed: showChoiceMessage resolves undefined by default
    let summary = await markLocalTreeAsUploadedInteractive(service);
    expect(summary.cancelled).toBe(true);
    expect(index.size).toBe(0);
    expect(showInformationMessageMock).toHaveBeenCalledTimes(1);
    expect(showInformationMessageMock.mock.calls[0][0]).toBe(
      'SFTP: staging: Nothing was marked; the sync index was left as it was.'
    );

    showChoiceMessageMock.mockImplementationOnce((_message: string, choices: string[]) =>
      Promise.resolve(choices[0])
    );
    summary = await markLocalTreeAsUploadedInteractive(service);
    expect(summary).toEqual({ marked: 2, settledPlanItems: 0, cancelled: false });
    expect(showChoiceMessageMock.mock.calls[1][1]).toEqual(['Mark 2 file(s) as uploaded']);
    expect(index.isSeeded()).toBe(true);
    expect(showInformationMessageMock.mock.calls[1][0]).toBe(
      'SFTP: staging: 2 local file(s) recorded as uploaded; from now on only files that change are proposed.'
    );
  });
});

describe('uploadExclude', () => {
  // what a `/storage` pattern resolves to, on either side and either separator
  const excludeStorage = (fsPath: string) => /[\\/]storage([\\/]|$)/.test(fsPath);

  test('a scan leaves an excluded directory alone', async () => {
    vol.fromJSON({ [p('a.txt')]: 'a', [p('storage', 'app.log')]: 'never uploaded' });
    const service = fakeService({ uploadExclude: excludeStorage });
    const index = await indexed(service, 'a.txt');
    index.markSeeded();

    const outcome = await runScan(service, 'manual');

    expect(outcome.status).toBe('up-to-date');
    expect(outcome.filesScanned).toBe(1);
  });

  test('a rebuild prunes it on both sides, like ignore', async () => {
    vol.fromJSON({
      [p('a.txt')]: 'a',
      [p('storage', 'app.log')]: 'local log',
      '/remote/a.txt': 'a',
      '/remote/storage/app.log': 'remote log',
      '/remote/storage/uploads/photo.jpg': 'photo',
    });
    const service = fakeService({ uploadExclude: excludeStorage });

    const summary = await rebuildSyncIndex(service);

    expect(summary).toMatchObject({ indexed: 1, differ: 0, onlyLocal: 0, onlyRemote: 0 });
    expect((await indexFor(service)).get('storage/app.log')).toBeUndefined();
  });
});
