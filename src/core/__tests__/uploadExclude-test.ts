jest.mock('fs');

import * as path from 'path';
import FileService, { uploadIgnoreOf, isExcludedFromMirroring, ServiceConfig } from '../fileService';

/**
 * `uploadExclude` is a second pattern list next to `ignore`, with a matcher
 * of its own: the paths that go local → remote consult both, everything else
 * (downloads, listings) only `ignore`. These cases pin the matcher, the helper
 * that combines the two and the profile merge.
 */

const BASE_DIR = path.join('c:', 'project');

function serviceWith(config: object) {
  return new FileService(BASE_DIR, BASE_DIR, {
    name: 'test',
    protocol: 'sftp',
    host: 'example.com',
    port: 22,
    username: 'user',
    remotePath: '/var/www',
    ...config,
  } as any);
}

const local = (...segments: string[]) => path.join(BASE_DIR, ...segments);

describe('config.uploadExclude', () => {
  test('is null when absent or empty, so nothing consults it', () => {
    expect(serviceWith({}).getConfig().uploadExclude).toBeNull();
    expect(serviceWith({ uploadExclude: [] }).getConfig().uploadExclude).toBeNull();
  });

  test('builds a matcher with gitignore semantics, independent of ignore', () => {
    const config = serviceWith({
      ignore: ['*.log'],
      uploadExclude: ['/storage', 'uploads/'],
    }).getConfig();
    const excluded = config.uploadExclude!;
    const ignore = config.ignore!;

    expect(excluded(local('storage'), true)).toBe(true);
    expect(excluded(local('storage', 'logs', 'app.log'))).toBe(true);
    expect(excluded(local('public', 'uploads'), true)).toBe(true);
    expect(excluded(local('public', 'uploads', 'photo.jpg'))).toBe(true);
    // an anchored pattern does not match deeper; a `dir/` one needs a directory
    expect(excluded(local('app', 'storage'), true)).toBe(false);
    expect(excluded(local('public', 'uploads'))).toBe(false);
    expect(excluded(local('src', 'a.log'))).toBe(false);
    // and ignore knows nothing about the other list
    expect(ignore(local('storage'), true)).toBe(false);
    expect(ignore(local('src', 'a.log'))).toBe(true);
  });

  test('matches the remote side of a transfer too', () => {
    const excluded = serviceWith({ uploadExclude: ['/storage'] }).getConfig().uploadExclude!;

    expect(excluded('/var/www/storage', true)).toBe(true);
    expect(excluded('/var/www/storage/app.log')).toBe(true);
    expect(excluded('/var/www/src/app.php')).toBe(false);
  });

  test('the root itself is never excluded', () => {
    const excluded = serviceWith({ uploadExclude: ['*'] }).getConfig().uploadExclude!;

    expect(excluded(BASE_DIR, true)).toBe(false);
    expect(excluded('/var/www', true)).toBe(false);
  });

  test('a profile adds to the base list instead of replacing it', () => {
    const service = serviceWith({
      uploadExclude: ['/storage'],
      profiles: { prod: { host: 'prod.example.com', uploadExclude: ['/cache'] } },
    });
    const excluded = service.getConfig('prod').uploadExclude!;

    expect(excluded(local('storage'), true)).toBe(true);
    expect(excluded(local('cache'), true)).toBe(true);
    expect(excluded(local('src'), true)).toBe(false);
  });
});

describe('uploadIgnoreOf', () => {
  const matcher = (name: string) => (fsPath: string) => path.basename(fsPath) === name;
  const asConfig = (partial: Partial<ServiceConfig>) => partial as ServiceConfig;

  test('is null when neither list is configured', () => {
    expect(uploadIgnoreOf(asConfig({ ignore: null, uploadExclude: null }))).toBeNull();
    expect(uploadIgnoreOf(asConfig({}))).toBeNull();
  });

  test('hands back the one matcher that exists', () => {
    const ignore = matcher('a');
    const excluded = matcher('b');

    expect(uploadIgnoreOf(asConfig({ ignore, uploadExclude: null }))).toBe(ignore);
    expect(uploadIgnoreOf(asConfig({ ignore: null, uploadExclude: excluded }))).toBe(excluded);
  });

  test('combines both with or', () => {
    const combined = uploadIgnoreOf(
      asConfig({ ignore: matcher('a'), uploadExclude: matcher('b') })
    )!;

    expect(combined('/x/a')).toBe(true);
    expect(combined('/x/b')).toBe(true);
    expect(combined('/x/c')).toBe(false);
  });

  test('forwards the directory hint to both', () => {
    const ignore = jest.fn(() => false);
    const excluded = jest.fn(() => false);

    uploadIgnoreOf(asConfig({ ignore, uploadExclude: excluded }))!('/x/d', true);

    expect(ignore).toHaveBeenCalledWith('/x/d', true);
    expect(excluded).toHaveBeenCalledWith('/x/d', true);
  });
});

describe('isExcludedFromMirroring', () => {
  test('keeps a deleted path whose `dir/` pattern only matches as a directory', () => {
    const config = serviceWith({ uploadExclude: ['uploads/'] }).getConfig();

    // gone from disk, so it cannot be told from a file: tested both ways
    expect(isExcludedFromMirroring(config, local('public', 'uploads'))).toBe(true);
    expect(isExcludedFromMirroring(config, local('public', 'uploads', 'photo.jpg'))).toBe(true);
    expect(isExcludedFromMirroring(config, local('public', 'index.html'))).toBe(false);
  });

  test('honours ignore as well', () => {
    const config = serviceWith({ ignore: ['node_modules/'] }).getConfig();

    expect(isExcludedFromMirroring(config, local('node_modules'))).toBe(true);
    expect(isExcludedFromMirroring(config, local('src'))).toBe(false);
  });

  test('is false with nothing configured', () => {
    expect(isExcludedFromMirroring(serviceWith({}).getConfig(), local('a.txt'))).toBe(false);
  });
});
