jest.mock('fs');

import { vol } from 'memfs';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import TransferTask, {
  TransferDirection,
  TransferOption,
  TransferVerificationError,
  setRetryBaseDelayForTest,
} from '../transferTask';
import { FileSystem, FileType } from '../fs';
import { HashAlgorithm } from '../fs/fileSystem';
import localFs from '../localFs';
import RemoteFs from '../../../test/helper/localRemoteFs';
import logger from '../../logger';

/**
 * verifyUpload: 'hash' is the only check that reads the content back. These
 * cases pin down the contract TransferTask keeps with the file systems: the
 * size check still runs first, the digest is asked of the final path, a
 * differing digest fails (and retries), and a server that cannot hash, or
 * fails to for one file, degrades to 'stat' instead of failing the upload.
 */

// the retry delay is real time (memfs streams and fake timers don't mix);
// nothing here depends on its length
const FAST_RETRY_DELAY_MS = 1;

const CONTENT = 'hello, hashed world';
const SIZE = Buffer.byteLength(CONTENT);
const SHA256 = crypto.createHash('sha256').update(CONTENT).digest('hex');
const HOUR = 60 * 60 * 1000;

function createRemoteFs<T extends RemoteFs>(Ctor: new (...args: any[]) => T): T {
  return new Ctor(path, { clientOption: {} as any });
}

function fillFs(files: { [x: string]: string }, dirs: string[] = ['/remote']) {
  vol.fromJSON(files, '/');
  dirs.forEach(dir => fs.mkdirSync(dir, { recursive: true } as any));
}

function createUpload(targetFs: FileSystem, option: Partial<TransferOption> = {}) {
  const mtime = Date.now() - HOUR;
  return new TransferTask(
    { fsPath: '/local/a.txt', fileSystem: localFs },
    { fsPath: '/remote/a.txt', fileSystem: targetFs },
    {
      fileType: FileType.File,
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      transferOption: {
        perserveTargetMode: false,
        mtime,
        atime: mtime,
        verifyUpload: 'hash',
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

// a remote that can hash: it digests its own (memfs) files like the local
// side does, so a correct upload hashes equal
class HashingFs extends RemoteFs {
  hashed: string[] = [];

  supportsHash(): Promise<HashAlgorithm | null> {
    return Promise.resolve('sha256');
  }

  hashFile(fsPath: string, algorithm: HashAlgorithm): Promise<string> {
    this.hashed.push(fsPath);
    return localFs.hashFile(fsPath, algorithm);
  }
}

// acknowledges the bytes, keeps them all, but a different content is what
// the server hashes: a transparent proxy or a hook rewriting the file
class RewritingFs extends HashingFs {
  hashFile(fsPath: string, _algorithm: HashAlgorithm): Promise<string> {
    this.hashed.push(fsPath);
    return Promise.resolve(crypto.createHash('sha256').update('something else').digest('hex'));
  }
}

// can hash in principle, but the command fails for this file
class FailingHashFs extends HashingFs {
  hashFile(fsPath: string, _algorithm: HashAlgorithm): Promise<string> {
    this.hashed.push(fsPath);
    return Promise.reject(new Error('sha256sum exited with 1: permission denied'));
  }
}

// keeps the first three bytes only, and could hash them if asked
class TruncatingHashFs extends HashingFs {
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

describe("TransferTask verifyUpload: 'hash'", () => {
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

  test('an upload whose digests agree is verified at hash level, size check included', async () => {
    const remoteFs = createRemoteFs(HashingFs);
    const statSize = jest.spyOn(remoteFs, 'statSize');
    const localHash = jest.spyOn(localFs, 'hashFile');
    const task = createUpload(remoteFs);

    await task.run();

    expect(fs.readFileSync('/remote/a.txt', 'utf8')).toBe(CONTENT);
    expect(task.verification).toEqual({ level: 'hash', ok: true, algorithm: 'sha256' });
    expect(task.attempts).toBe(1);
    expect(statSize).toHaveBeenCalledTimes(1);
    // the remote file system hashed the target, the local one the source
    expect(remoteFs.hashed).toEqual(['/remote/a.txt']);
    expect(localHash).toHaveBeenCalledWith('/local/a.txt', 'sha256');
    expect(localHash).toHaveBeenCalledWith('/remote/a.txt', 'sha256');
    await expect(localFs.hashFile('/remote/a.txt', 'sha256')).resolves.toBe(SHA256);
    expect(warn).not.toHaveBeenCalled();
  });

  test('with useTempFile the final path is what gets hashed', async () => {
    const remoteFs = createRemoteFs(HashingFs);
    const task = createUpload(remoteFs, { useTempFile: true });

    await task.run();

    expect(remoteFs.hashed).toEqual(['/remote/a.txt']);
    expect(fs.existsSync('/remote/a.txt.new')).toBe(false);
    expect(task.verification).toEqual({ level: 'hash', ok: true, algorithm: 'sha256' });
  });

  test('a differing digest fails verification after exhausting the retries', async () => {
    const remoteFs = createRemoteFs(RewritingFs);
    const task = createUpload(remoteFs, { retries: 1 });

    const error = await rejection(task.run());

    expect(error).toBeInstanceOf(TransferVerificationError);
    expect(error.code).toBe('EVERIFY');
    expect(error.reason).toMatch(/^hash mismatch \(sha256: local [0-9a-f]{8}…, remote [0-9a-f]{8}…\)$/);
    expect(error.reason).toContain(`local ${SHA256.slice(0, 8)}`);
    expect(task.attempts).toBe(2);
    expect(remoteFs.hashed).toEqual(['/remote/a.txt', '/remote/a.txt']);
    expect(task.verification).toEqual({
      level: 'hash',
      ok: false,
      reason: error.reason,
      algorithm: 'sha256',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[transfer\] retry 1\/1 for .*a\.txt: .*hash mismatch/);
  });

  test('a wrong size is reported as such and no digest is asked for', async () => {
    const remoteFs = createRemoteFs(TruncatingHashFs);
    const task = createUpload(remoteFs, { retries: 0 });

    const error = await rejection(task.run());

    expect(error.code).toBe('EVERIFY');
    expect(error.reason).toBe(`size mismatch (local ${SIZE}, remote 3)`);
    expect(remoteFs.hashed).toEqual([]);
  });

  test('a server that cannot hash degrades to stat, ok, with a reason and one warning per file system', async () => {
    // the plain helper inherits the FileSystem default: no hash support
    const remoteFs = createRemoteFs(RemoteFs);
    const statSize = jest.spyOn(remoteFs, 'statSize');
    const localHash = jest.spyOn(localFs, 'hashFile');

    const first = createUpload(remoteFs);
    await first.run();
    const second = createUpload(remoteFs);
    await second.run();

    const degraded = {
      level: 'stat',
      ok: true,
      reason: 'hash not available on this server, verified by size',
    };
    expect(first.verification).toEqual(degraded);
    expect(second.verification).toEqual(degraded);
    expect(statSize).toHaveBeenCalledTimes(2);
    expect(localHash).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/hash not available on this server/);

    // another connection (another file system instance) gets its own warning
    const other = createUpload(createRemoteFs(RemoteFs));
    await other.run();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test('a probe that throws counts as "cannot hash"', async () => {
    const remoteFs = createRemoteFs(HashingFs);
    jest.spyOn(remoteFs, 'supportsHash').mockRejectedValue(new Error('exec refused'));
    const task = createUpload(remoteFs);

    await task.run();

    expect(task.verification).toEqual({
      level: 'stat',
      ok: true,
      reason: 'hash not available on this server, verified by size',
    });
    expect(remoteFs.hashed).toEqual([]);
  });

  test('a digest the server fails to compute degrades to stat without retrying', async () => {
    const remoteFs = createRemoteFs(FailingHashFs);
    const task = createUpload(remoteFs, { retries: 2 });

    await task.run();

    expect(task.verification).toEqual({
      level: 'stat',
      ok: true,
      reason: 'hash check failed (sha256sum exited with 1: permission denied), verified by size',
    });
    expect(task.attempts).toBe(1);
    expect(fs.readFileSync('/remote/a.txt', 'utf8')).toBe(CONTENT);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/a\.txt: hash check failed \(sha256sum exited with 1/);
  });

  test("verifyUpload: 'stat' never asks for a digest", async () => {
    const remoteFs = createRemoteFs(HashingFs);
    const supportsHash = jest.spyOn(remoteFs, 'supportsHash');
    const localHash = jest.spyOn(localFs, 'hashFile');
    const task = createUpload(remoteFs, { verifyUpload: 'stat' });

    await task.run();

    expect(task.verification).toEqual({ level: 'stat', ok: true });
    expect(supportsHash).not.toHaveBeenCalled();
    expect(remoteFs.hashed).toEqual([]);
    expect(localHash).not.toHaveBeenCalled();
  });

  test('downloads only count bytes, whatever verifyUpload says', async () => {
    vol.reset();
    fillFs({ '/remote/a.txt': CONTENT }, ['/local']);
    const remoteFs = createRemoteFs(HashingFs);
    const mtime = Date.now() - HOUR;
    const task = new TransferTask(
      { fsPath: '/remote/a.txt', fileSystem: remoteFs },
      { fsPath: '/local/a.txt', fileSystem: localFs },
      {
        fileType: FileType.File,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        transferOption: { perserveTargetMode: false, mtime, atime: mtime, verifyUpload: 'hash' },
      }
    );

    await task.run();

    expect(fs.readFileSync('/local/a.txt', 'utf8')).toBe(CONTENT);
    expect(task.verification).toEqual({ level: 'none', ok: true });
    expect(remoteFs.hashed).toEqual([]);
  });
});
