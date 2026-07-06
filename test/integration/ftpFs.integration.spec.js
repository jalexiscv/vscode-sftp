// Integration test for the FTP filesystem against a REAL server.
//
// It is skipped unless the following env vars are set (so CI never runs it):
//   FTP_TEST_HOST, FTP_TEST_USER, FTP_TEST_PASSWORD
//   optional: FTP_TEST_PORT (21), FTP_TEST_SECURE ('true' for explicit FTPS)
//
// The suite only touches an isolated directory it creates itself and removes
// it at the end. Nothing pre-existing on the server is read or modified.
const { Readable } = require('stream');
const upath = require('../../src/core/upath').default;
const FTPFileSystem = require('../../src/core/fs/ftpFileSystem').default;
const { FileType } = require('../../src/core/fs/fileSystem');

const HOST = process.env.FTP_TEST_HOST;
const describeIf = HOST ? describe : describe.skip;

jest.setTimeout(180000);

function streamOf(content) {
  const s = new Readable();
  s._read = () => {
    // noop: content is pushed below
  };
  s.push(content);
  s.push(null);
  return s;
}

describeIf('ftp filesystem against a real server', () => {
  const testDir = `/_vscode-sftp-it-${Date.now()}`;
  const fileA = `${testDir}/a.txt`;
  const fileB = `${testDir}/b.txt`;
  const CONTENT = 'vscode-sftp basic-ftp migration probe';
  let fs;

  const clientOption = {
    host: HOST,
    port: Number(process.env.FTP_TEST_PORT || 21),
    username: process.env.FTP_TEST_USER,
    password: process.env.FTP_TEST_PASSWORD,
    secure: process.env.FTP_TEST_SECURE === 'true',
    secureOptions: { rejectUnauthorized: false },
    passive: true,
    connectTimeout: 20 * 1000,
    debug() {
      // silent
    },
  };

  beforeAll(async () => {
    fs = new FTPFileSystem(upath, {
      clientOption,
      remoteTimeOffsetInHours: 0,
    });
    await fs.connect(clientOption, { askForPasswd: async () => undefined });
  });

  afterAll(async () => {
    // best-effort cleanup of OUR test dir only
    try {
      await fs.rmdir(testDir, true);
    } catch (_error) {
      // already removed by the last test
    }
    fs.end();
  });

  test('creates an isolated test directory', async () => {
    await fs.ensureDir(testDir);
    const stat = await fs.lstat(testDir);
    expect(stat.type).toBe(FileType.Directory);
  });

  test('uploads a file', async () => {
    await fs.put(streamOf(CONTENT), fileA);
    const stat = await fs.lstat(fileA);
    expect(stat.type).toBe(FileType.File);
    expect(stat.size).toBe(CONTENT.length);
  });

  test('lists the directory', async () => {
    const entries = await fs.list(testDir);
    expect(entries.map(e => e.name)).toContain('a.txt');
  });

  test('downloads the content back', async () => {
    const buffer = await fs.readFile(fileA);
    expect(buffer.toString()).toBe(CONTENT);
  });

  test('sets the modified time (MFMT, tolerated if unsupported)', async () => {
    const fd = await fs.open(fileA, 'r');
    const mtime = Math.floor(Date.now() / 1000) - 3600;
    await fs.futimes(fd, mtime, mtime);
    await fs.close(fd);
  });

  test('renames a file', async () => {
    await fs.rename(fileA, fileB);
    const entries = await fs.list(testDir);
    const names = entries.map(e => e.name);
    expect(names).toContain('b.txt');
    expect(names).not.toContain('a.txt');
  });

  test('deletes the file', async () => {
    await fs.unlink(fileB);
    const entries = await fs.list(testDir);
    expect(entries.map(e => e.name)).not.toContain('b.txt');
  });

  test('removes the test directory', async () => {
    await fs.rmdir(testDir, true);
    await expect(fs.lstat(testDir)).rejects.toBeDefined();
  });
});
