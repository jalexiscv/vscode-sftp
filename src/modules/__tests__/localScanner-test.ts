jest.mock('fs');

import { vol, fs as memfs } from 'memfs';
import * as path from 'path';
import { scanLocalTree, wouldLoop, PendingDir } from '../localScanner';

// absolute on both platforms; "c:/..." is a relative folder on linux
const root = path.resolve(path.sep, 'projects', 'site');
const at = (...segments: string[]) => path.join(root, ...segments);

function fillTree() {
  vol.fromJSON({
    [at('index.php')]: '<?php',
    [at('src', 'a.php')]: 'aa',
    [at('src', 'deep', 'b.php')]: 'bbb',
    [at('node_modules', 'lib', 'x.js')]: 'x',
    [at('node_modules', 'y.js')]: 'y',
    [at('.vscode', 'sftp.json')]: '{}',
  });
}

const names = (files: Array<{ fsPath: string }>) =>
  files.map(f => path.relative(root, f.fsPath).split(path.sep).join('/')).sort();

describe('scanLocalTree', () => {
  beforeEach(() => {
    vol.reset();
  });

  test('lists every file of the tree with size and mtime', async () => {
    fillTree();
    const when = new Date(1700000000000);
    memfs.utimesSync(at('src', 'deep', 'b.php'), when, when);

    const result = await scanLocalTree(root);

    expect(names(result.files)).toEqual([
      '.vscode/sftp.json',
      'index.php',
      'node_modules/lib/x.js',
      'node_modules/y.js',
      'src/a.php',
      'src/deep/b.php',
    ]);
    // root, src, src/deep, node_modules, node_modules/lib, .vscode
    expect(result.dirs).toBe(6);
    expect(result.cancelled).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const b = result.files.find(f => f.fsPath === at('src', 'deep', 'b.php'))!;
    expect(b.size).toBe(3);
    expect(b.mtime).toBe(1700000000000);
  });

  test('ignore prunes directories without reading them, and filters files', async () => {
    fillTree();
    const seen: string[] = [];
    const ignore = (fsPath: string) => {
      seen.push(fsPath);
      const rel = path.relative(root, fsPath).split(path.sep).join('/');
      return rel === 'node_modules' || rel === '.vscode/sftp.json';
    };

    const result = await scanLocalTree(root, { ignore });

    expect(names(result.files)).toEqual(['index.php', 'src/a.php', 'src/deep/b.php']);
    // nothing under node_modules was ever offered to ignore(): the subtree was
    // skipped, not listed and filtered
    expect(seen.some(p => p.indexOf(at('node_modules') + path.sep) === 0)).toBe(false);
    expect(result.dirs).toBe(4);
  });

  test('directories are offered to ignore() flagged as such, so "dir/" patterns prune', async () => {
    fillTree();
    const offered: Array<[string, boolean | undefined]> = [];
    // what config.ignore does with a `node_modules/` pattern: it only matches
    // when told the path is a directory
    const ignore = (fsPath: string, isDirectory?: boolean) => {
      offered.push([path.relative(root, fsPath).split(path.sep).join('/'), isDirectory]);
      return isDirectory === true && path.basename(fsPath) === 'node_modules';
    };

    const result = await scanLocalTree(root, { ignore });

    expect(names(result.files)).toEqual(['.vscode/sftp.json', 'index.php', 'src/a.php', 'src/deep/b.php']);
    // pruned, not read: root, src, src/deep, .vscode
    expect(result.dirs).toBe(4);
    expect(offered).toContainEqual(['node_modules', true]);
    expect(offered).toContainEqual(['index.php', false]);
    expect(offered.some(([rel]) => rel.indexOf('node_modules/') === 0)).toBe(false);
  });

  test('stops cooperatively when isCancelled turns true', async () => {
    fillTree();
    let progressCalls = 0;
    const result = await scanLocalTree(root, {
      concurrency: 1,
      onProgress: () => {
        progressCalls++;
      },
      isCancelled: () => progressCalls >= 1,
    });

    expect(result.cancelled).toBe(true);
    // the root was read; the rest was left alone
    expect(result.dirs).toBe(1);
    expect(result.files.length).toBeLessThan(6);
  });

  test('reports progress as directories are read', async () => {
    fillTree();
    const progress: Array<[number, number]> = [];
    await scanLocalTree(root, {
      onProgress: (files, dirs) => {
        progress.push([files, dirs]);
      },
    });

    expect(progress.length).toBe(6);
    expect(progress[progress.length - 1]).toEqual([6, 6]);
  });

  test('an unreadable directory is skipped, not fatal', async () => {
    fillTree();
    memfs.chmodSync(at('src', 'deep'), 0);

    const result = await scanLocalTree(root);

    expect(names(result.files)).toEqual([
      '.vscode/sftp.json',
      'index.php',
      'node_modules/lib/x.js',
      'node_modules/y.js',
      'src/a.php',
    ]);
    expect(result.cancelled).toBe(false);
  });

  test('a missing base dir yields an empty result', async () => {
    const result = await scanLocalTree(at('nowhere'));
    expect(result.files).toEqual([]);
    expect(result.dirs).toBe(0);
  });

  test('symlinks are neither listed nor followed by default', async () => {
    fillTree();
    memfs.symlinkSync(at('src'), at('link-to-src'));
    memfs.symlinkSync(at('index.php'), at('link-to-file'));

    const result = await scanLocalTree(root, { ignore: p => path.basename(p) === 'node_modules' });

    expect(names(result.files)).toEqual(['.vscode/sftp.json', 'index.php', 'src/a.php', 'src/deep/b.php']);
  });

  test('followSymlinks descends into linked directories and lists linked files', async () => {
    fillTree();
    memfs.symlinkSync(at('src'), at('link-to-src'));
    memfs.symlinkSync(at('index.php'), at('link-to-file'));
    memfs.symlinkSync(at('does-not-exist'), at('dangling'));

    const result = await scanLocalTree(root, {
      followSymlinks: true,
      ignore: p => path.basename(p) === 'node_modules',
    });

    expect(names(result.files)).toEqual([
      '.vscode/sftp.json',
      'index.php',
      'link-to-file',
      'link-to-src/a.php',
      'link-to-src/deep/b.php',
      'src/a.php',
      'src/deep/b.php',
    ]);
  });

  describe('followSymlinks and loops', () => {
    test('a link back to the scan root is not followed', async () => {
      fillTree();
      memfs.symlinkSync(root, at('src', 'deep', 'loop'));

      const result = await scanLocalTree(root, {
        followSymlinks: true,
        ignore: p => path.basename(p) === 'node_modules',
      });

      // every file once, nothing under the loop
      expect(names(result.files)).toEqual(['.vscode/sftp.json', 'index.php', 'src/a.php', 'src/deep/b.php']);
      expect(result.dirs).toBe(4);
    });

    test('a link to an ancestor of the scan root is not followed either', async () => {
      fillTree();
      memfs.symlinkSync(path.dirname(root), at('up'));

      const result = await scanLocalTree(root, {
        followSymlinks: true,
        ignore: p => path.basename(p) === 'node_modules',
      });

      expect(names(result.files)).toEqual(['.vscode/sftp.json', 'index.php', 'src/a.php', 'src/deep/b.php']);
    });

    test('two directories linking to each other terminate', async () => {
      vol.fromJSON({ [at('a', 'a.txt')]: 'a', [at('b', 'b.txt')]: 'b' });
      memfs.symlinkSync(at('b'), at('a', 'to-b'));
      memfs.symlinkSync(at('a'), at('b', 'to-a'));

      const result = await scanLocalTree(root, { followSymlinks: true });

      // each link is followed once: the way back is cut
      expect(names(result.files)).toEqual(['a/a.txt', 'a/to-b/b.txt', 'b/b.txt', 'b/to-a/a.txt']);
      expect(result.dirs).toBe(5);
    });

    test('a link to a sibling is still followed (the target is not on the way here)', async () => {
      vol.fromJSON({ [at('a', 'a.txt')]: 'a', [at('b', 'b.txt')]: 'b' });
      memfs.symlinkSync(at('b'), at('a', 'to-b'));

      const result = await scanLocalTree(root, { followSymlinks: true });

      expect(names(result.files)).toEqual(['a/a.txt', 'a/to-b/b.txt', 'b/b.txt']);
    });

    test('wouldLoop: the decision on its own', () => {
      const rootNode: PendingDir = { dir: root, real: root, parent: null };
      const src: PendingDir = { dir: at('src'), real: at('src'), parent: rootNode };
      const deep: PendingDir = { dir: at('src', 'deep'), real: at('src', 'deep'), parent: src };

      expect(wouldLoop(root, deep)).toBe(true);
      expect(wouldLoop(at('src'), deep)).toBe(true);
      expect(wouldLoop(path.dirname(root), deep)).toBe(true);
      expect(wouldLoop(at('src', 'deep'), deep)).toBe(true);
      // a sibling, a cousin, or a name that merely starts the same
      expect(wouldLoop(at('other'), deep)).toBe(false);
      expect(wouldLoop(at('src', 'other'), deep)).toBe(false);
      expect(wouldLoop(at('src', 'deeper'), deep)).toBe(false);
      expect(wouldLoop(root + '-other', deep)).toBe(false);
    });
  });

  test('honours the concurrency bound', async () => {
    // a wide tree: many sibling directories, each with a file
    const tree: { [p: string]: string } = {};
    for (let i = 0; i < 40; i++) {
      tree[at(`dir-${i}`, 'f.txt')] = String(i);
    }
    vol.fromJSON(tree);

    const result = await scanLocalTree(root, { concurrency: 3 });
    expect(result.files).toHaveLength(40);
    expect(result.dirs).toBe(41);
  });
});
