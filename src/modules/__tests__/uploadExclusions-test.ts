jest.mock('fs');
// a real Uri class: the context key carries Uri.file(...).fsPath
jest.mock('vscode', () => require('../../../test/helper/vscodeMock').createVscodeMock());
// the real registry for getBasePath (the entry of sftp.json is matched with
// it); the list of services is what the test says it is
jest.mock('../serviceManager', () => ({
  ...jest.requireActual('../serviceManager'),
  getAllFileService: jest.fn(() => []),
}));
jest.mock('../../host', () => ({
  ...jest.requireActual('../../host'),
  setContextValue: jest.fn(),
}));

import * as path from 'path';
import { vol } from 'memfs';
import app from '../../app';
import { CONFIG_PATH } from '../../constants';
import { setContextValue } from '../../host';
import { getAllFileService, getBasePath } from '../serviceManager';
import {
  CONTEXT_KEY,
  patternForPath,
  pathForPattern,
  listExclusions,
  addExclusions,
  removeExclusion,
  excludePath,
  excludedPaths,
  refreshContext,
} from '../uploadExclusions';

/**
 * The uploadExclude list edited from the UI: a local path becomes an anchored
 * pattern and back, the list is rewritten in sftp.json without disturbing the
 * rest of the file, and the excluded paths reach the context key the
 * explorer menus test.
 */

const setContextValueMock = setContextValue as jest.Mock;
const getAllFileServiceMock = getAllFileService as jest.Mock;

const workspace = path.resolve(path.sep, 'ws');
const configPath = path.join(workspace, CONFIG_PATH);

function fakeService(context?: string, name = 'staging') {
  return {
    name,
    workspace,
    baseDir: getBasePath(context as any, workspace),
  } as any;
}

function writeConfig(config: any, indent: string | number = 2, trailingNewline = true) {
  vol.mkdirSync(path.dirname(configPath), { recursive: true });
  vol.writeFileSync(configPath, JSON.stringify(config, null, indent) + (trailingNewline ? '\n' : ''));
}

function readConfigText(): string {
  return vol.readFileSync(configPath, 'utf8') as string;
}

function readConfig(): any {
  return JSON.parse(readConfigText());
}

beforeEach(() => {
  vol.reset();
  setContextValueMock.mockClear();
  getAllFileServiceMock.mockReset();
  getAllFileServiceMock.mockImplementation(() => []);
  app.state.profile = null;
});

describe('patternForPath / pathForPattern', () => {
  const service = fakeService();
  const base = service.baseDir;

  test('a path inside the base dir becomes an anchored pattern with unix separators', () => {
    expect(patternForPath(service, path.join(base, 'storage'))).toBe('/storage');
    expect(patternForPath(service, path.join(base, 'public', 'uploads'))).toBe('/public/uploads');
    expect(patternForPath(service, path.join(base, 'public', 'uploads') + path.sep)).toBe(
      '/public/uploads'
    );
    expect(patternForPath(service, path.join(base, '.env'))).toBe('/.env');
  });

  test('the base dir itself and anything outside it have no pattern', () => {
    expect(patternForPath(service, base)).toBeNull();
    expect(patternForPath(service, base + path.sep)).toBeNull();
    expect(patternForPath(service, path.resolve(path.sep, 'elsewhere', 'x'))).toBeNull();
    expect(patternForPath(service, path.dirname(base))).toBeNull();
  });

  test('a plain anchored pattern maps back to its local path; anything else does not', () => {
    expect(pathForPattern(service, '/storage')).toBe(path.join(base, 'storage'));
    expect(pathForPattern(service, '/public/uploads/')).toBe(path.join(base, 'public', 'uploads'));
    expect(pathForPattern(service, '/.env')).toBe(path.join(base, '.env'));
    // wildcards, negation, unanchored, traversal, empty
    expect(pathForPattern(service, '*.env')).toBeNull();
    expect(pathForPattern(service, '/logs/*.log')).toBeNull();
    expect(pathForPattern(service, 'cache/')).toBeNull();
    expect(pathForPattern(service, '/!keep')).toBeNull();
    expect(pathForPattern(service, '/a/../b')).toBeNull();
    expect(pathForPattern(service, '/')).toBeNull();
    expect(pathForPattern(service, '')).toBeNull();
  });

  test('a service with a context folder anchors to that folder', () => {
    const nested = fakeService('site');
    expect(patternForPath(nested, path.join(nested.baseDir, 'storage'))).toBe('/storage');
    // a sibling of the context is outside
    expect(patternForPath(nested, path.join(workspace, 'other'))).toBeNull();
    expect(pathForPattern(nested, '/storage')).toBe(path.join(nested.baseDir, 'storage'));
  });
});

describe('addExclusions / removeExclusion / listExclusions', () => {
  test('adds to the base list, keeps the indentation and the trailing newline, dedups', async () => {
    writeConfig({ name: 'staging', host: 'h', username: 'u', remotePath: '/', ignore: ['.git'] }, 2);
    const service = fakeService();

    const first = await addExclusions(service, ['/storage', ' /public/uploads ', '', '/storage']);

    expect(first).toEqual([
      { pattern: '/storage', outcome: 'added' },
      { pattern: '/public/uploads', outcome: 'added' },
      { pattern: '/storage', outcome: 'exists' },
    ]);
    const text = readConfigText();
    expect(readConfig()).toEqual({
      name: 'staging',
      host: 'h',
      username: 'u',
      remotePath: '/',
      ignore: ['.git'],
      uploadExclude: ['/storage', '/public/uploads'],
    });
    expect(text).toMatch(/^  "name"/m);
    expect(text).not.toMatch(/^    "name"/m);
    expect(text.endsWith('\n')).toBe(true);
    // the context key was refreshed from the write
    expect(setContextValueMock).toHaveBeenCalledWith(CONTEXT_KEY, expect.any(Array));

    // nothing new: the file is not rewritten (a compact copy stays compact)
    const compact = JSON.stringify(readConfig());
    vol.writeFileSync(configPath, compact);
    expect(await addExclusions(service, ['/storage'])).toEqual([{ pattern: '/storage', outcome: 'exists' }]);
    expect(readConfigText()).toBe(compact);
  });

  test('a file without a trailing newline and with four-space indentation stays that way', async () => {
    writeConfig({ host: 'h', username: 'u', remotePath: '/' }, 4, false);
    const service = fakeService();

    await addExclusions(service, ['/cache']);

    const text = readConfigText();
    expect(text).toMatch(/^    "host"/m);
    expect(text.endsWith('\n')).toBe(false);
    expect(readConfig().uploadExclude).toEqual(['/cache']);
  });

  test('an array config: the entry whose context matches the service is the one edited', async () => {
    writeConfig([
      { name: 'front', context: 'front', host: 'h', username: 'u', remotePath: '/f' },
      { name: 'api', context: 'api', host: 'h', username: 'u', remotePath: '/a', uploadExclude: ['/vendor'] },
    ]);
    const api = fakeService('api', 'api');

    await addExclusions(api, ['/storage']);
    expect(await listExclusions(api)).toEqual([
      { pattern: '/vendor', source: 'base', localPath: path.join(api.baseDir, 'vendor') },
      { pattern: '/storage', source: 'base', localPath: path.join(api.baseDir, 'storage') },
    ]);

    const saved = readConfig();
    expect(saved[0].uploadExclude).toBeUndefined();
    expect(saved[1].uploadExclude).toEqual(['/vendor', '/storage']);

    // a service no entry matches
    await expect(listExclusions(fakeService('nowhere'))).rejects.toThrow(/no entry/);
  });

  test('the active profile\'s own list is listed as inherited and never edited', async () => {
    writeConfig({
      host: 'h',
      username: 'u',
      remotePath: '/',
      uploadExclude: ['/storage'],
      profiles: { prod: { host: 'p', uploadExclude: ['/logs', '*.tmp'] }, dev: { host: 'd' } },
    });
    const service = fakeService();
    app.state.profile = 'prod';

    expect(await listExclusions(service)).toEqual([
      { pattern: '/storage', source: 'base', localPath: path.join(service.baseDir, 'storage') },
      { pattern: '/logs', source: 'profile', profile: 'prod', localPath: path.join(service.baseDir, 'logs') },
      { pattern: '*.tmp', source: 'profile', profile: 'prod' },
    ]);

    // already in force through the profile: not added to the base
    expect(await addExclusions(service, ['/logs'])).toEqual([{ pattern: '/logs', outcome: 'exists' }]);
    expect(readConfig().uploadExclude).toEqual(['/storage']);
    // and not removable from here
    expect(await removeExclusion(service, '/logs')).toBe(false);
    expect(readConfig().profiles.prod.uploadExclude).toEqual(['/logs', '*.tmp']);

    // another profile: the base only
    app.state.profile = 'dev';
    expect((await listExclusions(service)).map(entry => entry.pattern)).toEqual(['/storage']);
  });

  test('removes a pattern, drops the key when the list empties, false when absent', async () => {
    writeConfig({ host: 'h', username: 'u', remotePath: '/', uploadExclude: ['/a', '/b'] });
    const service = fakeService();

    expect(await removeExclusion(service, '/a')).toBe(true);
    expect(readConfig().uploadExclude).toEqual(['/b']);
    expect(await removeExclusion(service, '/a')).toBe(false);
    expect(await removeExclusion(service, '/b')).toBe(true);
    expect(readConfig().uploadExclude).toBeUndefined();
    expect(readConfig().host).toBe('h');
  });

  test('excludePath: a path outside the base dir is reported, not written', async () => {
    writeConfig({ host: 'h', username: 'u', remotePath: '/' });
    const service = fakeService();

    expect(await excludePath(service, service.baseDir)).toEqual({ pattern: service.baseDir, outcome: 'outside' });
    expect(readConfig().uploadExclude).toBeUndefined();
    expect(await excludePath(service, path.join(service.baseDir, 'storage'))).toEqual({
      pattern: '/storage',
      outcome: 'added',
    });
    expect(readConfig().uploadExclude).toEqual(['/storage']);
  });

  test('a missing or unparsable sftp.json rejects', async () => {
    const service = fakeService();
    await expect(addExclusions(service, ['/x'])).rejects.toBeDefined();
    vol.mkdirSync(path.dirname(configPath), { recursive: true });
    vol.writeFileSync(configPath, '{ not json');
    await expect(listExclusions(service)).rejects.toBeDefined();
  });
});

describe('excludedPaths / refreshContext', () => {
  test('publishes the local paths of the plain anchored patterns of every service', async () => {
    writeConfig([
      { context: 'front', host: 'h', username: 'u', remotePath: '/', uploadExclude: ['/dist', '*.map'] },
      { context: 'api', host: 'h', username: 'u', remotePath: '/', uploadExclude: ['/storage/'] },
    ]);
    const front = fakeService('front', 'front');
    const api = fakeService('api', 'api');
    getAllFileServiceMock.mockImplementation(() => [front, api]);

    expect(await excludedPaths()).toEqual([
      path.join(front.baseDir, 'dist'),
      path.join(api.baseDir, 'storage'),
    ]);

    await refreshContext();
    expect(setContextValueMock).toHaveBeenCalledWith(CONTEXT_KEY, [
      path.join(front.baseDir, 'dist'),
      path.join(api.baseDir, 'storage'),
    ]);
  });

  test('a service whose config cannot be read contributes nothing and never throws', async () => {
    writeConfig({ context: 'api', host: 'h', username: 'u', remotePath: '/', uploadExclude: ['/x'] });
    const api = fakeService('api', 'api');
    const broken = fakeService('nowhere', 'broken');
    getAllFileServiceMock.mockImplementation(() => [broken, api]);

    await refreshContext();
    expect(setContextValueMock).toHaveBeenCalledWith(CONTEXT_KEY, [path.join(api.baseDir, 'x')]);

    vol.reset();
    await expect(refreshContext()).resolves.toBeUndefined();
    expect(setContextValueMock).toHaveBeenLastCalledWith(CONTEXT_KEY, []);
  });
});
