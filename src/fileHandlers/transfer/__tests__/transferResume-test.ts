jest.mock('fs');
// The default vscode mock answers every lookup with "Nothing", and that makes
// `x instanceof Uri` true for any x — which is exactly the branch the file
// handlers take to tell a context from a Uri. Give them a real Uri class and
// keep "Nothing" for everything else.
jest.mock('vscode', () => {
  const Nothing = jest.requireActual('../../../../__mocks__/vscode.js');
  class Uri {
    static file(fsPath: string) {
      return new Uri(fsPath);
    }
    readonly scheme = 'file';
    constructor(readonly fsPath: string) {}
    toString() {
      return `file://${this.fsPath}`;
    }
  }
  return new Proxy({ Uri }, { get: (target, key) => (key in target ? target[key] : Nothing) });
});
// the explorer refresh needs a live remote explorer; here it is irrelevant
jest.mock('../../shared', () => ({ refreshRemoteExplorer: jest.fn() }));
// the outage notice must be observable, and the workspace-relative path the
// messages name has no workspace here
jest.mock('../../../host', () => ({
  ...jest.requireActual('../../../host'),
  showWarningMessage: jest.fn(),
  pathRelativeToWorkspace: (localPath: string) => localPath,
}));

import * as fs from 'fs';
import * as path from 'path';
import { vol } from 'memfs';
import FileService from '../../../core/fileService';
import { TransferFailedError } from '../../../core';
import { setRetryBaseDelayForTest } from '../../../core/transferTask';
import { ConnectionGate, ConnectionOnHoldError } from '../../../core/connectionHealth';
import { isReported } from '../../../helper';
import { showWarningMessage } from '../../../host';
import logger from '../../../logger';
import RemoteFs from '../../../../test/helper/localRemoteFs';
// through the package index, like the rest of the extension: the handlers sit
// inside an import cycle and the index is the entry that resolves it
import { uploadFolder, sync2Remote } from '../../index';
import { setResumeDelayForTest, __resetResumeStateForTest, MAX_RESUMES } from '../resume';

/**
 * A command interrupted by a lost connection (`Upload Folder`, `Sync…`) used
 * to end there: the folder walk ran `ensureDir`/`list` on a client the
 * keep-alive layer had already ended, every call failed with "Client is
 * closed" and the command gave up with the rest of the tree untouched. The
 * handlers now hold, wait for the connection gate, ask for a live file
 * system and walk the target again, skipping what already went through.
 */

const FAST_DELAY_MS = 1;

type Fs = InstanceType<typeof RemoteFs> & { put: any; ensureDir: any };

function createRemoteFs(): Fs {
  return new RemoteFs(path, {
    clientOption: {} as any,
    remoteTimeOffsetInHours: 0,
  }) as any;
}

// the helper defines its methods as non-writable prototype properties, so a
// plain assignment is rejected; shadow them on the instance instead
function override(remoteFs: Fs, method: 'put' | 'ensureDir', impl: (...args: any[]) => any) {
  Object.defineProperty(remoteFs, method, { value: impl, configurable: true });
}

// what basic-ftp says once the data socket of a previous transfer was reset:
// no `code`, the message alone tells
const clientClosed = () => new Error('Client is closed because read ECONNRESET (data socket)');

/** A file system whose `ensureDir` fails `times` times, then works. */
function fsFailingEnsureDir(times: number, error: () => Error = clientClosed): Fs {
  const remoteFs = createRemoteFs();
  const ensureDir = remoteFs.ensureDir.bind(remoteFs);
  let left = times;
  override(remoteFs, 'ensureDir', (dir: string) => {
    if (left > 0) {
      left -= 1;
      return Promise.reject(error());
    }
    return ensureDir(dir);
  });
  return remoteFs;
}

/** Counts the puts per target basename on `remoteFs`; `failing` decides which reject. */
function countPuts(remoteFs: Fs, failing: (name: string, attempt: number) => Error | undefined) {
  const put = remoteFs.put.bind(remoteFs);
  const puts: { [name: string]: number } = {};
  override(remoteFs, 'put', (input, target, option) => {
    const name = path.basename(target);
    puts[name] = (puts[name] || 0) + 1;
    const error = failing(name, puts[name]);
    if (error) {
      return Promise.reject(error);
    }
    return put(input, target, option);
  });
  return puts;
}

interface Service {
  service: FileService;
  gate: ConnectionGate;
  getRemoteFileSystem: jest.Mock;
}

/** A service whose connection attempts hand out `fileSystems` in turn (the last one repeats). */
function createService(...fileSystems: Array<Fs | Error>): Service {
  const service = new FileService('/local', '/local', {} as any);
  const gate = new ConnectionGate('example.test');
  let calls = 0;
  const getRemoteFileSystem = jest.fn(() => {
    const next = fileSystems[Math.min(calls, fileSystems.length - 1)];
    calls += 1;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  (service as any).getRemoteFileSystem = getRemoteFileSystem;
  (service as any).getConnectionGate = () => gate;
  return { service, gate, getRemoteFileSystem };
}

function contextFor(service: FileService, localFsPath: string, remoteFsPath: string, concurrency = 1) {
  return {
    fileService: service,
    config: {
      protocol: 'sftp',
      concurrency,
      useTempFile: false,
      openSsh: false,
      remotePath: '/remote',
      host: 'example.test',
      port: 22,
    } as any,
    target: { localFsPath, remoteFsPath } as any,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

const warned = () => (showWarningMessage as jest.Mock).mock.calls.map(call => call[0] as string);

describe('transfer handlers: a lost connection holds the command and resumes it', () => {
  let warn: jest.SpyInstance;
  let info: jest.SpyInstance;

  beforeAll(() => {
    setRetryBaseDelayForTest(FAST_DELAY_MS);
    setResumeDelayForTest(FAST_DELAY_MS);
  });

  afterAll(() => {
    setRetryBaseDelayForTest();
    setResumeDelayForTest();
  });

  beforeEach(() => {
    vol.reset();
    vol.fromJSON({ '/local/dir/a.txt': 'a', '/local/dir/b.txt': 'b', '/local/dir/c.txt': 'c' }, '/');
    (showWarningMessage as jest.Mock).mockClear();
    __resetResumeStateForTest();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    info.mockRestore();
  });

  test('a connection lost while entering the folder is retried over a fresh connection', async () => {
    const dead = fsFailingEnsureDir(1);
    const live = createRemoteFs();
    const { service, getRemoteFileSystem } = createService(dead, live);

    await expect(uploadFolder(contextFor(service, '/local/dir', '/remote/dir'))).resolves.toBeUndefined();

    expect(getRemoteFileSystem).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync('/remote/dir/a.txt', 'utf8')).toBe('a');
    expect(fs.readFileSync('/remote/dir/c.txt', 'utf8')).toBe('c');
    expect(warn.mock.calls.map(call => call[0])).toEqual([
      expect.stringMatching(
        /^\[upload\] .*dir on hold: Client is closed because read ECONNRESET \(data socket\); resuming in 1 s \(1\/10, 0 file\(s\) done so far\)$/
      ),
    ]);
    expect(info.mock.calls.map(call => call[0])).toContainEqual(
      expect.stringMatching(/^\[upload\] .*dir: resuming \(1\/10\)$/)
    );
  });

  test('the files already sent are not sent again; the interrupted and the dropped ones are', async () => {
    const remoteFs = createRemoteFs();
    const puts = countPuts(remoteFs, (name, attempt) =>
      name === 'b.txt' && attempt === 1
        ? Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
        : undefined
    );
    const { service, getRemoteFileSystem } = createService(remoteFs);

    await expect(uploadFolder(contextFor(service, '/local/dir', '/remote/dir'))).resolves.toBeUndefined();

    // concurrency 1: a went through, b was in flight, c was still queued
    expect(puts).toEqual({ 'a.txt': 1, 'b.txt': 2, 'c.txt': 1 });
    expect(getRemoteFileSystem).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync('/remote/dir/b.txt', 'utf8')).toBe('b');
    expect(warn.mock.calls.map(call => call[0])).toContainEqual(
      expect.stringMatching(/on hold: read ECONNRESET; resuming in 1 s \(1\/10, 1 file\(s\) done so far\)$/)
    );
  });

  test('a file the connection dies on every time is given up after three holds; the rest goes through', async () => {
    const remoteFs = createRemoteFs();
    const puts = countPuts(remoteFs, name =>
      name === 'b.txt' ? Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) : undefined
    );
    const { service, getRemoteFileSystem } = createService(remoteFs);

    const error = await rejectionOf(uploadFolder(contextFor(service, '/local/dir', '/remote/dir')));

    expect(puts).toEqual({ 'a.txt': 1, 'b.txt': 3, 'c.txt': 1 });
    expect(getRemoteFileSystem).toHaveBeenCalledTimes(4);
    expect(fs.readFileSync('/remote/dir/c.txt', 'utf8')).toBe('c');
    expect(error).toBeInstanceOf(TransferFailedError);
    expect(error.message).toBe('1 of 3 file(s) failed to upload: b.txt (ECONNRESET)');
    expect(error.failures[0].error.message).toBe(
      'connection lost 3 times while uploading this file: read ECONNRESET'
    );
    // nobody showed this one per file: the aggregate is the notice
    expect(isReported(error)).toBe(false);
    expect((error as any).connectionLost).not.toBe(true);
    expect(warn.mock.calls.map(call => call[0])).toContainEqual(
      expect.stringMatching(/^\[upload\] .*b\.txt given up: connection lost 3 times while uploading this file: read ECONNRESET$/)
    );
  });

  test('when the resumes run out, the command fails with the connection-lost aggregate', async () => {
    const { service, getRemoteFileSystem } = createService(fsFailingEnsureDir(Infinity));

    const error = await rejectionOf(uploadFolder(contextFor(service, '/local/dir', '/remote/dir')));

    expect(getRemoteFileSystem).toHaveBeenCalledTimes(MAX_RESUMES + 1);
    expect(error).toBeInstanceOf(TransferFailedError);
    expect(error.message).toBe(
      'Connection lost while trying to upload (Client is closed because read ECONNRESET (data socket)): ' +
        '0 done, 0 interrupted; the remaining files were not attempted, after 10 attempt(s) to resume. ' +
        'Run the command again once the server is back.'
    );
    // flagged, so a command over several selections reports it once
    expect((error as any).connectionLost).toBe(true);
    expect(isReported(error)).toBe(false);
    expect(warn.mock.calls.map(call => call[0])).toContainEqual(
      expect.stringMatching(/^\[upload\] .*dir not resumed any more after 10 attempt\(s\): Client is closed/)
    );
  });

  test('a reconnection that is held by the gate counts as a resume and is tried again', async () => {
    const onHold = new ConnectionOnHoldError('example.test', 1, 'read ECONNRESET');
    const { service, getRemoteFileSystem } = createService(fsFailingEnsureDir(1), onHold, createRemoteFs());

    await expect(uploadFolder(contextFor(service, '/local/dir', '/remote/dir'))).resolves.toBeUndefined();

    expect(getRemoteFileSystem).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync('/remote/dir/a.txt', 'utf8')).toBe('a');
    expect(warn.mock.calls.map(call => call[0])).toContainEqual(
      expect.stringMatching(/on hold: \[example\.test\]: connection is down \(read ECONNRESET\); next attempt in 1 s; resuming in 1 s \(2\/10/)
    );
  });

  test('a failure that is not a lost connection is not retried and propagates as it is', async () => {
    const denied = () => Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const { service, getRemoteFileSystem } = createService(fsFailingEnsureDir(1, denied), createRemoteFs());

    const error = await rejectionOf(uploadFolder(contextFor(service, '/local/dir', '/remote/dir')));

    expect(error.code).toBe('EACCES');
    expect(getRemoteFileSystem).toHaveBeenCalledTimes(1);
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  test('a sync resumes the same way', async () => {
    const { service, getRemoteFileSystem } = createService(fsFailingEnsureDir(1), createRemoteFs());

    await expect(sync2Remote(contextFor(service, '/local/dir', '/remote/dir'))).resolves.toBeUndefined();

    expect(getRemoteFileSystem).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync('/remote/dir/b.txt', 'utf8')).toBe('b');
  });

  test('the outage is announced once per server, and again after it recovered', async () => {
    vol.fromJSON({ '/local/other/d.txt': 'd' }, '/');
    const { service, gate } = createService(fsFailingEnsureDir(2), createRemoteFs());

    // two selections of one command, both interrupted by the same outage
    await Promise.all([
      uploadFolder(contextFor(service, '/local/dir', '/remote/dir')),
      uploadFolder(contextFor(service, '/local/other', '/remote/other')),
    ]);

    expect(warned()).toEqual([
      'SFTP: connection to example.test lost (Client is closed because read ECONNRESET (data socket)). ' +
        'The upload of /local/dir is on hold and will resume when it is back.',
    ]);

    // the connection came back and went again: a new outage, a new notice
    gate.recordDrop('read ECONNRESET');
    gate.recordSuccess();
    const again = createService(fsFailingEnsureDir(1), createRemoteFs());
    (again.service as any).getConnectionGate = () => gate;
    await uploadFolder(contextFor(again.service, '/local/dir', '/remote/dir'));

    expect(warned()).toHaveLength(2);
  });

  test('the gate reporting the connection back resumes the command before its delay', async () => {
    setResumeDelayForTest(60 * 1000);
    try {
      const { service, gate } = createService(fsFailingEnsureDir(1), createRemoteFs());
      const started = Date.now();
      const run = uploadFolder(contextFor(service, '/local/dir', '/remote/dir'));
      setTimeout(() => {
        gate.recordDrop('read ECONNRESET');
        gate.recordSuccess();
      }, 20);

      await expect(run).resolves.toBeUndefined();

      expect(Date.now() - started).toBeLessThan(5000);
      expect(fs.readFileSync('/remote/dir/a.txt', 'utf8')).toBe('a');
    } finally {
      setResumeDelayForTest(FAST_DELAY_MS);
    }
  });
});
