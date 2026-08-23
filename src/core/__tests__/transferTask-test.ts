jest.mock('fs');

import { vol } from 'memfs';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import TransferTask, {
  TransferDirection,
  TransferOption,
  TransferVerificationError,
  ERROR_CODE_VERIFY,
  RETRY_BASE_DELAY_MS,
  setRetryBaseDelayForTest,
} from '../transferTask';
import { FileSystem, FileType } from '../fs';
import { ERROR_MSG_STREAM_INTERRUPT } from '../fs/fileSystem';
import localFs from '../localFs';
import RemoteFs from '../../../test/helper/localRemoteFs';
import logger from '../../logger';

// the retry delay is real time (streams over memfs do not tolerate fake
// timers), so it is shortened for the whole file; the one case that needs the
// real one sets it back itself
const FAST_RETRY_DELAY_MS = 1;

const CONTENT = 'hello, verified world';
const SIZE = Buffer.byteLength(CONTENT);
const HOUR = 60 * 60 * 1000;

function createRemoteFs<T extends RemoteFs>(
  Ctor: new (...args: any[]) => T = RemoteFs as any,
  { remoteTimeOffsetInHours = 0 } = {}
): T {
  return new Ctor(path, {
    clientOption: {} as any,
    remoteTimeOffsetInHours,
  });
}

function fillFs(files: { [x: string]: string }, dirs: string[] = ['/remote']) {
  vol.fromJSON(files, '/');
  dirs.forEach(dir => fs.mkdirSync(dir, { recursive: true } as any));
}

function stat(fsPath: string) {
  return fs.statSync(fsPath);
}

function createUpload(
  targetFs: FileSystem,
  option: Partial<TransferOption> = {},
  srcFs: FileSystem = localFs
) {
  const mtime = Date.now() - HOUR;
  return new TransferTask(
    { fsPath: '/local/a.txt', fileSystem: srcFs },
    { fsPath: '/remote/a.txt', fileSystem: targetFs },
    {
      fileType: FileType.File,
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      transferOption: {
        perserveTargetMode: false,
        mtime,
        atime: mtime,
        ...option,
      },
    }
  );
}

function createDownload(srcFs: FileSystem, option: Partial<TransferOption> = {}) {
  const mtime = Date.now() - HOUR;
  return new TransferTask(
    { fsPath: '/remote/a.txt', fileSystem: srcFs },
    { fsPath: '/local/a.txt', fileSystem: localFs },
    {
      fileType: FileType.File,
      transferDirection: TransferDirection.REMOTE_TO_LOCAL,
      transferOption: {
        perserveTargetMode: false,
        mtime,
        atime: mtime,
        ...option,
      },
    }
  );
}

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

// a target that acknowledges every byte but only keeps the first three: what a
// full disk quota, a proxy or a broken server does without saying so
class TruncatingFs extends RemoteFs {
  put(input: Readable, fsPath: string, _option?: any): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = [];
      input.on('data', chunk => chunks.push(chunk));
      input.once('error', reject);
      input.once('end', () => {
        fs.writeFile(fsPath, Buffer.concat(chunks).slice(0, 3), err =>
          err ? reject(err) : resolve()
        );
      });
    });
  }
}

// fails the first N puts with a plain error, then behaves
class FlakyFs extends RemoteFs {
  failures: number = 1;
  puts: number = 0;

  put(input: Readable, fsPath: string, option?: any): Promise<void> {
    this.puts += 1;
    if (this.puts <= this.failures) {
      return Promise.reject(new Error('connection reset by peer'));
    }
    return super.put(input, fsPath, option);
  }
}

// the upload sits in put() until the task is cancelled from the outside
class StuckFs extends RemoteFs {
  task!: TransferTask;

  put(input: Readable, _fsPath: string, _option?: any): Promise<void> {
    return new Promise<void>((_resolve, reject) => {
      input.once('error', reject);
      input.resume();
      setImmediate(() => this.task.cancel());
    });
  }
}

// says it set the mtime and does nothing, like a server that ignores SETSTAT
class IgnoringFutimesFs extends RemoteFs {
  futimes(_fd: number, _atime: number, _mtime: number): Promise<void> {
    return Promise.resolve();
  }
}

// a source whose stream is shorter than its lstat claims: a file rewritten
// between stat and read, or a read cut short
class ShortSourceFs extends RemoteFs {
  get(_fsPath: string, _option?: any): Promise<Readable> {
    return Promise.resolve(Readable.from([Buffer.from('abc')]));
  }
}

// the helper defines lstat as a non-writable prototype property, which
// jest.spyOn cannot replace; count calls through an override instead
class CountingLstatFs extends RemoteFs {
  lstats: string[] = [];

  lstat(fsPath: string) {
    this.lstats.push(fsPath);
    return super.lstat(fsPath);
  }
}

describe('TransferTask', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    vol.reset();
    fillFs({ '/local/a.txt': CONTENT });
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    setRetryBaseDelayForTest(FAST_RETRY_DELAY_MS);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    setRetryBaseDelayForTest();
  });

  describe('upload', () => {
    test('a complete upload is verified, counted and done in one attempt', async () => {
      const remoteFs = createRemoteFs();
      const statSize = jest.spyOn(remoteFs, 'statSize');
      const task = createUpload(remoteFs);

      await task.run();

      expect(fs.readFileSync('/remote/a.txt', 'utf8')).toBe(CONTENT);
      expect(task.verification).toEqual({ level: 'stat', ok: true });
      expect(task.expectedSize).toBe(SIZE);
      expect(task.bytesTransferred).toBe(SIZE);
      expect(task.attempts).toBe(1);
      expect(statSize).toHaveBeenCalledTimes(1);
      expect(statSize).toHaveBeenCalledWith('/remote/a.txt');
      expect(warn).not.toHaveBeenCalled();
    });

    test('with useTempFile the final path is what gets verified and no .new is left', async () => {
      const remoteFs = createRemoteFs();
      const statSize = jest.spyOn(remoteFs, 'statSize');
      const task = createUpload(remoteFs, { useTempFile: true });

      await task.run();

      expect(fs.readFileSync('/remote/a.txt', 'utf8')).toBe(CONTENT);
      expect(fs.existsSync('/remote/a.txt.new')).toBe(false);
      expect(statSize).toHaveBeenCalledWith('/remote/a.txt');
      expect(task.verification).toEqual({ level: 'stat', ok: true });
    });

    test('a truncated upload fails verification after exhausting the retries', async () => {
      const remoteFs = createRemoteFs(TruncatingFs);
      const task = createUpload(remoteFs, { retries: 1 });

      const error = await rejection(task.run());

      expect(error).toBeInstanceOf(TransferVerificationError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(ERROR_CODE_VERIFY);
      expect(error.code).toBe('EVERIFY');
      expect(error.reason).toBe(`size mismatch (local ${SIZE}, remote 3)`);
      expect(error.message).toContain('/local/a.txt');
      expect(task.attempts).toBe(2);
      expect(task.bytesTransferred).toBe(SIZE);
      expect(task.verification).toEqual({
        level: 'stat',
        ok: false,
        reason: `size mismatch (local ${SIZE}, remote 3)`,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^\[transfer\] retry 1\/1 for .*a\.txt: .*size mismatch/);
    });

    test('retries default to two, so a persistent failure costs three attempts', async () => {
      const remoteFs = createRemoteFs(TruncatingFs);
      const task = createUpload(remoteFs);

      const error = await rejection(task.run());

      expect(error.code).toBe('EVERIFY');
      expect(task.attempts).toBe(3);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    test('retries: 0 gives a single attempt', async () => {
      const remoteFs = createRemoteFs(TruncatingFs);
      const task = createUpload(remoteFs, { retries: 0 });

      const error = await rejection(task.run());

      expect(error.code).toBe('EVERIFY');
      expect(task.attempts).toBe(1);
      expect(warn).not.toHaveBeenCalled();
    });

    test('a file missing after the upload is reported as such', async () => {
      const remoteFs = createRemoteFs();
      jest.spyOn(remoteFs, 'statSize').mockRejectedValue(
        Object.assign(new Error('no such file'), { code: 'ENOENT' })
      );
      const task = createUpload(remoteFs, { retries: 0 });

      const error = await rejection(task.run());

      expect(error.code).toBe('EVERIFY');
      expect(error.reason).toBe('not found after upload');
    });

    test('a server that reports another size is caught through statSize', async () => {
      const remoteFs = createRemoteFs();
      jest.spyOn(remoteFs, 'statSize').mockResolvedValue(0);
      const task = createUpload(remoteFs, { retries: 0 });

      const error = await rejection(task.run());

      expect(error.reason).toBe(`size mismatch (local ${SIZE}, remote 0)`);
    });

    test('a transient failure is retried and the source re-opened', async () => {
      const remoteFs = createRemoteFs(FlakyFs);
      const get = jest.spyOn(localFs, 'get');
      const task = createUpload(remoteFs, { retries: 1 });

      await task.run();

      expect(fs.readFileSync('/remote/a.txt', 'utf8')).toBe(CONTENT);
      expect(task.attempts).toBe(2);
      expect(get).toHaveBeenCalledTimes(2);
      expect(task.verification).toEqual({ level: 'stat', ok: true });
      expect(task.bytesTransferred).toBe(SIZE);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/retry 1\/1 .* connection reset by peer/);
    });

    test('a cancelled transfer is not retried', async () => {
      const remoteFs = createRemoteFs(StuckFs);
      const task = createUpload(remoteFs, { retries: 5 });
      remoteFs.task = task;

      const error = await rejection(task.run());

      expect(error.code).toBe(ERROR_MSG_STREAM_INTERRUPT);
      expect(FileSystem.isAbortedError(error)).toBe(true);
      expect(task.isCancelled()).toBe(true);
      expect(task.attempts).toBe(1);
      expect(warn).not.toHaveBeenCalled();
    });

    test('cancelling while waiting for a retry stops the task right away', async () => {
      // the real delay: the cancel has to land inside the wait
      setRetryBaseDelayForTest(RETRY_BASE_DELAY_MS);
      const remoteFs = createRemoteFs(FlakyFs);
      remoteFs.failures = 10;
      const task = createUpload(remoteFs, { retries: 10 });
      const started = Date.now();

      const pending = rejection(task.run());
      // the first put fails at once; cancel lands during the 500 ms wait
      await new Promise(resolve => setTimeout(resolve, 50));
      task.cancel();
      const error = await pending;

      expect(FileSystem.isAbortedError(error)).toBe(true);
      expect(task.attempts).toBe(1);
      expect(Date.now() - started).toBeLessThan(450);
    });

    test("verifyUpload: 'none' skips the server check but still counts bytes", async () => {
      const remoteFs = createRemoteFs();
      const statSize = jest.spyOn(remoteFs, 'statSize');
      const task = createUpload(remoteFs, { verifyUpload: 'none' });

      await task.run();

      expect(statSize).not.toHaveBeenCalled();
      expect(task.verification).toEqual({ level: 'none', ok: true });
      expect(task.bytesTransferred).toBe(SIZE);
      expect(task.expectedSize).toBe(SIZE);
    });

    test("verifyUpload: 'none' still fails when fewer bytes than the source size went out", async () => {
      const remoteFs = createRemoteFs();
      const srcFs = createRemoteFs(ShortSourceFs);
      const statSize = jest.spyOn(remoteFs, 'statSize');
      const task = createUpload(remoteFs, { verifyUpload: 'none', retries: 0 }, srcFs);

      const error = await rejection(task.run());

      expect(error.code).toBe('EVERIFY');
      expect(error.reason).toBe(`bytes mismatch (sent 3, expected ${SIZE})`);
      expect(statSize).not.toHaveBeenCalled();
      expect(task.bytesTransferred).toBe(3);
      expect(task.verification).toEqual({
        level: 'none',
        ok: false,
        reason: `bytes mismatch (sent 3, expected ${SIZE})`,
      });
    });

    test('a byte mismatch with useTempFile never replaces the target', async () => {
      fillFs({ '/local/a.txt': CONTENT, '/remote/a.txt': 'previous' });
      const remoteFs = createRemoteFs();
      const srcFs = createRemoteFs(ShortSourceFs);
      const task = createUpload(remoteFs, { useTempFile: true, retries: 0 }, srcFs);

      const error = await rejection(task.run());

      expect(error.reason).toMatch(/^bytes mismatch/);
      expect(fs.readFileSync('/remote/a.txt', 'utf8')).toBe('previous');
    });
  });

  describe('mtime hint', () => {
    test('is silent when the server honours the mtime, offset included', async () => {
      const remoteFs = createRemoteFs(RemoteFs, { remoteTimeOffsetInHours: 6 });
      const task = createUpload(remoteFs);

      await task.run();

      expect(task.verification).toEqual({ level: 'stat', ok: true });
      expect(warn).not.toHaveBeenCalled();
      // the helper applies the offset on the way in and out, so the stat
      // reports the local mtime back
      const remote = await remoteFs.lstat('/remote/a.txt');
      expect(Math.floor(remote.mtime / 1000)).toBe(Math.floor((Date.now() - HOUR) / 1000));
    });

    test('warns, without failing, when futimes succeeded but the mtime differs', async () => {
      const remoteFs = createRemoteFs(IgnoringFutimesFs);
      const task = createUpload(remoteFs);

      await task.run();

      expect(task.verification).toEqual({ level: 'stat', ok: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/mtime differs after upload of .*a\.txt/);
    });

    test('is skipped when the file system has no cheap mtime', async () => {
      const remoteFs = createRemoteFs(IgnoringFutimesFs);
      jest.spyOn(remoteFs, 'statMtime').mockResolvedValue(undefined);
      const task = createUpload(remoteFs);

      await task.run();

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('download', () => {
    beforeEach(() => {
      vol.reset();
      fillFs({ '/remote/a.txt': CONTENT }, ['/local']);
    });

    test('counts bytes against the size collected from the listing, without another stat', async () => {
      const remoteFs = createRemoteFs(CountingLstatFs);
      const statSize = jest.spyOn(remoteFs, 'statSize');
      const task = createDownload(remoteFs, { size: SIZE });

      await task.run();

      expect(fs.readFileSync('/local/a.txt', 'utf8')).toBe(CONTENT);
      expect(remoteFs.lstats).toEqual([]);
      expect(statSize).not.toHaveBeenCalled();
      expect(task.expectedSize).toBe(SIZE);
      expect(task.bytesTransferred).toBe(SIZE);
      expect(task.verification).toEqual({ level: 'none', ok: true });
    });

    test('stats the source when no size was collected', async () => {
      const remoteFs = createRemoteFs(CountingLstatFs);
      const task = createDownload(remoteFs);

      await task.run();

      expect(remoteFs.lstats).toEqual(['/remote/a.txt']);
      expect(task.expectedSize).toBe(SIZE);
    });

    test('a short read is a verification failure too', async () => {
      const srcFs = createRemoteFs(ShortSourceFs);
      const task = createDownload(srcFs, { size: SIZE, retries: 0 });

      const error = await rejection(task.run());

      expect(error.code).toBe('EVERIFY');
      expect(error.reason).toBe(`bytes mismatch (sent 3, expected ${SIZE})`);
      expect(task.verification!.level).toBe('none');
    });
  });

  test('the written file keeps the source mtime through the target fd', async () => {
    const remoteFs = createRemoteFs();
    const task = createUpload(remoteFs);

    await task.run();

    const written = stat('/remote/a.txt');
    expect(Math.floor(written.mtime.getTime() / 1000)).toBe(Math.floor((Date.now() - HOUR) / 1000));
  });
});
