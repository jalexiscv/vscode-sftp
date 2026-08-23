jest.mock('fs');
// The default vscode mock answers every lookup with "Nothing", and that makes
// `x instanceof Uri` true for any x — which is exactly the branch the file
// handlers take to tell a context from a Uri. Give them a real Uri class and
// keep "Nothing" for everything else.
jest.mock('vscode', () => {
  // requireActual: to jest that file *is* the 'vscode' module, so a plain
  // require would re-enter this factory
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
// the explorer refresh needs a live remote explorer; here it only has to be
// observable
jest.mock('../../shared', () => ({ refreshRemoteExplorer: jest.fn() }));

import * as fs from 'fs';
import * as path from 'path';
import { vol } from 'memfs';
import FileService from '../../../core/fileService';
import { TransferFailedError, ETRANSFER_FAILED } from '../../../core';
import { isReported } from '../../../helper';
import RemoteFs from '../../../../test/helper/localRemoteFs';
import { refreshRemoteExplorer } from '../../shared';
// through the package index, like the rest of the extension: the handlers sit
// inside an import cycle and the index is the entry that resolves it
import { uploadFile, downloadFile } from '../../index';

/**
 * End to end over memfs: `uploadFile`/`downloadFile` must reject when a task of
 * the batch fails, with an aggregate that is already flagged as reported.
 */

type FailingFs = InstanceType<typeof RemoteFs> & { put: any; get: any };

function createRemoteFs(): FailingFs {
  return new RemoteFs(path, {
    clientOption: {} as any,
    remoteTimeOffsetInHours: 0,
  }) as any;
}

function createService(remoteFs: FailingFs): FileService {
  const service = new FileService('/local', '/local', {} as any);
  // the real method opens an ssh/ftp connection
  (service as any).getRemoteFileSystem = () => Promise.resolve(remoteFs);
  return service;
}

function contextFor(service: FileService, localFsPath: string, remoteFsPath: string) {
  return {
    fileService: service,
    config: {
      protocol: 'sftp',
      concurrency: 2,
      useTempFile: false,
      openSsh: false,
      remotePath: '/remote',
      host: 'example.test',
      port: 22,
    } as any,
    target: { localFsPath, remoteFsPath } as any,
  };
}

// the helper defines its methods as non-writable prototype properties, so a
// plain assignment is rejected; shadow them on the instance instead
function override(remoteFs: FailingFs, method: 'put' | 'get', impl: (...args: any[]) => any) {
  Object.defineProperty(remoteFs, method, { value: impl, configurable: true });
}

function failPutFor(remoteFs: FailingFs, shouldFail: (target: string) => boolean) {
  const put = remoteFs.put.bind(remoteFs);
  override(remoteFs, 'put', (input, target, option) => {
    if (shouldFail(target)) {
      return Promise.reject(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
    }
    return put(input, target, option);
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('transfer handlers', () => {
  beforeEach(() => {
    vol.reset();
    (refreshRemoteExplorer as jest.Mock).mockClear();
  });

  test('uploadFile rejects with an already-reported aggregate when a file fails', async () => {
    vol.fromJSON({ '/local/dir/a.txt': 'a', '/local/dir/b.txt': 'b', '/local/dir/c.txt': 'c' }, '/');
    const remoteFs = createRemoteFs();
    failPutFor(remoteFs, target => path.basename(target) === 'b.txt');
    const service = createService(remoteFs);

    const error = await rejectionOf(uploadFile(contextFor(service, '/local/dir', '/remote/dir')));

    expect(error).toBeInstanceOf(TransferFailedError);
    expect(error.code).toBe(ETRANSFER_FAILED);
    expect(isReported(error)).toBe(true);
    expect(error.failures.map(f => path.basename(f.task.localFsPath))).toEqual(['b.txt']);
    expect(error.failures[0].error.code).toBe('EACCES');
    expect(error.message).toBe('1 of 3 file(s) failed to upload: b.txt (EACCES)');

    // the rest of the batch still went through
    expect(fs.readFileSync('/remote/dir/a.txt', 'utf8')).toBe('a');
    expect(fs.readFileSync('/remote/dir/c.txt', 'utf8')).toBe('c');
  });

  test('a partial failure still runs afterHandle, so the explorer reflects what changed', async () => {
    vol.fromJSON({ '/local/dir/a.txt': 'a', '/local/dir/b.txt': 'b' }, '/');
    const remoteFs = createRemoteFs();
    failPutFor(remoteFs, target => path.basename(target) === 'b.txt');

    await rejectionOf(uploadFile(contextFor(createService(remoteFs), '/local/dir', '/remote/dir')));

    expect(refreshRemoteExplorer).toHaveBeenCalledTimes(1);
  });

  test('uploadFile resolves when every file goes through', async () => {
    vol.fromJSON({ '/local/dir/a.txt': 'a', '/local/dir/b.txt': 'b' }, '/');
    const service = createService(createRemoteFs());

    await expect(
      uploadFile(contextFor(service, '/local/dir', '/remote/dir'))
    ).resolves.toBeUndefined();
    expect(fs.readFileSync('/remote/dir/b.txt', 'utf8')).toBe('b');
  });

  test('downloadFile reports the failure in its own direction', async () => {
    vol.fromJSON({ '/remote/x.txt': 'x' }, '/');
    const remoteFs = createRemoteFs();
    override(remoteFs, 'get', () =>
      Promise.reject(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    );
    const service = createService(remoteFs);

    const error = await rejectionOf(downloadFile(contextFor(service, '/local/x.txt', '/remote/x.txt')));

    expect(error).toBeInstanceOf(TransferFailedError);
    expect(error.message).toBe('1 of 1 file(s) failed to download: x.txt (ECONNRESET)');
  });
});
