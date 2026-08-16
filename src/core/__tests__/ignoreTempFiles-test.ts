jest.mock('fs');

import * as path from 'path';
import FileService from '../fileService';

/**
 * End-to-end check of the exclusion rules a FileService actually applies.
 *
 * tempFiles-test covers the pattern list in isolation; this covers the part
 * that can silently regress — the gitignore matching, the path normalisation
 * and the ordering between built-in and user patterns.
 */

const BASE_DIR = path.join('c:', 'project');
const WORKSPACE = BASE_DIR;

function ignoreFnFor(extra: any = {}) {
  const service = new FileService(BASE_DIR, WORKSPACE, {
    name: 'test',
    protocol: 'sftp',
    host: 'example.com',
    port: 22,
    username: 'user',
    remotePath: '/var/www',
    ignore: [],
    ...extra,
  } as any);

  const config = service.getConfig();
  return (relativePath: string) => {
    const ignore = config.ignore;
    if (!ignore) {
      throw new Error('expected an ignore function to be built');
    }
    return ignore(path.join(BASE_DIR, ...relativePath.split('/')));
  };
}

describe('temp file exclusion', () => {
  describe('with the defaults', () => {
    const ignores = ignoreFnFor();

    const shouldIgnore = [
      'foo.tmp',
      'foo.tmp.php',
      'session.tmp1234',
      'notes.temp',
      'upload.new',
      'main.swp',
      '.main.swp',
      'index.php~',
      '.#index.php',
      '#index.php#',
      '~$budget.docx',
      'merge.orig',
      'merge.rej',
      'config.bak',
      'movie.crdownload',
      'archive.part',
      'archive.partial',
      'file.download',
      '.DS_Store',
      '._resourcefork',
      'Thumbs.db',
      'ehthumbs.db',
      'desktop.ini',
      'src/deep/nested/thing.swp',
    ];

    shouldIgnore.forEach(file => {
      test(`ignores ${file}`, () => {
        expect(ignores(file)).toBe(true);
      });
    });

    const shouldTransfer = [
      'index.php',
      'README.md',
      'src/app.ts',
      'assets/logo.png',
      'deep/nested/module.js',
      // a real dependency lockfile: "*.lock" must never be in the list
      'composer.lock',
      'yarn.lock',
      // near-misses of the temp patterns
      'template.php',
      'newsletter.html',
      'partial.php',
      'temperature.js',
      // template extensions that start with "tmp": the old `*.tmp*` pattern
      // matched these and skipped them silently
      'templates/header.tmpl',
      'chart.tmpx',
    ];

    shouldTransfer.forEach(file => {
      test(`transfers ${file}`, () => {
        expect(ignores(file)).toBe(false);
      });
    });

    test('never uploads the config file, it holds credentials', () => {
      expect(ignores('.vscode/sftp.json')).toBe(true);
    });

    test('excludes the remote trash folder from traversals', () => {
      expect(ignores('.sftp-trash')).toBe(true);
      expect(ignores('.sftp-trash/20260816-120000/index.php')).toBe(true);
    });
  });

  describe('with ignoreTempFiles disabled', () => {
    const ignores = ignoreFnFor({ ignoreTempFiles: false });

    test('stops excluding temp files', () => {
      expect(ignores('foo.tmp')).toBe(false);
      expect(ignores('main.swp')).toBe(false);
      expect(ignores('.DS_Store')).toBe(false);
    });

    test('still refuses to upload the config file', () => {
      // credential protection is not something the user can switch off
      expect(ignores('.vscode/sftp.json')).toBe(true);
    });
  });

  describe('with extra patterns', () => {
    test('tempFilePatterns adds to the built-in list', () => {
      const ignores = ignoreFnFor({ tempFilePatterns: ['*.generated.php'] });
      expect(ignores('view.generated.php')).toBe(true);
      // the built-ins are still in effect
      expect(ignores('foo.tmp')).toBe(true);
    });

    test('a negation lets one built-in pattern back through', () => {
      // patterns are appended after the defaults, so a later "!" wins
      const ignores = ignoreFnFor({ tempFilePatterns: ['!*.bak'] });
      expect(ignores('config.bak')).toBe(false);
      expect(ignores('config.orig')).toBe(true);
    });

    test('user ignore patterns still apply', () => {
      const ignores = ignoreFnFor({ ignore: ['node_modules', '/dist'] });
      expect(ignores('node_modules/lib/index.js')).toBe(true);
      expect(ignores('dist/bundle.js')).toBe(true);
      expect(ignores('src/dist/keep.js')).toBe(false);
    });
  });

  describe('with a relocated trash', () => {
    test('an absolute trash path needs no ignore pattern', () => {
      const ignores = ignoreFnFor({
        remoteTrash: { enabled: true, path: '/var/tmp/sftp-trash', retentionDays: 7 },
      });
      // it lives outside remotePath, so nothing inside the project matches
      expect(ignores('.sftp-trash')).toBe(false);
    });

    test('a disabled trash adds no pattern', () => {
      const ignores = ignoreFnFor({ remoteTrash: { enabled: false } });
      expect(ignores('.sftp-trash')).toBe(false);
    });

    test('a custom relative trash is excluded under its own name', () => {
      const ignores = ignoreFnFor({ remoteTrash: { enabled: true, path: '.papelera' } });
      expect(ignores('.papelera/algo.php')).toBe(true);
      expect(ignores('.sftp-trash')).toBe(false);
    });
  });

  test('the service root itself is never ignored', () => {
    const service = new FileService(BASE_DIR, WORKSPACE, {
      name: 'test',
      protocol: 'sftp',
      host: 'example.com',
      username: 'user',
      remotePath: '/var/www',
      ignore: ['*'],
    } as any);

    const ignore = service.getConfig().ignore!;
    expect(ignore(BASE_DIR)).toBe(false);
  });
});
