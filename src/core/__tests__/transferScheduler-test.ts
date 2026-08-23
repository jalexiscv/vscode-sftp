import FileService from '../fileService';
import TransferTask, { TransferDirection } from '../transferTask';
import { describeTransferFailures, TransferFailedError, ETRANSFER_FAILED } from '../customError';

/**
 * The scheduler used to resolve on idle whatever happened to the tasks, so a
 * failed put looked exactly like a clean upload to every caller. The contract
 * pinned down here is that run() tells the three outcomes apart.
 */

function fakeTask(
  run: () => Promise<void>,
  options: { cancelled?: boolean; localFsPath?: string } = {}
): TransferTask {
  return {
    run,
    isCancelled: () => Boolean(options.cancelled),
    localFsPath: options.localFsPath || '/base/file.txt',
    transferType: TransferDirection.LOCAL_TO_REMOTE,
  } as any;
}

function createService() {
  return new FileService('/base', '/base', {} as any);
}

describe('createTransferScheduler().run()', () => {
  test('resolves with every task sorted into succeeded, failed or cancelled', async () => {
    const scheduler = createService().createTransferScheduler(2);
    const boom = new Error('boom');
    const ok = fakeTask(() => Promise.resolve());
    const bad = fakeTask(() => Promise.reject(boom));
    // aborting a stream makes run() throw as well; that must not count as failed
    const cancelled = fakeTask(() => Promise.reject(new Error('aborted')), { cancelled: true });

    scheduler.add(ok);
    scheduler.add(bad);
    scheduler.add(cancelled);
    const result = await scheduler.run();

    expect(result.succeeded).toEqual([ok]);
    expect(result.failed).toEqual([{ task: bad, error: boom }]);
    expect(result.cancelled).toEqual([cancelled]);
  });

  test('does not reject because of a failed task', async () => {
    const scheduler = createService().createTransferScheduler(1);
    scheduler.add(fakeTask(() => Promise.reject(new Error('boom'))));

    await expect(scheduler.run()).resolves.toBeDefined();
  });

  test('resolves with an empty result when nothing was queued', async () => {
    const scheduler = createService().createTransferScheduler(1);

    expect(await scheduler.run()).toEqual({ succeeded: [], failed: [], cancelled: [] });
  });

  test('runs the whole batch even after a failure', async () => {
    const scheduler = createService().createTransferScheduler(1);
    const order: string[] = [];
    scheduler.add(
      fakeTask(() => {
        order.push('first');
        return Promise.reject(new Error('boom'));
      })
    );
    scheduler.add(
      fakeTask(() => {
        order.push('second');
        return Promise.resolve();
      })
    );

    const result = await scheduler.run();

    expect(order).toEqual(['first', 'second']);
    expect(result.succeeded.length).toBe(1);
    expect(result.failed.length).toBe(1);
  });

  test('the afterTransfer hook still sees each task with its error', async () => {
    const service = createService();
    const seen: Array<[Error | null, TransferTask]> = [];
    service.afterTransfer((error, task) => seen.push([error, task]));

    const scheduler = service.createTransferScheduler(1);
    const boom = new Error('boom');
    const ok = fakeTask(() => Promise.resolve());
    const bad = fakeTask(() => Promise.reject(boom));
    scheduler.add(ok);
    scheduler.add(bad);
    await scheduler.run();

    expect(seen).toEqual([
      [null, ok],
      [boom, bad],
    ]);
  });
});

describe('TransferFailedError', () => {
  const failure = (name: string, error: any) => ({
    task: fakeTask(() => Promise.resolve(), { localFsPath: `/base/${name}` }),
    error,
  });

  test('names the failed files with their error code', () => {
    const message = describeTransferFailures(
      [
        failure('a.txt', Object.assign(new Error('Permission denied'), { code: 'EACCES' })),
        failure('b.txt', new Error('read ECONNRESET')),
      ],
      10,
      'upload'
    );

    expect(message).toBe('2 of 10 file(s) failed to upload: a.txt (EACCES), b.txt (read ECONNRESET)');
  });

  test('a numeric code is no reason: the message is used instead', () => {
    // ssh2 reports SFTP status codes as bare numbers (3 = permission denied)
    const message = describeTransferFailures(
      [failure('a.txt', Object.assign(new Error('Permission denied'), { code: 3 }))],
      1,
      'upload'
    );

    expect(message).toBe('1 of 1 file(s) failed to upload: a.txt (Permission denied)');
  });

  test('an empty code falls back to the message as well', () => {
    const message = describeTransferFailures(
      [failure('a.txt', Object.assign(new Error('boom'), { code: '' }))],
      1,
      'upload'
    );

    expect(message).toBe('1 of 1 file(s) failed to upload: a.txt (boom)');
  });

  test('a long or multi-line message is cut to one line of about 80 characters', () => {
    const long = 'x'.repeat(120);
    const cut = describeTransferFailures([failure('a.txt', new Error(long))], 1, 'upload');
    expect(cut).toBe(`1 of 1 file(s) failed to upload: a.txt (${'x'.repeat(77)}...)`);

    const multiline = describeTransferFailures(
      [failure('a.txt', new Error('first line\n   second   line'))],
      1,
      'upload'
    );
    expect(multiline).toBe('1 of 1 file(s) failed to upload: a.txt (first line second line)');
  });

  test('lists at most five names and counts the rest', () => {
    const failures = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(name =>
      failure(`${name}.txt`, Object.assign(new Error('x'), { code: 'EIO' }))
    );

    const message = describeTransferFailures(failures, 7, 'download');

    expect(message).toBe(
      '7 of 7 file(s) failed to download: a.txt (EIO), b.txt (EIO), c.txt (EIO), d.txt (EIO), e.txt (EIO) and 2 more'
    );
  });

  test('carries the code and the failures', () => {
    const failures = [failure('a.txt', new Error('x'))];
    const error = new TransferFailedError(failures, 1, 'upload');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(TransferFailedError);
    expect(error.code).toBe(ETRANSFER_FAILED);
    expect(error.name).toBe('TransferFailedError');
    expect(error.failures).toBe(failures);
    expect(error.message).toBe('1 of 1 file(s) failed to upload: a.txt (x)');
  });
});
