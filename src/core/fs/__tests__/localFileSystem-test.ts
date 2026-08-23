jest.mock('fs');

import { vol } from 'memfs';
import * as path from 'path';
import * as crypto from 'crypto';
import LocalFileSystem from '../localFileSystem';
import Crc32 from '../crc32';

/**
 * The local digest is the reference an uploaded file is compared against, so
 * it has to match what the server tools print: known vectors for each
 * algorithm, streamed over more than one chunk, and the home-grown crc32
 * against the IEEE check value.
 */

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_SHA1 = 'a9993e364706816aba3e25717850c26c9cd0d89d';
const ABC_MD5 = '900150983cd24fb0d6963f7d28e17f72';
const CHECK_CRC32 = 'cbf43926';

describe('LocalFileSystem hashing', () => {
  const fs = new LocalFileSystem(path);

  beforeEach(() => {
    vol.reset();
    vol.fromJSON(
      {
        '/empty': '',
        '/abc': 'abc',
        '/check': '123456789',
      },
      '/'
    );
  });

  test('prefers sha256 when asked what it can do', async () => {
    await expect(fs.supportsHash()).resolves.toBe('sha256');
  });

  test.each([
    ['sha256', '/empty', EMPTY_SHA256],
    ['sha1', '/abc', ABC_SHA1],
    ['md5', '/abc', ABC_MD5],
    ['crc32', '/check', CHECK_CRC32],
  ])('%s of a known input matches the published vector', async (algorithm, file, expected) => {
    await expect(fs.hashFile(file, algorithm as any)).resolves.toBe(expected);
  });

  test('digests a file larger than one stream chunk', async () => {
    const big = crypto.randomBytes(300 * 1024);
    vol.writeFileSync('/big.bin', big);

    const expected = crypto.createHash('sha256').update(big).digest('hex');
    await expect(fs.hashFile('/big.bin', 'sha256')).resolves.toBe(expected);
  });

  test('rejects for a file that is not there', async () => {
    await expect(fs.hashFile('/missing', 'sha256')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Crc32', () => {
  test('matches the IEEE check value, however the input is chunked', () => {
    const whole = new Crc32();
    whole.update(Buffer.from('123456789'));
    expect(whole.digest()).toBe(CHECK_CRC32);

    const chunked = new Crc32();
    chunked.update(Buffer.from('1234'));
    chunked.update(Buffer.from('56789'));
    expect(chunked.digest()).toBe(CHECK_CRC32);
  });

  test('is zero-padded to 8 hex digits', () => {
    expect(new Crc32().digest()).toBe('00000000');
    const small = new Crc32();
    small.update(Buffer.from([0, 0, 0, 1]));
    expect(small.digest()).toBe('5643ef8a');
  });
});
