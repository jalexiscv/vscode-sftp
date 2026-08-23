jest.mock('fs');

import { vol } from 'memfs';
import * as path from 'path';
import {
  IndexEntry,
  initSyncIndex,
  getSyncIndex,
  flushSyncIndex,
  indexKeyFor,
  toRelPath,
  __resetForTest,
} from '../syncIndex';

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

// absolute on both platforms; "c:/..." is a relative folder on linux
const storage = path.resolve(path.sep, 'storage', 'workspace-1');

const entry = (overrides: Partial<IndexEntry> = {}): IndexEntry => ({
  size: 10,
  mtime: 1700000000000,
  verifiedAt: 1700000001000,
  status: 'verified',
  ...overrides,
});

const destination = {
  baseDir: path.resolve(path.sep, 'projects', 'site'),
  host: 'example.com',
  port: 22,
  remotePath: '/var/www/html',
  profile: null as string | null,
};

function storedFiles(): string[] {
  return Object.keys(vol.toJSON());
}

describe('syncIndex', () => {
  beforeEach(() => {
    __resetForTest();
    vol.reset();
  });

  afterEach(() => {
    // drop any debounced save left behind before the volume is reset again
    __resetForTest();
  });

  describe('entries', () => {
    beforeEach(() => initSyncIndex({ storagePath: undefined }));

    test('set/get/remove round trip', async () => {
      const index = await getSyncIndex('k1');
      expect(index.key).toBe('k1');
      expect(index.size).toBe(0);
      expect(index.get('src/a.ts')).toBeUndefined();

      index.set('src/a.ts', entry({ size: 3 }));
      expect(index.size).toBe(1);
      expect(index.get('src/a.ts')!.size).toBe(3);

      index.remove('src/a.ts');
      expect(index.size).toBe(0);
      expect(index.get('src/a.ts')).toBeUndefined();
    });

    test('a leading "./" or "/" does not create a different entry', async () => {
      const index = await getSyncIndex('k1');
      index.set('./src/a.ts', entry());
      expect(index.get('src/a.ts')).toBeDefined();
      expect(index.get('/src/a.ts')).toBeDefined();
      expect(index.size).toBe(1);
    });

    test('rename moves the entry and keeps its data', async () => {
      const index = await getSyncIndex('k1');
      index.set('old.ts', entry({ size: 42 }));

      index.rename('old.ts', 'new.ts');
      expect(index.get('old.ts')).toBeUndefined();
      expect(index.get('new.ts')!.size).toBe(42);
      expect(index.size).toBe(1);
    });

    test('rename of an unknown path is a no-op', async () => {
      const index = await getSyncIndex('k1');
      index.rename('ghost.ts', 'new.ts');
      expect(index.size).toBe(0);
    });

    test('entries() lists paths with the casing they were stored with', async () => {
      const index = await getSyncIndex('k1');
      index.set('Src/A.ts', entry());
      index.set('b.ts', entry());

      expect(index.entries().map(([relPath]) => relPath)).toEqual(['Src/A.ts', 'b.ts']);
    });

    test('clear drops everything', async () => {
      const index = await getSyncIndex('k1');
      index.set('a.ts', entry());
      index.set('b.ts', entry());
      index.clear();
      expect(index.size).toBe(0);
    });

    if (CASE_INSENSITIVE_FS) {
      test('lookups fold case on a case-insensitive platform', async () => {
        const index = await getSyncIndex('k1');
        index.set('Src/A.ts', entry({ size: 7 }));

        expect(index.get('src/a.ts')!.size).toBe(7);
        index.set('src/a.ts', entry({ size: 8 }));
        expect(index.size).toBe(1);
        // the latest set wins, casing included
        expect(index.entries()[0][0]).toBe('src/a.ts');
      });
    } else {
      test('lookups are case-sensitive on a case-sensitive platform', async () => {
        const index = await getSyncIndex('k1');
        index.set('Src/A.ts', entry());

        expect(index.get('src/a.ts')).toBeUndefined();
        index.set('src/a.ts', entry());
        expect(index.size).toBe(2);
      });
    }
  });

  describe('persistence', () => {
    test('memory mode without a storage path: save writes nothing', async () => {
      initSyncIndex({ storagePath: undefined });
      const index = await getSyncIndex('mem');
      index.set('a.ts', entry());

      await index.save();
      await flushSyncIndex();
      expect(storedFiles()).toEqual([]);
    });

    test('save writes one JSON file per key under the storage path, atomically', async () => {
      initSyncIndex({ storagePath: storage });
      const index = await getSyncIndex('abc123');
      index.set('src/a.ts', entry({ size: 5 }));

      await index.save();

      const files = storedFiles();
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/sync-index[\\/]abc123\.json$/);
      // the .tmp was renamed over the target, not left behind
      expect(files.some(f => f.endsWith('.tmp'))).toBe(false);

      const raw = vol.readFileSync(files[0], 'utf8') as string;
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.key).toBe('abc123');
      expect(parsed.entries['src/a.ts'].size).toBe(5);
    });

    test('a fresh load reads back what was saved', async () => {
      initSyncIndex({ storagePath: storage });
      const index = await getSyncIndex('abc123');
      index.set('src/a.ts', entry({ size: 5, mtime: 1234000 }));
      index.set('Docs/README.md', entry({ status: 'failed', error: 'size mismatch' }));
      await index.save();

      __resetForTest();
      initSyncIndex({ storagePath: storage });
      const reloaded = await getSyncIndex('abc123');

      expect(reloaded).not.toBe(index);
      expect(reloaded.size).toBe(2);
      expect(reloaded.get('src/a.ts')).toEqual(entry({ size: 5, mtime: 1234000 }));
      expect(reloaded.get('Docs/README.md')!.status).toBe('failed');
      expect(reloaded.entries().map(([relPath]) => relPath)).toEqual([
        'src/a.ts',
        'Docs/README.md',
      ]);
    });

    test('getSyncIndex hands out the same instance for the same key', async () => {
      initSyncIndex({ storagePath: storage });
      const [first, second] = await Promise.all([getSyncIndex('same'), getSyncIndex('same')]);
      expect(first).toBe(second);
      expect(await getSyncIndex('same')).toBe(first);
    });

    test('a corrupt file is logged and starts empty instead of throwing', async () => {
      initSyncIndex({ storagePath: storage });
      const file = path.join(storage, 'sync-index', 'bad.json');
      vol.fromJSON({ [file]: '{ not json' });

      const index = await getSyncIndex('bad');
      expect(index.size).toBe(0);

      // and it can be written over
      index.set('a.ts', entry());
      await index.save();
      expect(JSON.parse(vol.readFileSync(file, 'utf8') as string).entries['a.ts']).toBeDefined();
    });

    test('a file of another version is ignored', async () => {
      initSyncIndex({ storagePath: storage });
      const file = path.join(storage, 'sync-index', 'v9.json');
      vol.fromJSON({ [file]: JSON.stringify({ version: 9, key: 'v9', entries: { 'a.ts': entry() } }) });

      const index = await getSyncIndex('v9');
      expect(index.size).toBe(0);
    });

    test('save without changes does not rewrite the file', async () => {
      initSyncIndex({ storagePath: storage });
      const index = await getSyncIndex('idle');
      await index.save();
      expect(storedFiles()).toEqual([]);
    });

    test('flushSyncIndex writes every loaded index', async () => {
      initSyncIndex({ storagePath: storage });
      const one = await getSyncIndex('one');
      const two = await getSyncIndex('two');
      one.set('a.ts', entry());
      two.set('b.ts', entry());

      await flushSyncIndex();

      const files = storedFiles().sort();
      expect(files).toHaveLength(2);
      expect(files[0]).toMatch(/one\.json$/);
      expect(files[1]).toMatch(/two\.json$/);
    });

    test('changes are saved on their own after a short delay', async () => {
      initSyncIndex({ storagePath: storage });
      const index = await getSyncIndex('debounced');
      index.set('a.ts', entry());
      expect(storedFiles()).toEqual([]);

      // real timers on purpose: memfs completes its callbacks through
      // setImmediate, which jest's fake timers would hold hostage
      await new Promise(resolve => setTimeout(resolve, 1300));
      expect(storedFiles()).toHaveLength(1);
    });
  });

  describe('indexKeyFor', () => {
    test('is stable for the same destination', () => {
      expect(indexKeyFor(destination)).toBe(indexKeyFor({ ...destination }));
      expect(indexKeyFor(destination)).toMatch(/^[0-9a-f]{40}$/);
    });

    test('differs by profile, host, port, remote path and base dir', () => {
      const base = indexKeyFor(destination);
      expect(indexKeyFor({ ...destination, profile: 'prod' })).not.toBe(base);
      expect(indexKeyFor({ ...destination, host: 'other.example.com' })).not.toBe(base);
      expect(indexKeyFor({ ...destination, port: 2222 })).not.toBe(base);
      expect(indexKeyFor({ ...destination, remotePath: '/var/www/staging' })).not.toBe(base);
      expect(
        indexKeyFor({ ...destination, baseDir: path.resolve(path.sep, 'projects', 'other') })
      ).not.toBe(base);
    });

    test('ignores cosmetic differences: trailing slashes, separators, host case', () => {
      const base = indexKeyFor(destination);
      expect(indexKeyFor({ ...destination, remotePath: '/var/www/html/' })).toBe(base);
      expect(indexKeyFor({ ...destination, host: 'EXAMPLE.com' })).toBe(base);
      expect(indexKeyFor({ ...destination, baseDir: destination.baseDir + path.sep })).toBe(base);
      expect(
        indexKeyFor({ ...destination, baseDir: destination.baseDir.split(path.sep).join('/') })
      ).toBe(base);
    });

    test('null and empty profile are the same destination', () => {
      expect(indexKeyFor({ ...destination, profile: '' })).toBe(indexKeyFor(destination));
    });

    if (CASE_INSENSITIVE_FS) {
      test('folds the base dir case on a case-insensitive platform', () => {
        expect(indexKeyFor({ ...destination, baseDir: destination.baseDir.toUpperCase() })).toBe(
          indexKeyFor(destination)
        );
      });
    }
  });

  describe('toRelPath', () => {
    test('uses "/" separators whatever the input used', () => {
      const backslash = String.fromCharCode(92);
      const base = ['c:', 'repo'].join(backslash);
      const file = ['c:', 'repo', 'src', 'a.ts'].join(backslash);
      expect(toRelPath(base, file)).toBe('src/a.ts');
      expect(toRelPath('c:/repo', 'c:/repo/src/a.ts')).toBe('src/a.ts');
    });

    test('is empty for the base dir itself', () => {
      expect(toRelPath('/home/u/repo', '/home/u/repo')).toBe('');
    });

    test('tolerates a trailing slash on the base dir', () => {
      expect(toRelPath('/home/u/repo/', '/home/u/repo/src/a.ts')).toBe('src/a.ts');
    });
  });
});
