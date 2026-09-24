jest.mock('fs');

import { vol } from 'memfs';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import TransferTask, {
  TransferDirection,
  TransferOption,
  TransferPhase,
  TransferVerificationError,
  ERROR_CODE_VERIFY,
  RETRY_BASE_DELAY_MS,
  isRetryableTransferError,
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

// fails the first N puts with a transient server error (SFTP 4 FAILURE, the
// generic "try again"), then behaves
class FlakyFs extends RemoteFs {
  failures: number = 1;
  puts: number = 0;
  error: any = Object.assign(new Error('Failure'), { code: 4 });

  put(input: Readable, fsPath: string, option?: any): Promise<void> {
    this.puts += 1;
    if (this.puts <= this.failures) {
      return Promise.reject(this.error);
    }
    return super.put(input, fsPath, option);
  }
}

// every put is refused with the error the test hands over (a server that
// denies the write, an FTP reply...)
class RefusingFs extends RemoteFs {
  error: any = new Error('refused');
  puts: number = 0;

  put(_input: Readable, _fsPath: string, _option?: any): Promise<void> {
    this.puts += 1;
    return Promise.reject(this.error);
  }
}

// the first open of the target fails as if its directory had gone, the next
// one works: the same ENOENT as a missing source, on the other side
class VanishingTargetFs extends RemoteFs {
  opens: number = 0;

  open(fsPath: string, flags: string, mode?: number): Promise<unknown> {
    this.opens += 1;
    if (this.opens === 1) {
      return Promise.reject(Object.assign(new Error('no such file or directory'), { code: 'ENOENT' }));
    }
    return super.open(fsPath, flags, mode);
  }
}

// the source opens fine and then fails while being read: a file the user
// cannot read (the local open is lazy, so this is how a local EACCES shows up)
class UnreadableSourceFs extends RemoteFs {
  get(_fsPath: string, _option?: any): Promise<Readable> {
    const stream = new Readable({
      read() {
        this.destroy(Object.assign(new Error('EACCES: permission denied, read'), { code: 'EACCES' }));
      },
    });
    return Promise.resolve(stream);
  }
}

// a remote source that is not there any more when the download opens it
class MissingSourceFs extends RemoteFs {
  get(_fsPath: string, _option?: any): Promise<Readable> {
    return Promise.reject(Object.assign(new Error('No such file'), { code: 2 }));
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
      // the digest of the bytes that went by, for the sync index
      expect(task.contentFingerprint).toBe(
        crypto.createHash('sha1').update(CONTENT).digest('hex')
      );
    });

    test('the content fingerprint is unset before the run and after an incomplete stream', async () => {
      const remoteFs = createRemoteFs();
      const task = createUpload(remoteFs);
      expect(task.contentFingerprint).toBeUndefined();

      // a source that ends early: fewer bytes than the stat promised
      const get = jest.spyOn(localFs, 'get').mockImplementation(() =>
        Promise.resolve(Readable.from([Buffer.from(CONTENT.slice(0, 3))]) as any)
      );
      const error = await rejection(task.run());
      get.mockRestore();

      expect(error).toBeInstanceOf(TransferVerificationError);
      expect(task.contentFingerprint).toBeUndefined();
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
      expect(warn.mock.calls[0][0]).toMatch(/retry 1\/1 .* Failure/);
    });

    test('a lost connection is not retried inside the task: the client is dead, the batch decides', async () => {
      const remoteFs = createRemoteFs(FlakyFs);
      remoteFs.failures = 10;
      remoteFs.error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      const task = createUpload(remoteFs, { retries: 5 });

      const error = await rejection(task.run());

      expect(error.code).toBe('ECONNRESET');
      expect(error.connectionLost).toBe(true);
      expect(task.attempts).toBe(1);
      expect(remoteFs.puts).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^\[transfer\] connection lost while .*a\.txt: read ECONNRESET/);
    });

    test('an FTP data-connection abort (426) is a transient reply, still retried', async () => {
      const remoteFs = createRemoteFs(FlakyFs);
      remoteFs.error = Object.assign(new Error('426 Connection closed; transfer aborted.'), { code: 426 });
      const task = createUpload(remoteFs, { retries: 1 });

      await task.run();

      expect(task.attempts).toBe(2);
      expect(fs.readFileSync('/remote/a.txt', 'utf8')).toBe(CONTENT);
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

  describe('retry policy', () => {
    const withCode = (code: string | number, message = 'boom') =>
      Object.assign(new Error(message), { code });
    const phases: TransferPhase[] = ['source', 'target'];

    test.each([
      ['EACCES', 'EACCES'],
      ['EPERM', 'EPERM'],
      ['EISDIR', 'EISDIR'],
      ['ENOTDIR', 'ENOTDIR'],
      ['EROFS', 'EROFS'],
      ['ENOTSUP', 'ENOTSUP'],
      ['SFTP 3 PERMISSION_DENIED', 3],
      ['SFTP 8 OP_UNSUPPORTED', 8],
      ['FTP 500', 500],
      ['FTP 530', 530],
      ['FTP 532', 532],
      ['FTP 550', 550],
      ['FTP 553', 553],
    ])('%s is never retried', (_name, code) => {
      phases.forEach(phase => expect(isRetryableTransferError(withCode(code), phase)).toBe(false));
    });

    test.each([
      ['ECONNRESET', 'ECONNRESET'],
      ['ETIMEDOUT', 'ETIMEDOUT'],
      ['EPIPE', 'EPIPE'],
      ['ECONNREFUSED', 'ECONNREFUSED'],
      ['EVERIFY', ERROR_CODE_VERIFY],
      ['SFTP 4 FAILURE', 4],
      ['SFTP 6 NO_CONNECTION', 6],
      ['SFTP 7 CONNECTION_LOST', 7],
      ['FTP 421', 421],
      ['FTP 425', 425],
      ['FTP 426', 426],
      ['FTP 450', 450],
      ['FTP 451', 451],
      ['FTP 452', 452],
      ['FTP 552 (storage allocation)', 552],
    ])('%s is retried', (_name, code) => {
      phases.forEach(phase => expect(isRetryableTransferError(withCode(code), phase)).toBe(true));
    });

    test('a missing path is final on the source and worth a retry on the target', () => {
      const missing = [
        withCode('ENOENT'),
        withCode(2, 'No such file'),
        new Error('file not exist'), // ftpFileSystem.lstat, no code at all
      ];
      missing.forEach(error => {
        expect(isRetryableTransferError(error, 'source')).toBe(false);
        expect(isRetryableTransferError(error, 'target')).toBe(true);
      });
      // FTP's 550 is a permanent reply on either side
      expect(isRetryableTransferError(withCode(550, '550 No such file'), 'target')).toBe(false);
    });

    test('unknown errors and a cancelled transfer fall on their defaults', () => {
      phases.forEach(phase => {
        expect(isRetryableTransferError(new Error('something odd'), phase)).toBe(true);
        expect(isRetryableTransferError(undefined, phase)).toBe(true);
        expect(isRetryableTransferError('a string', phase)).toBe(true);
        expect(isRetryableTransferError(FileSystem.createAbortedError(), phase)).toBe(false);
      });
    });

    test('a target that denies the write is not retried, whatever the budget', async () => {
      const remoteFs = createRemoteFs(RefusingFs);
      remoteFs.error = withCode(3, 'Permission denied');
      const task = createUpload(remoteFs, { retries: 5 });

      const error = await rejection(task.run());

      expect(error.code).toBe(3);
      expect(task.attempts).toBe(1);
      expect(remoteFs.puts).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(
        '[transfer] not retrying /local/a.txt: Permission denied (code 3)'
      );
    });

    test('an FTP permanent reply stops at once while a transient one is retried', async () => {
      const refused = createRemoteFs(RefusingFs);
      refused.error = withCode(550, '550 Permission denied.');
      const stopped = createUpload(refused, { retries: 2 });
      await rejection(stopped.run());
      expect(stopped.attempts).toBe(1);

      const busy = createRemoteFs(RefusingFs);
      busy.error = withCode(426, '426 Connection closed; transfer aborted.');
      const exhausted = createUpload(busy, { retries: 2 });
      const error = await rejection(exhausted.run());
      expect(error.code).toBe(426);
      expect(exhausted.attempts).toBe(3);
    });

    test('a local source that is not there is not retried', async () => {
      vol.reset();
      fillFs({}, ['/local', '/remote']);
      const remoteFs = createRemoteFs();
      const task = createUpload(remoteFs, { retries: 2 });

      const error = await rejection(task.run());

      expect(error.code).toBe('ENOENT');
      expect(task.attempts).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^\[transfer\] not retrying .*a\.txt: .*ENOENT/);
    });

    test('a source that fails while being read is a source-side failure', async () => {
      const remoteFs = createRemoteFs();
      const srcFs = createRemoteFs(UnreadableSourceFs);
      const task = createUpload(remoteFs, { retries: 2 }, srcFs);

      const error = await rejection(task.run());

      expect(error.code).toBe('EACCES');
      expect(task.attempts).toBe(1);
      expect(warn.mock.calls[0][0]).toMatch(/not retrying .*a\.txt: EACCES/);
    });

    test('a remote source missing at download time is not retried', async () => {
      vol.reset();
      fillFs({}, ['/local']);
      const srcFs = createRemoteFs(MissingSourceFs);
      const task = createDownload(srcFs, { size: SIZE, retries: 2 });

      const error = await rejection(task.run());

      expect(error.code).toBe(2);
      expect(task.attempts).toBe(1);
      expect(warn.mock.calls[0][0]).toBe('[transfer] not retrying /local/a.txt: No such file (code 2)');
    });

    test('a target that went missing is retried: on open and after the upload', async () => {
      const remoteFs = createRemoteFs(VanishingTargetFs);
      const task = createUpload(remoteFs, { retries: 1 });

      await task.run();

      expect(task.attempts).toBe(2);
      expect(remoteFs.opens).toBe(2);
      expect(fs.readFileSync('/remote/a.txt', 'utf8')).toBe(CONTENT);
      expect(warn.mock.calls[0][0]).toMatch(/^\[transfer\] retry 1\/1 for .*a\.txt: .*ENOENT/);

      // verified-and-gone is EVERIFY, which is always worth another try
      const gone = createRemoteFs();
      jest.spyOn(gone, 'statSize').mockRejectedValue(withCode('ENOENT', 'no such file'));
      const verified = createUpload(gone, { retries: 1 });
      const error = await rejection(verified.run());
      expect(error.code).toBe('EVERIFY');
      expect(error.reason).toBe('not found after upload');
      expect(verified.attempts).toBe(2);
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
      // what landed on disk, digested on the way
      expect(task.contentFingerprint).toBe(
        crypto.createHash('sha1').update(CONTENT).digest('hex')
      );
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

    test('a source that grew since the listing is measured again on the retry', async () => {
      // the listing saw three bytes; the file holds the whole content by now
      const remoteFs = createRemoteFs(CountingLstatFs);
      const task = createDownload(remoteFs, { size: 3, retries: 1 });

      await task.run();

      expect(fs.readFileSync('/local/a.txt', 'utf8')).toBe(CONTENT);
      expect(task.attempts).toBe(2);
      expect(task.expectedSize).toBe(SIZE);
      expect(task.bytesTransferred).toBe(SIZE);
      // the first attempt trusted the listing, the retry asked the source
      expect(remoteFs.lstats).toEqual(['/remote/a.txt']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /^\[transfer\] retry 1\/1 for .*a\.txt: .*bytes mismatch \(sent \d+, expected 3\)/
      );
    });

    test('without retries a stale listed size still fails, as there is no second measure', async () => {
      const remoteFs = createRemoteFs(CountingLstatFs);
      const task = createDownload(remoteFs, { size: 3, retries: 0 });

      const error = await rejection(task.run());

      expect(error.code).toBe('EVERIFY');
      expect(remoteFs.lstats).toEqual([]);
    });

    test('a source that vanished before the retry is measured is not retried again', async () => {
      const remoteFs = createRemoteFs();
      const statSize = jest
        .spyOn(remoteFs, 'statSize')
        .mockRejectedValue(Object.assign(new Error('No such file'), { code: 2 }));
      const task = createDownload(remoteFs, { size: 3, retries: 2 });

      const error = await rejection(task.run());

      expect(error.code).toBe(2);
      expect(task.attempts).toBe(2);
      expect(statSize).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.map(call => call[0])).toEqual([
        expect.stringMatching(/^\[transfer\] retry 1\/2 for .*a\.txt: .*bytes mismatch/),
        '[transfer] not retrying /local/a.txt: No such file (code 2)',
      ]);
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
