import SFTPFileSystem, { quoteForShell } from '../sftpFileSystem';
import upath from '../../upath';

/**
 * Over SFTP the digest comes from a checksum tool run through SSHClient.exec.
 * The client is faked at that boundary, so these cases pin down which tool is
 * chosen (and that the choice is made once), how the path is quoted, and what
 * counts as an answer the verification may trust.
 */

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const FILE_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const FILE_MD5 = '5d41402abc4b2a76b9719d911017c592';

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
const notFound = (tool: string) => ({ code: 127, stdout: '', stderr: `sh: ${tool}: not found\n` });

function createFs() {
  const exec = jest.fn();
  const client = { exec, getFsClient: () => ({}) };
  const fs = new SFTPFileSystem(upath, { client: client as any });
  return { fs, exec };
}

// answers each probe/command from a table keyed by the command's first word(s)
function answer(exec: jest.Mock, table: { [command: string]: (command: string) => any }) {
  exec.mockImplementation((command: string) => {
    const key = Object.keys(table).find(prefix => command.indexOf(prefix) === 0);
    if (!key) {
      return Promise.reject(new Error(`unexpected command ${command}`));
    }
    const reply = table[key](command);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
}

describe('SFTPFileSystem.supportsHash', () => {
  test('picks sha256sum when it is there, probing it against /dev/null once', async () => {
    const { fs, exec } = createFs();
    answer(exec, { sha256sum: () => ok(`${EMPTY_SHA256}  /dev/null\n`) });

    await expect(fs.supportsHash()).resolves.toBe('sha256');
    await expect(fs.supportsHash()).resolves.toBe('sha256');

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('sha256sum /dev/null');
  });

  test('falls through to shasum, then openssl, then md5sum', async () => {
    const shasum = createFs();
    answer(shasum.exec, {
      sha256sum: () => notFound('sha256sum'),
      'shasum -a 256': () => ok(`${EMPTY_SHA256}  /dev/null\n`),
    });
    await expect(shasum.fs.supportsHash()).resolves.toBe('sha256');
    expect(shasum.exec.mock.calls.map(call => call[0])).toEqual([
      'sha256sum /dev/null',
      'shasum -a 256 /dev/null',
    ]);

    const openssl = createFs();
    answer(openssl.exec, {
      sha256sum: () => notFound('sha256sum'),
      shasum: () => notFound('shasum'),
      openssl: () => ok(`SHA2-256(/dev/null)= ${EMPTY_SHA256}\n`),
    });
    await expect(openssl.fs.supportsHash()).resolves.toBe('sha256');
    expect(openssl.exec).toHaveBeenCalledTimes(3);

    const md5 = createFs();
    answer(md5.exec, {
      sha256sum: () => notFound('sha256sum'),
      shasum: () => notFound('shasum'),
      openssl: () => notFound('openssl'),
      md5sum: () => ok(`${EMPTY_MD5}  /dev/null\n`),
    });
    await expect(md5.fs.supportsHash()).resolves.toBe('md5');
    expect(md5.exec).toHaveBeenCalledTimes(4);
  });

  test('answers null, once, when no tool is there', async () => {
    const { fs, exec } = createFs();
    answer(exec, {
      sha256sum: () => notFound('sha256sum'),
      shasum: () => notFound('shasum'),
      openssl: () => notFound('openssl'),
      md5sum: () => notFound('md5sum'),
    });

    await expect(fs.supportsHash()).resolves.toBeNull();
    await expect(fs.supportsHash()).resolves.toBeNull();

    expect(exec).toHaveBeenCalledTimes(4);
    await expect(fs.hashFile('/www/a.txt', 'sha256')).rejects.toThrow('not available');
  });

  test('a tool that exits 0 with something else than the empty digest is not trusted', async () => {
    const { fs, exec } = createFs();
    answer(exec, {
      sha256sum: () => ok('usage: sha256sum [FILE]...\n'),
      shasum: () => ok(`${EMPTY_SHA256}  /dev/null\n`),
    });

    await expect(fs.supportsHash()).resolves.toBe('sha256');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  test('a server that refuses exec is null after a single attempt', async () => {
    const { fs, exec } = createFs();
    exec.mockRejectedValue(new Error('Unable to exec'));

    await expect(fs.supportsHash()).resolves.toBeNull();
    await expect(fs.supportsHash()).resolves.toBeNull();

    expect(exec).toHaveBeenCalledTimes(1);
  });

  test('parallel callers share one probe', async () => {
    const { fs, exec } = createFs();
    answer(exec, { sha256sum: () => ok(`${EMPTY_SHA256}  /dev/null\n`) });

    const results = await Promise.all([fs.supportsHash(), fs.supportsHash(), fs.supportsHash()]);

    expect(results).toEqual(['sha256', 'sha256', 'sha256']);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('SFTPFileSystem.hashFile', () => {
  test('runs the chosen tool on the quoted path and returns the lowercase digest', async () => {
    const { fs, exec } = createFs();
    answer(exec, {
      sha256sum: command =>
        command === 'sha256sum /dev/null'
          ? ok(`${EMPTY_SHA256}  /dev/null\n`)
          : ok(`${FILE_SHA256.toUpperCase()}  /www/a.txt\n`),
    });

    await expect(fs.hashFile('/www/a.txt', 'sha256')).resolves.toBe(FILE_SHA256);

    expect(exec).toHaveBeenLastCalledWith("sha256sum '/www/a.txt'");
  });

  test('probes first when hashFile is the first thing asked', async () => {
    const { fs, exec } = createFs();
    answer(exec, {
      sha256sum: command =>
        command === 'sha256sum /dev/null'
          ? ok(`${EMPTY_SHA256}  /dev/null\n`)
          : ok(`${FILE_SHA256}  /www/a.txt\n`),
    });

    await expect(fs.hashFile('/www/a.txt', 'sha256')).resolves.toBe(FILE_SHA256);
    expect(exec.mock.calls.map(call => call[0])).toEqual([
      'sha256sum /dev/null',
      "sha256sum '/www/a.txt'",
    ]);
  });

  test('quotes quotes, spaces and shell metacharacters for sh', async () => {
    const { fs, exec } = createFs();
    answer(exec, {
      sha256sum: command =>
        command === 'sha256sum /dev/null'
          ? ok(`${EMPTY_SHA256}  /dev/null\n`)
          : ok(`${FILE_SHA256}  whatever\n`),
    });

    await fs.hashFile("/www/it's $HOME; rm -rf `x` (1).txt", 'sha256');

    expect(exec).toHaveBeenLastCalledWith(
      "sha256sum '/www/it'\\''s $HOME; rm -rf `x` (1).txt'"
    );
  });

  test('accepts the backslash coreutils 9 prefixes for escaped file names', async () => {
    const { fs, exec } = createFs();
    answer(exec, {
      sha256sum: command =>
        command === 'sha256sum /dev/null'
          ? ok(`${EMPTY_SHA256}  /dev/null\n`)
          : ok(`\\${FILE_SHA256}  /www/a\\nb.txt\n`),
    });

    await expect(fs.hashFile('/www/a\nb.txt', 'sha256')).resolves.toBe(FILE_SHA256);
  });

  test('reads the digest after "= " when openssl is the tool', async () => {
    const { fs, exec } = createFs();
    answer(exec, {
      sha256sum: () => notFound('sha256sum'),
      shasum: () => notFound('shasum'),
      openssl: command =>
        command === 'openssl dgst -sha256 /dev/null'
          ? ok(`SHA256(/dev/null)= ${EMPTY_SHA256}\n`)
          : ok(`SHA256(/www/a.txt)= ${FILE_SHA256}\n`),
    });

    await expect(fs.hashFile('/www/a.txt', 'sha256')).resolves.toBe(FILE_SHA256);
    expect(exec).toHaveBeenLastCalledWith("openssl dgst -sha256 '/www/a.txt'");
  });

  test('hashes with md5sum when that is all the server has', async () => {
    const { fs, exec } = createFs();
    answer(exec, {
      sha256sum: () => notFound('sha256sum'),
      shasum: () => notFound('shasum'),
      openssl: () => notFound('openssl'),
      md5sum: command =>
        command === 'md5sum /dev/null'
          ? ok(`${EMPTY_MD5}  /dev/null\n`)
          : ok(`${FILE_MD5}  /www/a.txt\n`),
    });

    await expect(fs.supportsHash()).resolves.toBe('md5');
    await expect(fs.hashFile('/www/a.txt', 'md5')).resolves.toBe(FILE_MD5);
    // the tool found answers one algorithm only
    await expect(fs.hashFile('/www/a.txt', 'sha256')).rejects.toThrow('sha256 is not available');
  });

  test('rejects with the tool error when the command fails for the file', async () => {
    const { fs, exec } = createFs();
    answer(exec, {
      sha256sum: command =>
        command === 'sha256sum /dev/null'
          ? ok(`${EMPTY_SHA256}  /dev/null\n`)
          : { code: 1, stdout: '', stderr: 'sha256sum: /www/a.txt: Permission denied\n' },
    });

    await expect(fs.hashFile('/www/a.txt', 'sha256')).rejects.toThrow(
      'sha256sum exited with 1: sha256sum: /www/a.txt: Permission denied'
    );
  });

  test('rejects when the output is not a digest of the expected length', async () => {
    const { fs, exec } = createFs();
    answer(exec, {
      sha256sum: command =>
        command === 'sha256sum /dev/null'
          ? ok(`${EMPTY_SHA256}  /dev/null\n`)
          : ok('abc123  /www/a.txt\n'),
    });

    await expect(fs.hashFile('/www/a.txt', 'sha256')).rejects.toThrow(/unexpected sha256sum output/);
  });

  test('propagates an exec failure (timeout, dropped channel)', async () => {
    const { fs, exec } = createFs();
    answer(exec, {
      sha256sum: command =>
        command === 'sha256sum /dev/null'
          ? ok(`${EMPTY_SHA256}  /dev/null\n`)
          : new Error('exec timed out after 30000 ms'),
    });

    await expect(fs.hashFile('/www/a.txt', 'sha256')).rejects.toThrow('exec timed out');
  });
});

describe('quoteForShell', () => {
  test('wraps in single quotes and escapes embedded ones', () => {
    expect(quoteForShell('/www/a.txt')).toBe("'/www/a.txt'");
    expect(quoteForShell("it's")).toBe("'it'\\''s'");
    expect(quoteForShell('a b$c`d"e')).toBe("'a b$c`d\"e'");
  });
});
