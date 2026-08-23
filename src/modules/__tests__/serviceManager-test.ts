import * as path from 'path';
import app from '../../app';
import { TransferDirection } from '../../core';
import * as activityLog from '../activityLog';
import { createFileService, disposeFileService } from '../serviceManager';

/**
 * The Activity view is fed from the transfer hooks installed here, one entry
 * per task, so commands, uploadOnSave and the watcher all show up the same way
 * without each caller recording anything.
 */

const { ActivityKind, ActivityStatus } = activityLog;

const workspace = path.resolve(path.sep, 'ws');

function fakeTask(
  run: () => Promise<void>,
  options: { cancelled?: boolean; direction?: TransferDirection; name?: string } = {}
) {
  const direction = options.direction || TransferDirection.LOCAL_TO_REMOTE;
  const name = options.name || 'file.txt';
  const local = path.join(workspace, name);
  const remote = `/remote/${name}`;
  return {
    run,
    isCancelled: () => Boolean(options.cancelled),
    transferType: direction,
    localFsPath: local,
    srcFsPath: direction === TransferDirection.LOCAL_TO_REMOTE ? local : remote,
    targetFsPath: direction === TransferDirection.LOCAL_TO_REMOTE ? remote : local,
  } as any;
}

function createService() {
  return createFileService(
    {
      name: 'staging',
      remotePath: '/remote',
      host: 'example.test',
      username: 'deploy',
      protocol: 'sftp',
    },
    workspace
  );
}

describe('serviceManager transfer hooks', () => {
  let service: ReturnType<typeof createService>;
  let showMsg: jest.SpyInstance;

  beforeAll(() => {
    // the status bar arms a 4s reset timer per message, which would keep the
    // worker alive after the run
    showMsg = jest.spyOn(app.sftpBarItem, 'showMsg').mockImplementation(() => undefined);
  });

  afterAll(() => {
    showMsg.mockRestore();
  });

  beforeEach(() => {
    activityLog.__resetForTest();
    service = createService();
  });

  afterEach(() => {
    disposeFileService(service);
  });

  test('records one entry per task with its outcome', async () => {
    const scheduler = service.createTransferScheduler(1);
    scheduler.add(fakeTask(() => Promise.resolve(), { name: 'ok.txt' }));
    scheduler.add(fakeTask(() => Promise.reject(new Error('boom')), { name: 'bad.txt' }));
    scheduler.add(
      fakeTask(() => Promise.reject(new Error('aborted')), { name: 'gone.txt', cancelled: true })
    );

    await scheduler.run();

    const byName = (name: string) =>
      activityLog.getEntries().find(e => path.basename(e.localPath || '') === name)!;
    expect(activityLog.getEntries().length).toBe(3);
    expect(byName('ok.txt').status).toBe(ActivityStatus.Success);
    expect(byName('bad.txt').status).toBe(ActivityStatus.Failed);
    expect(byName('bad.txt').error).toBe('boom');
    expect(byName('gone.txt').status).toBe(ActivityStatus.Cancelled);
  });

  test('an upload entry carries the remote path, the service and a retry', async () => {
    const scheduler = service.createTransferScheduler(1);
    scheduler.add(fakeTask(() => Promise.resolve(), { name: 'a.txt' }));

    await scheduler.run();

    const [entry] = activityLog.getEntries();
    expect(entry.kind).toBe(ActivityKind.Upload);
    expect(entry.localPath).toBe(path.join(workspace, 'a.txt'));
    expect(entry.remotePath).toBe('/remote/a.txt');
    expect(entry.serviceName).toBe('staging');
    expect(typeof entry.retry).toBe('function');
  });

  test('a download is recorded as such, with the remote source', async () => {
    const scheduler = service.createTransferScheduler(1);
    scheduler.add(
      fakeTask(() => Promise.resolve(), {
        name: 'b.txt',
        direction: TransferDirection.REMOTE_TO_LOCAL,
      })
    );

    await scheduler.run();

    const [entry] = activityLog.getEntries();
    expect(entry.kind).toBe(ActivityKind.Download);
    expect(entry.localPath).toBe(path.join(workspace, 'b.txt'));
    expect(entry.remotePath).toBe('/remote/b.txt');
  });

  test('the entry is opened when the task starts, not when it ends', async () => {
    const scheduler = service.createTransferScheduler(1);
    let statusWhileRunning: string | undefined;
    scheduler.add(
      fakeTask(() => {
        statusWhileRunning = activityLog.getEntries()[0].status;
        return Promise.resolve();
      })
    );

    await scheduler.run();

    expect(statusWhileRunning).toBe(ActivityStatus.Pending);
  });
});
