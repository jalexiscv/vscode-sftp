import { FileType as BasicFtpFileType } from 'basic-ftp';
import FTPFileSystem from '../ftpFileSystem';
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
