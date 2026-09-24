jest.mock('fs');

import * as crypto from 'crypto';
import * as path from 'path';
import { vol } from 'memfs';
import {
  canFingerprint,
  createFingerprinter,
  fingerprintFile,
  fingerprintFiles,
  FINGERPRINT_ALGORITHM,
  MAX_FINGERPRINT_SIZE,
} from '../fingerprint';

/**
 * The fingerprint is what lets the sync index tell "rewritten with the same
 * bytes" from "edited": it must be the plain digest of the file's content,
 * streamed or whole, and the batch helper must skip what it cannot or should
 * not read without giving up on the rest.
 */

const root = path.resolve(path.sep, 'ws');
const p = (...segments: string[]) => path.join(root, ...segments);

const sha1 = (content: string) => crypto.createHash('sha1').update(content).digest('hex');

beforeEach(() => {
  vol.reset();
});

describe('fingerprintFile', () => {
  test('is the sha1 hex digest of the content', async () => {
    vol.fromJSON({ [p('a.txt')]: 'hello, fingerprinted world' });

    expect(FINGERPRINT_ALGORITHM).toBe('sha1');
    expect(await fingerprintFile(p('a.txt'))).toBe(sha1('hello, fingerprinted world'));
    expect((await fingerprintFile(p('a.txt'))).length).toBe(40);
  });

  test('an empty file has a digest too', async () => {
    vol.fromJSON({ [p('empty.txt')]: '' });

    expect(await fingerprintFile(p('empty.txt'))).toBe(sha1(''));
  });

  test('rejects with the read error for a missing file', async () => {
    await expect(fingerprintFile(p('missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('createFingerprinter', () => {
  test('digests chunk by chunk to the same value as the whole', () => {
    const fingerprinter = createFingerprinter();
    fingerprinter.update(Buffer.from('hello, '));
    fingerprinter.update(Buffer.from('fingerprinted world'));

    expect(fingerprinter.digest()).toBe(sha1('hello, fingerprinted world'));
  });
});

describe('canFingerprint', () => {
  test('accepts every size up to the cap and refuses what is above it', () => {
    expect(canFingerprint(0)).toBe(true);
    expect(canFingerprint(1)).toBe(true);
    expect(canFingerprint(MAX_FINGERPRINT_SIZE)).toBe(true);
    expect(canFingerprint(MAX_FINGERPRINT_SIZE + 1)).toBe(false);
    expect(canFingerprint(-1)).toBe(false);
    expect(canFingerprint(NaN)).toBe(false);
    expect(canFingerprint(undefined as any)).toBe(false);
  });
});

describe('fingerprintFiles', () => {
  test('digests every readable candidate within the cap and reports progress', async () => {
    vol.fromJSON({ [p('a.txt')]: 'a', [p('b.txt')]: 'bb', [p('big.bin')]: 'not read' });
    const progress: number[] = [];

    const result = await fingerprintFiles(
      [
        { fsPath: p('a.txt'), size: 1 },
        { fsPath: p('b.txt'), size: 2 },
        // the declared size is what decides: this one is never opened
        { fsPath: p('big.bin'), size: MAX_FINGERPRINT_SIZE + 1 },
        // gone since the scan: skipped, not fatal
        { fsPath: p('gone.txt'), size: 3 },
      ],
      { onProgress: count => progress.push(count) }
    );

    expect(result.cancelled).toBe(false);
    expect(Array.from(result.fingerprints.entries()).sort()).toEqual([
      [p('a.txt'), sha1('a')],
      [p('b.txt'), sha1('bb')],
    ]);
    // one report per file read (the missing one counts: it was attempted)
    expect(progress.sort()).toEqual([1, 2, 3]);
  });

  test('a cancellation stops the reads and says so', async () => {
    vol.fromJSON({ [p('a.txt')]: 'a', [p('b.txt')]: 'bb' });

    const result = await fingerprintFiles(
      [{ fsPath: p('a.txt'), size: 1 }, { fsPath: p('b.txt'), size: 2 }],
      { isCancelled: () => true }
    );

    expect(result.cancelled).toBe(true);
    expect(result.fingerprints.size).toBe(0);
  });

  test('an empty list is fine', async () => {
    const result = await fingerprintFiles([]);

    expect(result).toEqual({ fingerprints: new Map(), cancelled: false });
  });

  test('bounded concurrency: never more lanes than files, at least one', async () => {
    vol.fromJSON({ [p('a.txt')]: 'a' });

    const one = await fingerprintFiles([{ fsPath: p('a.txt'), size: 1 }], { concurrency: 16 });
    expect(one.fingerprints.get(p('a.txt'))).toBe(sha1('a'));

    const zero = await fingerprintFiles([{ fsPath: p('a.txt'), size: 1 }], { concurrency: 0 });
    expect(zero.fingerprints.get(p('a.txt'))).toBe(sha1('a'));
  });
});
