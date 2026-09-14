jest.mock('fs');

import { vol } from 'memfs';
import * as path from 'path';
import { TransferDirection, FileType } from '../../core';
import {
  initSyncIndex,
  getSyncIndex,
  indexKeyFor,
  __resetForTest as resetSyncIndex,
} from '../syncIndex';
import { emitTransferDone, __resetForTest as resetTransferEvents } from '../transferEvents';
import {
  indexFor,
  forgetInIndex,
  renameInIndex,
  rememberSkipped,
  rememberAssumedUploaded,
  init,
  destroy,
  testHooks,
} from '../syncIndexFeeder';

/**
 * The index records what was verified, not what was attempted: a verified
 * upload stores the local size/mtime of what was sent, a failed one flags the
 * entry, a download records the file as it now is on disk, and deletions and
 * renames keep it in step.
 */

const { handleOutcome } = testHooks;

const baseDir = path.resolve(path.sep, 'ws');
const p = (...segments: string[]) => path.join(baseDir, ...segments);

const config = { host: 'example.test', port: 22, remotePath: '/remote' };
const service = {
  name: 'staging',
  baseDir,
  getConfig: () => config,
} as any;

function task(overrides: any = {}) {
  return {
    localFsPath: p('src', 'a.ts'),
    transferType: TransferDirection.LOCAL_TO_REMOTE,
    fileType: FileType.File,
    isCancelled: () => false,
    verification: { level: 'stat', ok: true },
    expectedSize: 10,
    sourceSize: 10,
    sourceMtime: 1700000000000,
    attempts: 1,
    ...overrides,
  } as any;
}

async function indexOfService() {
  return getSyncIndex(
    indexKeyFor({
      baseDir,
      host: config.host,
      port: config.port,
      remotePath: config.remotePath,
      profile: null,
    })
  );
}

describe('syncIndexFeeder', () => {
  beforeEach(() => {
    vol.reset();
    resetSyncIndex();
    resetTransferEvents();
    initSyncIndex({ storagePath: undefined });
  });

  afterEach(() => {
    destroy();
    resetSyncIndex();
  });

  test('indexFor resolves the index of the service destination', async () => {
    const index = await indexFor(service);
    expect(index).toBe(await indexOfService());
    // a pre-resolved config spares a getConfig() and lands on the same index
    expect(await indexFor(service, config as any)).toBe(index);
  });

  test('a verified upload records the local size and mtime that were sent', async () => {
    await handleOutcome({ service, task: task(), error: null, profile: null });

    const entry = (await indexOfService()).get('src/a.ts')!;
    expect(entry.status).toBe('verified');
    expect(entry.size).toBe(10);
    expect(entry.mtime).toBe(1700000000000);
    expect(entry.remoteSize).toBe(10);
    expect(entry.verifiedAt).toBeGreaterThan(0);
  });

  test('expectedSize wins over the collected size; sourceSize is the fallback', async () => {
    await handleOutcome({
      service,
      task: task({ expectedSize: 12, sourceSize: 10 }),
      error: null,
      profile: null,
    });
    expect((await indexOfService()).get('src/a.ts')!.size).toBe(12);

    await handleOutcome({
      service,
      task: task({ expectedSize: undefined, sourceSize: 7, localFsPath: p('b.ts') }),
      error: null,
      profile: null,
    });
    expect((await indexOfService()).get('b.ts')!.size).toBe(7);
  });

  test('without any size the local file is measured', async () => {
    vol.fromJSON({ [p('c.ts')]: 'hello' });

    await handleOutcome({
      service,
      task: task({ expectedSize: undefined, sourceSize: undefined, localFsPath: p('c.ts') }),
      error: null,
      profile: null,
    });

    expect((await indexOfService()).get('c.ts')!.size).toBe(5);
  });

  test('a failed upload keeps the previous entry but flags it failed', async () => {
    const index = await indexOfService();
    index.set('src/a.ts', { size: 3, mtime: 1, verifiedAt: 5, status: 'verified' });

    await handleOutcome({
      service,
      task: task({ verification: { level: 'stat', ok: false, reason: 'size mismatch' } }),
      error: new Error('Transfer verification failed: size mismatch'),
      profile: null,
    });

    const entry = index.get('src/a.ts')!;
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe('Transfer verification failed: size mismatch');
    expect(entry.size).toBe(3);
    expect(entry.mtime).toBe(1);
    expect(entry.verifiedAt).toBe(5);
  });

  test('a failed first upload records the attempted size and mtime', async () => {
    await handleOutcome({
      service,
      task: task({ verification: undefined, expectedSize: 9 }),
      error: new Error('EACCES'),
      profile: null,
    });

    const entry = (await indexOfService()).get('src/a.ts')!;
    expect(entry.status).toBe('failed');
    expect(entry.size).toBe(9);
    expect(entry.mtime).toBe(1700000000000);
    expect(entry.error).toBe('EACCES');
  });

  test('a verification that did not pass is failed even without an error object', async () => {
    await handleOutcome({
      service,
      task: task({ verification: { level: 'stat', ok: false, reason: 'not found after upload' } }),
      error: null,
      profile: null,
    });

    const entry = (await indexOfService()).get('src/a.ts')!;
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe('not found after upload');
  });

  test('a download records the file as it is on disk, so the next scan does not re-upload it', async () => {
    vol.fromJSON({ [p('src', 'd.ts')]: 'downloaded' });
    const stat = vol.statSync(p('src', 'd.ts'));

    await handleOutcome({
      service,
      task: task({
        localFsPath: p('src', 'd.ts'),
        transferType: TransferDirection.REMOTE_TO_LOCAL,
        verification: undefined,
      }),
      error: null,
      profile: null,
    });

    const entry = (await indexOfService()).get('src/d.ts')!;
    expect(entry.status).toBe('verified');
    expect(entry.size).toBe(10);
    expect(entry.mtime).toBe(stat.mtime.getTime());
  });

  test('a failed download, a cancelled task and a symlink leave the index alone', async () => {
    await handleOutcome({
      service,
      task: task({ transferType: TransferDirection.REMOTE_TO_LOCAL }),
      error: new Error('ECONNRESET'),
      profile: null,
    });
    await handleOutcome({
      service,
      task: task({ isCancelled: () => true }),
      error: new Error('Transfer Aborted'),
      profile: null,
    });
    await handleOutcome({
      service,
      task: task({ fileType: FileType.SymbolicLink }),
      error: null,
      profile: null,
    });

    expect((await indexOfService()).size).toBe(0);
  });

  test('a path outside the service base dir is not indexed', async () => {
    await handleOutcome({
      service,
      task: task({ localFsPath: path.resolve(path.sep, 'elsewhere', 'a.ts') }),
      error: null,
      profile: null,
    });

    expect((await indexOfService()).size).toBe(0);
  });

  test('an unusable config is noted, not thrown', async () => {
    const broken = {
      name: 'broken',
      baseDir,
      getConfig: () => {
        throw new Error('Unkown Profile');
      },
    } as any;

    await expect(
      handleOutcome({ service: broken, task: task(), error: null, profile: null })
    ).resolves.toBeUndefined();
  });

  test('init() feeds the index from the transfer bus; destroy() stops it', async () => {
    init();
    emitTransferDone({ service, task: task(), error: null, profile: null });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await indexOfService()).get('src/a.ts')).toBeDefined();

    destroy();
    emitTransferDone({
      service,
      task: task({ localFsPath: p('after.ts') }),
      error: null,
      profile: null,
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await indexOfService()).get('after.ts')).toBeUndefined();
  });

  describe('deletions and renames', () => {
    const entry = { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' as const };

    test('forgetInIndex drops a file', async () => {
      const index = await indexOfService();
      index.set('src/a.ts', entry);
      index.set('src/b.ts', entry);

      await forgetInIndex(service, p('src', 'a.ts'));

      expect(index.get('src/a.ts')).toBeUndefined();
      expect(index.get('src/b.ts')).toBeDefined();
    });

    test('forgetInIndex drops a directory with everything under it', async () => {
      const index = await indexOfService();
      index.set('src/a.ts', entry);
      index.set('src/deep/b.ts', entry);
      index.set('srcx/c.ts', entry);

      await forgetInIndex(service, p('src'));

      expect(index.get('src/a.ts')).toBeUndefined();
      expect(index.get('src/deep/b.ts')).toBeUndefined();
      // a shared name prefix is not containment
      expect(index.get('srcx/c.ts')).toBeDefined();
    });

    test('renameInIndex moves a file entry', async () => {
      const index = await indexOfService();
      index.set('src/a.ts', entry);

      await renameInIndex(service, p('src', 'a.ts'), p('src', 'z.ts'));

      expect(index.get('src/a.ts')).toBeUndefined();
      expect(index.get('src/z.ts')).toEqual(entry);
    });

    test('renameInIndex moves a directory subtree', async () => {
      const index = await indexOfService();
      index.set('src/a.ts', entry);
      index.set('src/deep/b.ts', entry);
      index.set('other.ts', entry);

      await renameInIndex(service, p('src'), p('lib'));

      expect(index.get('lib/a.ts')).toEqual(entry);
      expect(index.get('lib/deep/b.ts')).toEqual(entry);
      expect(index.get('src/a.ts')).toBeUndefined();
      expect(index.get('other.ts')).toEqual(entry);
    });

    test('a move out of the synced tree forgets the entry', async () => {
      const index = await indexOfService();
      index.set('src/a.ts', entry);

      await renameInIndex(service, p('src', 'a.ts'), path.resolve(path.sep, 'elsewhere', 'a.ts'));

      expect(index.size).toBe(0);
    });

    test('neither helper throws on an unusable config', async () => {
      const broken = {
        name: 'broken',
        baseDir,
        getConfig: () => {
          throw new Error('Unkown Profile');
        },
      } as any;

      await expect(forgetInIndex(broken, p('a.ts'))).resolves.toBeUndefined();
      await expect(renameInIndex(broken, p('a.ts'), p('b.ts'))).resolves.toBeUndefined();
    });
  });

  describe('rememberSkipped', () => {
    test('writes a skipped entry with the declined size and mtime', async () => {
      const index = await indexOfService();
      index.set('src/a.ts', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });

      await rememberSkipped(service, [
        { localPath: p('src', 'a.ts'), localSize: 7, localMtime: 1700000007000 },
        { localPath: p('src', 'b.ts'), localSize: 3, localMtime: 1700000003000 },
        // outside the base dir: not this index's business
        { localPath: path.resolve(path.sep, 'elsewhere', 'c.ts'), localSize: 1, localMtime: 1 },
      ]);

      expect(index.get('src/a.ts')).toEqual({
        size: 7,
        mtime: 1700000007000,
        verifiedAt: 0,
        status: 'skipped',
      });
      expect(index.get('src/b.ts')).toMatchObject({ size: 3, status: 'skipped' });
      expect(index.size).toBe(2);
    });

    test('does nothing for an empty list and never throws on a broken config', async () => {
      const index = await indexOfService();
      await rememberSkipped(service, []);
      expect(index.size).toBe(0);

      const broken = {
        name: 'broken',
        baseDir,
        getConfig: () => {
          throw new Error('Unkown Profile');
        },
      } as any;
      await expect(
        rememberSkipped(broken, [{ localPath: p('a.ts'), localSize: 1, localMtime: 1 }])
      ).resolves.toBeUndefined();
    });
  });

  describe('rememberAssumedUploaded', () => {
    test('writes a verified entry flagged as assumed, with the size and mtime given', async () => {
      const index = await indexOfService();
      index.set('src/a.ts', { size: 1, mtime: 1, verifiedAt: 0, status: 'failed', error: 'EACCES' });

      const written = await rememberAssumedUploaded(service, [
        { localPath: p('src', 'a.ts'), localSize: 7, localMtime: 1700000007000 },
        { localPath: p('src', 'b.ts'), localSize: 3, localMtime: 1700000003000 },
        // outside the base dir: not this index's business
        { localPath: path.resolve(path.sep, 'elsewhere', 'c.ts'), localSize: 1, localMtime: 1 },
      ]);

      expect(written).toBe(2);
      // the failed entry is replaced whole: no error left behind
      expect(index.get('src/a.ts')).toEqual({
        size: 7,
        mtime: 1700000007000,
        verifiedAt: expect.any(Number),
        status: 'verified',
        assumed: true,
      });
      expect(index.get('src/a.ts')!.verifiedAt).toBeGreaterThan(0);
      expect(index.get('src/b.ts')).toMatchObject({ size: 3, status: 'verified', assumed: true });
      expect(index.size).toBe(2);
    });

    test('does nothing for an empty list and never throws on a broken config', async () => {
      const index = await indexOfService();
      expect(await rememberAssumedUploaded(service, [])).toBe(0);
      expect(index.size).toBe(0);

      const broken = {
        name: 'broken',
        baseDir,
        getConfig: () => {
          throw new Error('Unkown Profile');
        },
      } as any;
      await expect(
        rememberAssumedUploaded(broken, [{ localPath: p('a.ts'), localSize: 1, localMtime: 1 }])
      ).resolves.toBe(0);
    });
  });
});
