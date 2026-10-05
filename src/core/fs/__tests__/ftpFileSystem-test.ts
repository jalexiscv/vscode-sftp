import { EventEmitter } from 'events';
import { PassThrough, Readable } from 'stream';
import { FileType as BasicFtpFileType } from 'basic-ftp';
import FTPFileSystem, { endAfterSecureConnect, parseFtpDigest } from '../ftpFileSystem';
import upath from '../../upath';

/**
 * statSize is what keeps upload verification affordable over FTP: one SIZE
 * command instead of a LIST of the parent directory. The client is faked at
 * the basic-ftp boundary, so these tests pin down the command choice, the
 * fallback and the fact that "not found" is not mistaken for "unsupported".
 */

function ftpError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

function createFs() {
  const client = {
    size: jest.fn(),
    list: jest.fn(),
    features: jest.fn(),
    send: jest.fn(),
    uploadFrom: jest.fn(),
  };
  // FTPFileSystem only needs the single-concurrency executor and the
  // basic-ftp client from its FTPClient
  const remoteClient = {
    getFsClient: () => client,
    run: (task: () => Promise<unknown>) => task(),
  };
  const fs = new FTPFileSystem(upath, { client: remoteClient as any });
  return { fs, client };
}

const listing = (name: string, size: number) => [
  {
    name,
    size,
    type: BasicFtpFileType.File,
    modifiedAt: new Date(0),
    permissions: undefined,
    link: undefined,
  },
];

describe('FTPFileSystem.statSize', () => {
  test('asks SIZE and never lists', async () => {
    const { fs, client } = createFs();
    client.size.mockResolvedValue(1234);

    await expect(fs.statSize('/www/a.txt')).resolves.toBe(1234);

    expect(client.size).toHaveBeenCalledWith('/www/a.txt');
    expect(client.list).not.toHaveBeenCalled();
  });

  test('falls back to lstat when SIZE is not implemented, and remembers it', async () => {
    const { fs, client } = createFs();
    client.size.mockRejectedValue(ftpError(502, '502 Command not implemented.'));
    client.list.mockResolvedValue(listing('a.txt', 77));

    await expect(fs.statSize('/www/a.txt')).resolves.toBe(77);
    await expect(fs.statSize('/www/a.txt')).resolves.toBe(77);

    // SIZE tried once, LIST of the parent for each call after that
    expect(client.size).toHaveBeenCalledTimes(1);
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(client.list).toHaveBeenCalledWith('/www');
  });

  test('falls back when the reply cannot be read as a number', async () => {
    const { fs, client } = createFs();
    client.size.mockRejectedValue(
      new Error("Can't parse response to command 'SIZE /www/a.txt' as a numerical value: 202 ok")
    );
    client.list.mockResolvedValue(listing('a.txt', 5));

    await expect(fs.statSize('/www/a.txt')).resolves.toBe(5);
  });

  test('a 550 is "no such file", not "unsupported": it propagates and SIZE stays on', async () => {
    const { fs, client } = createFs();
    client.size.mockRejectedValueOnce(ftpError(550, '550 Could not get file size.'));
    client.size.mockResolvedValueOnce(9);

    await expect(fs.statSize('/www/missing.txt')).rejects.toMatchObject({ code: 550 });
    await expect(fs.statSize('/www/a.txt')).resolves.toBe(9);

    expect(client.list).not.toHaveBeenCalled();
  });

  test('a 550 about ASCII mode is treated as unsupported', async () => {
    const { fs, client } = createFs();
    client.size.mockRejectedValue(ftpError(550, '550 SIZE not allowed in ASCII mode'));
    client.list.mockResolvedValue(listing('a.txt', 3));

    await expect(fs.statSize('/www/a.txt')).resolves.toBe(3);
  });
});

describe('FTPFileSystem.statMtime', () => {
  test('opts out of the mtime hint instead of listing the parent', async () => {
    const { fs, client } = createFs();

    await expect(fs.statMtime('/www/a.txt')).resolves.toBeUndefined();

    expect(client.list).not.toHaveBeenCalled();
  });
});

/**
 * The hash level of the verification over FTP rides on whatever digest
 * command FEAT advertises. These cases pin down the choice (strongest first,
 * HASH negotiated with OPTS), that FEAT is asked once, and the parsing of the
 * replies the different commands give.
 */

const SHA256_HEX = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const SHA1_HEX = 'a9993e364706816aba3e25717850c26c9cd0d89d';
const MD5_HEX = '5d41402abc4b2a76b9719d911017c592';

const feat = (entries: { [name: string]: string }) => new Map(Object.keys(entries).map(k => [k, entries[k]] as [string, string]));
const reply = (code: number, message: string) => ({ code, message });

describe('FTPFileSystem.supportsHash', () => {
  test('asks FEAT once and prefers XSHA256', async () => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat({ XSHA256: '', XMD5: '', XCRC: '', MLST: 'type*;size*;' }));

    await expect(fs.supportsHash()).resolves.toBe('sha256');
    await expect(fs.supportsHash()).resolves.toBe('sha256');

    expect(client.features).toHaveBeenCalledTimes(1);
    expect(client.send).not.toHaveBeenCalled();
  });

  test.each([
    [{ XSHA1: '', XMD5: '', XCRC: '' }, 'sha1'],
    [{ XMD5: '', XCRC: '' }, 'md5'],
    [{ XCRC: '' }, 'crc32'],
  ])('with FEAT %j picks %s', async (features, algorithm) => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat(features));

    await expect(fs.supportsHash()).resolves.toBe(algorithm);
  });

  test('uses HASH with SHA-256 selected through OPTS when the X* commands are missing', async () => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat({ HASH: 'SHA-1*;SHA-256;SHA-512;MD5;CRC32' }));
    client.send.mockResolvedValue(reply(200, '200 SHA-256'));

    await expect(fs.supportsHash()).resolves.toBe('sha256');

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send).toHaveBeenCalledWith('OPTS HASH SHA-256');
  });

  test('skips OPTS when the wanted HASH algorithm is already the server default', async () => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat({ HASH: 'SHA-256*;SHA-1;MD5' }));

    await expect(fs.supportsHash()).resolves.toBe('sha256');

    expect(client.send).not.toHaveBeenCalled();
  });

  test('ranks HASH SHA-256 above XMD5, but an OPTS the server rejects moves on', async () => {
    const accepted = createFs();
    accepted.client.features.mockResolvedValue(feat({ XMD5: '', HASH: 'SHA-1*;SHA-256' }));
    accepted.client.send.mockResolvedValue(reply(200, '200 SHA-256'));
    await expect(accepted.fs.supportsHash()).resolves.toBe('sha256');

    // the server default (MD5) needs no OPTS, but it ranks below XMD5 anyway
    const rejected = createFs();
    rejected.client.features.mockResolvedValue(feat({ XMD5: '', HASH: 'MD5*;SHA-1;SHA-256' }));
    rejected.client.send.mockRejectedValue(ftpError(501, '501 Unknown hash algorithm'));
    await expect(rejected.fs.supportsHash()).resolves.toBe('md5');
    // SHA-256 tried, SHA-1 tried, then XMD5 without any OPTS
    expect(rejected.client.send.mock.calls.map(call => call[0])).toEqual([
      'OPTS HASH SHA-256',
      'OPTS HASH SHA-1',
    ]);
  });

  test('reads FEAT names case-insensitively', async () => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat({ xsha256: '' }));

    await expect(fs.supportsHash()).resolves.toBe('sha256');
  });

  test('answers null, once, when FEAT lists no digest command or fails', async () => {
    const bare = createFs();
    bare.client.features.mockResolvedValue(feat({ MLST: 'type*;size*;', SIZE: '', MDTM: '' }));
    await expect(bare.fs.supportsHash()).resolves.toBeNull();
    await expect(bare.fs.supportsHash()).resolves.toBeNull();
    expect(bare.client.features).toHaveBeenCalledTimes(1);
    await expect(bare.fs.hashFile('/www/a.txt', 'sha256')).rejects.toThrow('not available');

    const broken = createFs();
    broken.client.features.mockRejectedValue(new Error('Connection closed'));
    await expect(broken.fs.supportsHash()).resolves.toBeNull();
  });

  test('parallel callers share one FEAT', async () => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat({ XSHA256: '' }));

    await Promise.all([fs.supportsHash(), fs.supportsHash()]);

    expect(client.features).toHaveBeenCalledTimes(1);
  });
});

describe('FTPFileSystem.hashFile', () => {
  test('sends XSHA256 with the path and parses "250 <hex>"', async () => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat({ XSHA256: '' }));
    client.send.mockResolvedValue(reply(250, `250 ${SHA256_HEX}`));

    await expect(fs.hashFile('/www/a.txt', 'sha256')).resolves.toBe(SHA256_HEX);

    expect(client.send).toHaveBeenCalledWith('XSHA256 /www/a.txt');
  });

  test('parses "250 <hex> <path>" from XMD5 and XSHA1', async () => {
    const md5 = createFs();
    md5.client.features.mockResolvedValue(feat({ XMD5: '' }));
    md5.client.send.mockResolvedValue(reply(250, `250 ${MD5_HEX} /www/a.txt`));
    await expect(md5.fs.hashFile('/www/a.txt', 'md5')).resolves.toBe(MD5_HEX);
    expect(md5.client.send).toHaveBeenCalledWith('XMD5 /www/a.txt');

    const sha1 = createFs();
    sha1.client.features.mockResolvedValue(feat({ XSHA1: '' }));
    sha1.client.send.mockResolvedValue(reply(250, `250 ${SHA1_HEX.toUpperCase()} /www/a.txt`));
    await expect(sha1.fs.hashFile('/www/a.txt', 'sha1')).resolves.toBe(SHA1_HEX);
  });

  test('lowercases the uppercase hex XCRC answers', async () => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat({ XCRC: '' }));
    client.send.mockResolvedValue(reply(250, '250 CBF43926'));

    await expect(fs.hashFile('/www/a.txt', 'crc32')).resolves.toBe('cbf43926');
    expect(client.send).toHaveBeenCalledWith('XCRC /www/a.txt');
  });

  test('parses the HASH reply "213 SHA-256 0-<n> <hex> <path>"', async () => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat({ HASH: 'SHA-256*;SHA-1' }));
    client.send.mockResolvedValue(reply(213, `213 SHA-256 0-21 ${SHA256_HEX} /www/a.txt`));

    await expect(fs.hashFile('/www/a.txt', 'sha256')).resolves.toBe(SHA256_HEX);
    expect(client.send).toHaveBeenCalledWith('HASH /www/a.txt');
  });

  test('is not fooled by a hex-looking path: the digest comes first', async () => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat({ XMD5: '' }));
    const hexName = 'ffffffffffffffffffffffffffffffff';
    client.send.mockResolvedValue(reply(250, `250 ${MD5_HEX} /objects/${hexName}`));

    await expect(fs.hashFile(`/objects/${hexName}`, 'md5')).resolves.toBe(MD5_HEX);
  });

  test('rejects when asked for an algorithm other than the one chosen', async () => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat({ XMD5: '' }));

    await expect(fs.hashFile('/www/a.txt', 'sha256')).rejects.toThrow('sha256 is not available');
    expect(client.send).not.toHaveBeenCalled();
  });

  test('rejects when the reply carries no digest of the expected length', async () => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat({ XSHA256: '' }));
    client.send.mockResolvedValue(reply(250, '250 OK'));

    await expect(fs.hashFile('/www/a.txt', 'sha256')).rejects.toThrow(/unexpected XSHA256 reply/);
  });

  test('propagates a negative reply (file missing, command refused)', async () => {
    const { fs, client } = createFs();
    client.features.mockResolvedValue(feat({ XSHA256: '' }));
    client.send.mockRejectedValue(ftpError(550, '550 No such file'));

    await expect(fs.hashFile('/www/missing.txt', 'sha256')).rejects.toMatchObject({ code: 550 });
  });
});

describe('parseFtpDigest', () => {
  test.each([
    ['250 CBF43926', 'crc32', 'cbf43926'],
    [`250 ${MD5_HEX} /www/a.txt`, 'md5', MD5_HEX],
    [`213 SHA-256 0-21 ${SHA256_HEX} /www/a.txt`, 'sha256', SHA256_HEX],
    ['250-XSHA256 result\n' + `250 ${SHA256_HEX}`, 'sha256', SHA256_HEX],
    ['250 OK', 'sha256', undefined],
    [`250 ${MD5_HEX}`, 'sha256', undefined],
  ])('%j as %s -> %s', (message, algorithm, expected) => {
    expect(parseFtpDigest(message, algorithm as any)).toBe(expected);
  });
});

/**
 * The end of an upload source is held until the data socket is secure: an
 * empty file otherwise shuts the socket down in the middle of its TLS
 * handshake, which Pure-FTPd answers by closing the session.
 */
describe('endAfterSecureConnect', () => {
  function sourceOf(...chunks: string[]) {
    const source = new PassThrough();
    chunks.forEach(chunk => source.write(chunk));
    source.end();
    return source;
  }

  // a TLS socket in the middle of its handshake, as far as the gate looks
  function handshakingSocket() {
    return Object.assign(new EventEmitter(), { secureConnecting: true, destroyed: false });
  }

  function collect(stream: Readable) {
    const state = { data: '', ended: false, error: undefined as Error | undefined };
    stream.on('data', chunk => (state.data += chunk));
    stream.on('end', () => (state.ended = true));
    stream.on('error', error => (state.error = error));
    return state;
  }

  const tick = () => new Promise(resolve => setTimeout(resolve, 10));

  test('an empty source does not end while the data socket is handshaking', async () => {
    const socket = handshakingSocket();
    const state = collect(endAfterSecureConnect(sourceOf(), () => socket));

    await tick();
    expect(state.ended).toBe(false);

    socket.secureConnecting = false;
    socket.emit('secureConnect');
    await tick();
    expect(state.ended).toBe(true);
    expect(state.data).toBe('');
    expect(socket.listenerCount('secureConnect')).toBe(0);
    expect(socket.listenerCount('close')).toBe(0);
  });

  test('the content goes through untouched and its end waits for the handshake too', async () => {
    const socket = handshakingSocket();
    const state = collect(endAfterSecureConnect(sourceOf('hola ', 'mundo'), () => socket));

    await tick();
    expect(state.data).toBe('hola mundo');
    expect(state.ended).toBe(false);

    socket.emit('secureConnect');
    await tick();
    expect(state.ended).toBe(true);
  });

  test.each([
    ['a secure socket', () => Object.assign(new EventEmitter(), { secureConnecting: false })],
    ['a plain socket', () => new EventEmitter()],
    ['no data socket', () => undefined],
  ])('ends at once with %s', async (_name, socket) => {
    const state = collect(endAfterSecureConnect(sourceOf('abc'), socket));

    await tick();
    expect(state.data).toBe('abc');
    expect(state.ended).toBe(true);
  });

  test('a data socket that closes during the handshake releases the end', async () => {
    const socket = handshakingSocket();
    const state = collect(endAfterSecureConnect(sourceOf(), () => socket));

    await tick();
    socket.emit('close');
    await tick();
    expect(state.ended).toBe(true);
  });

  test('nothing is read from the source before the result is read', async () => {
    const source = sourceOf('abc');
    const read = jest.spyOn(source, 'read');
    const output = endAfterSecureConnect(source, () => undefined);

    await tick();
    expect(read).not.toHaveBeenCalled();
    expect(source.listenerCount('data')).toBe(0);

    const state = collect(output);
    await tick();
    expect(state.data).toBe('abc');
  });

  test('an error of the source fails the result', async () => {
    const source = new PassThrough();
    const state = collect(endAfterSecureConnect(source, () => undefined));

    await tick();
    source.emit('error', new Error('read failed'));
    await tick();
    expect(state.error).toEqual(new Error('read failed'));
    expect(state.ended).toBe(false);
  });

  test('a source destroyed before its end fails the result instead of hanging', async () => {
    const source = new PassThrough();
    const state = collect(endAfterSecureConnect(source, () => undefined));

    await tick();
    source.destroy();
    await tick();
    expect(state.error).toBeDefined();
    expect(state.ended).toBe(false);
  });

  test('destroying the result destroys the source', async () => {
    const source = new PassThrough();
    const output = endAfterSecureConnect(source, () => undefined);
    collect(output);

    await tick();
    output.destroy();
    await tick();
    expect(source.destroyed).toBe(true);
  });
});

describe('FTPFileSystem.put', () => {
  test('uploads through the handshake gate of the current data socket', async () => {
    const { fs, client } = createFs();
    const socket = Object.assign(new EventEmitter(), { secureConnecting: true, destroyed: false });
    (client as any).ftp = { dataSocket: socket };
    let ended = false;
    client.uploadFrom.mockImplementation(
      (source: Readable) =>
        new Promise(resolve => {
          source.on('data', () => undefined);
          source.on('end', () => {
            ended = true;
            resolve({ code: 226, message: '226 File successfully transferred' });
          });
        })
    );
    const input = new PassThrough();
    input.end();

    const put = fs.put(input, '/www/empty.txt');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(client.uploadFrom).toHaveBeenCalledWith(expect.any(Readable), '/www/empty.txt');
    expect(ended).toBe(false);

    socket.emit('secureConnect');
    await expect(put).resolves.toBeUndefined();
    expect(ended).toBe(true);
  });
});
