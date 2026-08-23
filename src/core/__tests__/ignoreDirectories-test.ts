jest.mock('fs');

import * as path from 'path';
import FileService from '../fileService';

/**
 * The ignore function a FileService builds is also what prunes directories
 * during a local scan. gitignore's `dir/` spelling — what an ignoreFile
 * almost always contains — only matches a path tested *as a directory*, so
 * the function takes that hint; without it `node_modules` was walked and its
 * files rejected one by one.
 */

const BASE_DIR = path.join('c:', 'project');

function ignoreFnFor(patterns: string[]) {
  const service = new FileService(BASE_DIR, BASE_DIR, {
    name: 'test',
    protocol: 'sftp',
    host: 'example.com',
    port: 22,
    username: 'user',
    remotePath: '/var/www',
    ignore: patterns,
  } as any);

  const ignore = service.getConfig().ignore;
  if (!ignore) {
    throw new Error('expected an ignore function to be built');
  }
  return (relativePath: string, isDirectory?: boolean) =>
    ignore(path.join(BASE_DIR, ...relativePath.split('/')), isDirectory);
}

describe('config.ignore and directories', () => {
  test('a trailing-slash pattern matches the directory only when flagged as one', () => {
    const ignores = ignoreFnFor(['node_modules/']);

    expect(ignores('node_modules', true)).toBe(true);
    // a *file* called node_modules is not what the pattern means
    expect(ignores('node_modules', false)).toBe(false);
    expect(ignores('node_modules')).toBe(false);
  });

  test('what lives under an ignored directory is ignored either way', () => {
    const ignores = ignoreFnFor(['node_modules/']);

    expect(ignores('node_modules/lib/x.js')).toBe(true);
    expect(ignores('node_modules/lib', true)).toBe(true);
  });

  test('a pattern without a slash keeps matching with and without the hint', () => {
    const ignores = ignoreFnFor(['dist']);

    expect(ignores('dist', true)).toBe(true);
    expect(ignores('dist')).toBe(true);
    expect(ignores('dist/bundle.js')).toBe(true);
  });

  test('the hint does not make an unrelated directory ignored', () => {
    const ignores = ignoreFnFor(['node_modules/', '*.log']);

    expect(ignores('src', true)).toBe(false);
    expect(ignores('src/deep', true)).toBe(false);
    expect(ignores('src/a.log')).toBe(true);
  });

  test('the root itself is never ignored', () => {
    const ignores = ignoreFnFor(['*']);

    expect(ignores('', true)).toBe(false);
    expect(ignores('')).toBe(false);
  });

  test('remote paths get the same treatment', () => {
    const service = new FileService(BASE_DIR, BASE_DIR, {
      name: 'test',
      protocol: 'sftp',
      host: 'example.com',
      port: 22,
      username: 'user',
      remotePath: '/var/www',
      ignore: ['cache/'],
    } as any);
    const ignore = service.getConfig().ignore!;

    expect(ignore('/var/www/cache', true)).toBe(true);
    expect(ignore('/var/www/cache')).toBe(false);
    expect(ignore('/var/www/cache/page.html')).toBe(true);
  });
});
