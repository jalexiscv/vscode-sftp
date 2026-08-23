// The default vscode mock answers every lookup with "Nothing", and that makes
// `x instanceof Uri` true for any x — which is exactly the branch the file
// handlers take to tell a context from a Uri. Give them a real Uri class and
// keep "Nothing" for everything else.
jest.mock('vscode', () => {
  const Nothing = jest.requireActual('../../../__mocks__/vscode.js');
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
// the handler factory only needs the registry for Uri contexts; mocking it
// keeps the connection layer (and the fileHandlers <-> serviceManager cycle)
// out of this test
jest.mock('../../modules/serviceManager', () => ({ getFileService: jest.fn() }));

import app from '../../app';
import { TransferFailedError } from '../../core';
import { markReported } from '../../helper';
import * as activityLog from '../../modules/activityLog';
import createFileHandler, { FileHandlerContext } from '../createFileHandler';

/**
 * The Activity view is fed per task by the transfer hooks, so a handler that
 * fails before any task starts (connection refused, bad password, lstat of
 * the source, ensureDir of the target) used to leave no entry and no retry.
 * The factory now records those itself, for transfer handlers only.
 */

const { ActivityKind, ActivityStatus } = activityLog;

function contextFor(): FileHandlerContext {
  return {
    fileService: { name: 'staging' } as any,
    config: {} as any,
    target: { localFsPath: '/local/site/a.txt', remoteFsPath: '/remote/site/a.txt' } as any,
  };
}

const connectionRefused = () =>
  Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), { code: 'ECONNREFUSED' });

async function rejectionOf(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('createFileHandler: failures before any task runs', () => {
  let stopSpinner: jest.SpyInstance;

  beforeAll(() => {
    // the spinner arms an interval per handler call; keep the worker clean
    jest.spyOn(app.sftpBarItem, 'startSpinner').mockImplementation(() => undefined);
    stopSpinner = jest.spyOn(app.sftpBarItem, 'stopSpinner').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    activityLog.__resetForTest();
    app.state.profile = null;
    stopSpinner.mockClear();
  });

  test('an upload that fails before its tasks leaves a failed, retryable entry', async () => {
    app.state.profile = 'prod';
    const failure = connectionRefused();
    const upload = createFileHandler<{}>({
      name: 'upload file',
      handle: () => Promise.reject(failure),
    });

    const error = await rejectionOf(upload(contextFor()));

    expect(error).toBe(failure);
    const entries = activityLog.getEntries();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.kind).toBe(ActivityKind.Upload);
    expect(entry.status).toBe(ActivityStatus.Failed);
    expect(entry.localPath).toBe('/local/site/a.txt');
    expect(entry.remotePath).toBe('/remote/site/a.txt');
    expect(entry.serviceName).toBe('staging');
    expect(entry.profile).toBe('prod');
    expect(entry.error).toBe('connect ECONNREFUSED 10.0.0.1:22');
    expect(entry.finishedAt).toBeDefined();
    expect(typeof entry.retry).toBe('function');
    // the failure did not leave the status bar spinning
    expect(stopSpinner).toHaveBeenCalledTimes(1);
  });

  test('retry re-runs the handler with the same context and options', async () => {
    const handle = jest
      .fn()
      .mockImplementationOnce(() => Promise.reject(connectionRefused()))
      .mockImplementation(() => Promise.resolve());
    const upload = createFileHandler<{ force?: boolean }>({
      name: 'upload',
      handle,
      transformOption: () => ({ force: false }),
    });
    const ctx = contextFor();

    await rejectionOf(upload(ctx, { force: true }));
    const [entry] = activityLog.getEntries();
    await expect(entry.retry!()).resolves.toBeUndefined();

    expect(handle).toHaveBeenCalledTimes(2);
    // `this` is the handler context, the argument the merged option
    expect(handle.mock.instances[1]).toBe(ctx);
    expect(handle.mock.calls[1][0]).toEqual({ force: true });
    // a retry that works records nothing here: its tasks have their own hooks
    expect(activityLog.getEntries()).toHaveLength(1);
  });

  test('download and sync handlers record their own kind', async () => {
    const download = createFileHandler<{}>({
      name: 'download folder',
      handle: () => Promise.reject(connectionRefused()),
    });
    const sync = createFileHandler<{}>({
      name: 'sync remote ➞ local',
      handle: () => Promise.reject(connectionRefused()),
    });

    await rejectionOf(download(contextFor()));
    await rejectionOf(sync(contextFor()));

    // newest first
    expect(activityLog.getEntries().map(e => e.kind)).toEqual([
      ActivityKind.Sync,
      ActivityKind.Download,
    ]);
  });

  test('an error already reported elsewhere is not recorded again', async () => {
    const upload = createFileHandler<{}>({
      name: 'upload file',
      handle: () => Promise.reject(markReported(new Error('already on screen'))),
    });

    await rejectionOf(upload(contextFor()));

    expect(activityLog.getEntries()).toEqual([]);
  });

  test('a partially failed batch keeps only its per-task entries', async () => {
    // what the transfer handlers throw after scheduler.run(): every failed
    // task was already recorded by afterTransfer
    const aggregate = markReported(new TransferFailedError([], 3, 'upload'));
    const afterHandle = jest.fn();
    const upload = createFileHandler<{}>({
      name: 'upload folder',
      handle: () => Promise.reject(aggregate),
      afterHandle,
    });

    const error = await rejectionOf(upload(contextFor()));

    expect(error).toBe(aggregate);
    expect(afterHandle).toHaveBeenCalledTimes(1);
    expect(activityLog.getEntries()).toEqual([]);
  });

  test('handlers that are not transfers are left alone', async () => {
    for (const name of ['removeRemote', 'rename', 'diff', 'createRemoteFile', 'createRemoteFolder']) {
      const handler = createFileHandler<{}>({
        name,
        handle: () => Promise.reject(connectionRefused()),
      });
      await rejectionOf(handler(contextFor()));
    }

    expect(activityLog.getEntries()).toEqual([]);
  });

  test('a handler that resolves records nothing', async () => {
    const upload = createFileHandler<{}>({ name: 'upload file', handle: () => Promise.resolve() });

    await upload(contextFor());

    expect(activityLog.getEntries()).toEqual([]);
  });

  test('the error message falls back to String(error) for non-Error rejections', async () => {
    const upload = createFileHandler<{}>({
      name: 'upload file',
      handle: () => Promise.reject('plain string failure'),
    });

    await rejectionOf(upload(contextFor()));

    expect(activityLog.getEntries()[0].error).toBe('plain string failure');
  });
});
