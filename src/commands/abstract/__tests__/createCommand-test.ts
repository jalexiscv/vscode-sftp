// The default vscode mock answers every lookup with "Nothing"; the commands
// need a Uri with a scheme, an authority and an fsPath.
jest.mock('vscode', () => {
  const Nothing = jest.requireActual('../../../../__mocks__/vscode.js');
  class Uri {
    static file(fsPath: string) {
      return new Uri(fsPath);
    }
    readonly authority = '';
    constructor(readonly fsPath: string, readonly scheme: string = 'file') {}
    toString() {
      return `${this.scheme}://${this.fsPath}`;
    }
  }
  return new Proxy({ Uri }, { get: (target, key) => (key in target ? target[key] : Nothing) });
});
// the handlers resolve a service per Uri through the registry; here a
// context is only a carrier of the path
jest.mock('../../../fileHandlers', () => ({
  handleCtxFromUri: (uri: any) => ({ target: { localFsPath: uri.fsPath } }),
  allHandleCtxFromUri: (uri: any) => [
    { target: { localFsPath: uri.fsPath }, config: { host: 'one' } },
    { target: { localFsPath: uri.fsPath }, config: { host: 'two' } },
  ],
}));
jest.mock('../../../helper', () => ({
  ...jest.requireActual('../../../helper'),
  reportError: jest.fn(),
}));

import * as path from 'path';
import { Uri } from 'vscode';
import { reportError, isReported } from '../../../helper';
import { markConnectionLost } from '../../../core/connectionHealth';
import { createFileCommand, createFileMultiCommand, withoutNestedTargets } from '../createCommand';

/**
 * A file command runs its handler once per selected Uri, all at once. Two
 * things went wrong with that: a folder selected together with a subfolder
 * (or a file in it) was walked twice and every file under both uploaded
 * twice at the same time; and a lost connection, which fails every selection
 * the same way, opened one error dialog per selection.
 */

const local = (...segments: string[]) => path.resolve(path.sep, ...segments);
const uri = (fsPath: string, scheme?: string) => new (Uri as any)(fsPath, scheme) as Uri;

const connectionLost = (message: string) =>
  markConnectionLost(Object.assign(new Error(message), { code: 'ETRANSFER_FAILED' }));

describe('withoutNestedTargets', () => {
  test('drops a selection inside another selected folder, and keeps the order', () => {
    const app = uri(local('site', 'app'));
    const sub = uri(local('site', 'app', 'Modules'));
    const file = uri(local('site', 'app', 'Modules', 'README.md'));
    const other = uri(local('site', 'public'));

    expect(withoutNestedTargets([sub, app, file, other])).toEqual([app, other]);
  });

  test('a sibling whose name starts the same is not inside', () => {
    const app = uri(local('site', 'app'));
    const apps = uri(local('site', 'apps'));

    expect(withoutNestedTargets([app, apps])).toEqual([app, apps]);
  });

  test('the same target twice is kept once', () => {
    const app = uri(local('site', 'app'));
    const again = uri(local('site', 'app') + path.sep);

    expect(withoutNestedTargets([app, again])).toEqual([app]);
  });

  test('paths of another scheme are not compared', () => {
    const localDir = uri(local('site', 'app'));
    const remoteDir = uri(local('site', 'app', 'Modules'), 'remote');

    expect(withoutNestedTargets([localDir, remoteDir])).toEqual([localDir, remoteDir]);
  });

  test('a single selection is returned as it is', () => {
    const app = uri(local('site', 'app'));

    expect(withoutNestedTargets([app])).toEqual([app]);
  });

  if (process.platform === 'win32') {
    test('windows paths are compared without case', () => {
      const app = uri('C:\\Site\\App');
      const sub = uri('c:\\site\\app\\Modules');

      expect(withoutNestedTargets([app, sub])).toEqual([app]);
    });
  }
});

describe('file commands over several selections', () => {
  beforeEach(() => {
    (reportError as jest.Mock).mockClear();
  });

  test('the handler runs once per outermost selection', async () => {
    const handleFile = jest.fn(async () => undefined);
    const app = uri(local('site', 'app'));
    const sub = uri(local('site', 'app', 'Modules'));
    const other = uri(local('site', 'public'));
    const Cmd = createFileCommand({
      id: 'test.upload',
      name: 'Upload Folder',
      getFileTarget: () => [app, sub, other],
      handleFile,
    });

    await new Cmd().run();

    expect(handleFile.mock.calls.map(call => (call[0] as any).target.localFsPath)).toEqual([
      app.fsPath,
      other.fsPath,
    ]);
    expect(reportError).not.toHaveBeenCalled();
  });

  test('a lost connection is reported once for the whole run; other errors one each', async () => {
    const first = connectionLost('Connection lost while trying to upload (read ECONNRESET): 2 done');
    const second = connectionLost('Connection lost while trying to upload (read ECONNRESET): 0 done');
    const denied = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const byPath: { [fsPath: string]: Error } = {
      [local('a')]: first,
      [local('b')]: second,
      [local('c')]: denied,
    };
    const Cmd = createFileCommand({
      id: 'test.upload',
      name: 'Upload Folder',
      getFileTarget: () => [uri(local('a')), uri(local('b')), uri(local('c'))],
      handleFile: ctx => Promise.reject(byPath[(ctx as any).target.localFsPath]),
    });

    await new Cmd().run();

    expect((reportError as jest.Mock).mock.calls.map(call => call[0])).toEqual([first, second, denied]);
    // the first loss is shown; the second only reaches the log
    expect(isReported(first)).toBe(false);
    expect(isReported(second)).toBe(true);
    expect(isReported(denied)).toBe(false);
  });

  test('a multi-profile command runs its handler per profile of each outermost selection', async () => {
    const handleFile = jest.fn(async () => undefined);
    const app = uri(local('site', 'app'));
    const sub = uri(local('site', 'app', 'Modules'));
    const Cmd = createFileMultiCommand({
      id: 'test.uploadAll',
      name: 'Upload Folder To All Profiles',
      getFileTarget: () => [app, sub],
      handleFile,
    });

    await new Cmd().run();

    expect(handleFile.mock.calls.map(call => (call[0] as any).config.host)).toEqual(['one', 'two']);
  });

  test('a missing target cancels the command without an error', async () => {
    const handleFile = jest.fn(async () => undefined);
    const Cmd = createFileCommand({
      id: 'test.upload',
      name: 'Upload Folder',
      getFileTarget: () => undefined,
      handleFile,
    });

    await new Cmd().run();

    expect(handleFile).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});
