jest.mock('fs');

import { vol } from 'memfs';
import * as fs from 'fs';
import * as path from 'path';
import { sync, transfer, TransferDirection } from '../transfer';
import localFs from '../../../core/localFs';
import TransferTask from '../../../core/transferTask';
import RemoteFs from '../../../../test/helper/localRemoteFs';

declare global {
  interface Array<T> {
    formatSep(): Array<T>;
  }
}

Array.prototype.formatSep = function() {
  return this.map(str => str.replace(/\//g, path.sep))
}

function createRemoteFs({ remoteTimeOffsetInHours = 0 } = {}) {
  return new RemoteFs(path, {
    clientOption: {} as any,
    remoteTimeOffsetInHours,
  });
}

async function runTasks(tasks: TransferTask[]) {
  return Promise.all(
    tasks.map(async task => {
      try {
        await task.run();
      } catch (error) {
        console.log('run task fail', error);
      }
    })
  );
}

const file = (c, time = 0) => ({
  $$type: 'file',
  content: c,
  mtime: new Date(new Date().getTime() + time * 1000),
});

const fillFs = obj => {
  const files: { [x: string]: string } = {};
  const dirs: string[] = [];
  const stats: {
    [x: string]: {
      mtime: Date;
    };
  } = {};
  const processDirTree = (obj1, filepath = '/') => {
    const keys = Object.keys(obj1);
    if (keys.length <= 0) {
      dirs.push(filepath);
      return;
    }

    keys.forEach(key => {
      const fullpath = path.join(filepath, key);
      if (obj1[key].$$type === 'file') {
        files[fullpath] = obj1[key].content;
        stats[fullpath] = obj1[key];
      } else {
        processDirTree(obj1[key], fullpath);
      }
    });
  };
  processDirTree(obj);
  vol.fromJSON(files, '/');
  dirs.forEach(dir => fs.mkdirSync(dir));
  Object.keys(stats).forEach(filepath => {
    fs.utimesSync(filepath, stats[filepath].mtime, stats[filepath].mtime);
  });
};
const mapList = (list: any[], key: string) => list.map(t => t[key]);

// what ServiceConfig.ignore does with a gitignore `node_modules/` pattern:
// the trailing slash only matches when the caller says the path is a
// directory, and the subtree below never gets asked
function ignoreDirOnly(root: string, name: string) {
  return jest.fn((fsPath: string, isDirectory?: boolean) => {
    const relative = path.relative(root, fsPath).split(path.sep).join('/');
    const candidates = isDirectory ? [relative, relative + '/'] : [relative];
    return candidates.includes(name + '/');
  });
}

describe('transfer algorithm', () => {
  describe('ignore', () => {
    afterEach(() => {
      vol.reset();
    });

    test('transfer prunes a directory that ignore only matches with a trailing slash', async () => {
      fillFs({
        local: {
          a: file('a'),
          node_modules: {
            x: file('x'),
          },
          src: {
            b: file('b'),
          },
        },
        remote: {},
      });
      const ignore = ignoreDirOnly('/local', 'node_modules');
      const task: TransferTask[] = [];

      await transfer(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            perserveTargetMode: false,
            ignore,
          },
        },
        t => task.push(t)
      );

      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        ['/remote/a', '/remote/src/b'].formatSep().sort()
      );
      // the directory was offered as such, and nothing below it was listed
      expect(ignore).toHaveBeenCalledWith(path.join('/local', 'node_modules'), true);
      expect(ignore.mock.calls.map(call => call[0])).not.toContain(path.join('/local/node_modules', 'x'));
      expect(fs.existsSync(path.join('/remote', 'node_modules'))).toBe(false);
    });

    test('sync --delete keeps a target directory that ignore only matches with a trailing slash', async () => {
      fillFs({
        local: {
          a: file('a', 1),
        },
        remote: {
          a: file('$a'),
          node_modules: {
            y: file('$y'),
          },
          stale: file('$stale'),
        },
      });
      const ignore = ignoreDirOnly('/remote', 'node_modules');
      const task: TransferTask[] = [];

      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            delete: true,
            perserveTargetMode: false,
            ignore,
          },
        },
        t => task.push(t)
      );

      expect(mapList(deleted, 'fspath')).toEqual(['/remote/stale'].formatSep());
      expect(ignore).toHaveBeenCalledWith(path.join('/remote', 'node_modules'), true);
      expect(fs.existsSync(path.join('/remote/node_modules', 'y'))).toBe(true);
      expect(fs.existsSync(path.join('/remote', 'stale'))).toBe(false);
    });
  });

  // ServiceConfig.uploadExclude applies to the local → remote direction only:
  // the same option must prune an upload and leave a download untouched
  describe('uploadExclude', () => {
    afterEach(() => {
      vol.reset();
    });

    // what a `/storage` + `*.env` list resolves to, on either side of the transfer
    const excludePaths = (...names: string[]) =>
      jest.fn((fsPath: string, _isDirectory?: boolean) =>
        fsPath.split(/[\\/]/).some(segment => names.indexOf(segment) !== -1)
      );

    test('an upload skips the excluded directory and file, without ignore', async () => {
      fillFs({
        local: {
          a: file('a'),
          storage: {
            logs: {
              x: file('x'),
            },
          },
          '.env': file('secret'),
          src: {
            b: file('b'),
          },
        },
        remote: {},
      });
      const uploadExclude = excludePaths('storage', '.env');
      const task: TransferTask[] = [];

      await transfer(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            perserveTargetMode: false,
            ignore: null,
            uploadExclude,
          },
        },
        t => task.push(t)
      );

      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        ['/remote/a', '/remote/src/b'].formatSep().sort()
      );
      // pruned as a directory, so nothing below it was listed
      expect(uploadExclude).toHaveBeenCalledWith(path.join('/local', 'storage'), true);
      expect(uploadExclude.mock.calls.map(call => call[0])).not.toContain(
        path.join('/local/storage', 'logs')
      );
      expect(fs.existsSync(path.join('/remote', 'storage'))).toBe(false);
    });

    test('a download with the same option transfers everything', async () => {
      fillFs({
        remote: {
          a: file('a'),
          storage: {
            x: file('x'),
          },
          '.env': file('secret'),
        },
        local: {},
      });
      const task: TransferTask[] = [];

      await transfer(
        {
          srcFsPath: '/remote',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/local',
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
          transferOption: {
            perserveTargetMode: false,
            ignore: null,
            uploadExclude: excludePaths('storage', '.env'),
          },
        },
        t => task.push(t)
      );

      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        ['/local/a', '/local/storage/x', '/local/.env'].formatSep().sort()
      );
    });

    test('sync --delete neither writes into nor deletes from an excluded remote path', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          storage: {
            'local-only': file('l'),
          },
        },
        remote: {
          a: file('$a'),
          storage: {
            'uploaded-by-users': file('u'),
          },
          '.env': file('production'),
          stale: file('$stale'),
        },
      });
      const task: TransferTask[] = [];

      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            delete: true,
            perserveTargetMode: false,
            ignore: null,
            uploadExclude: excludePaths('storage', '.env'),
          },
        },
        t => task.push(t)
      );

      expect(mapList(task, 'targetFsPath')).toEqual(['/remote/a'].formatSep());
      expect(mapList(deleted, 'fspath')).toEqual(['/remote/stale'].formatSep());
      expect(fs.existsSync(path.join('/remote/storage', 'uploaded-by-users'))).toBe(true);
      expect(fs.existsSync(path.join('/remote/storage', 'local-only'))).toBe(false);
      expect(fs.existsSync(path.join('/remote', '.env'))).toBe(true);
      expect(fs.existsSync(path.join('/remote', 'stale'))).toBe(false);
    });

    test('sync remote → local --delete is not restricted by it', async () => {
      fillFs({
        remote: {
          a: file('a', 1),
          storage: {
            u: file('u', 1),
          },
        },
        local: {
          a: file('$a'),
          storage: {
            l: file('l'),
          },
        },
      });
      const task: TransferTask[] = [];

      const deleted = await sync(
        {
          srcFsPath: '/remote',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/local',
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
          transferOption: {
            delete: true,
            perserveTargetMode: false,
            ignore: null,
            uploadExclude: excludePaths('storage'),
          },
        },
        t => task.push(t)
      );

      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        ['/local/a', '/local/storage/u'].formatSep().sort()
      );
      expect(mapList(deleted, 'fspath')).toEqual(['/local/storage/l'].formatSep());
    });

    test('sync both directions skips an excluded directory whole', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          storage: {
            l: file('l'),
          },
        },
        remote: {
          a: file('$a'),
          storage: {
            u: file('u', 5),
          },
        },
      });
      const task: TransferTask[] = [];

      await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            bothDiretions: true,
            perserveTargetMode: false,
            ignore: null,
            uploadExclude: excludePaths('storage'),
          },
        },
        t => task.push(t)
      );

      // neither the local file goes up nor the newer remote one comes down
      expect(mapList(task, 'targetFsPath')).toEqual(['/remote/a'].formatSep());
    });
  });

  describe('sync', () => {
    afterEach(() => {
      vol.reset();
    });

    test('sync', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          $da: file('$da'),
          $db: {},
          c: {
            'c-a': file('$c-a'),
            $dc: file('$dc'),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(6);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/remote/b',
          '/remote/c/c-a',
          '/remote/c/c-b',
          '/remote/c/d/d-a',
          '/remote/c/d/d-b',
        ].formatSep().sort()
      );
    });

    test('sync --delete', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          $da: file('$da'),
          $db: {},
          c: {
            'c-a': file('$c-a'),
            $dc: file('$dc'),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            delete: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(6);
      expect(deleted.length).toEqual(3);
      expect(mapList(deleted, 'fspath').sort()).toEqual(
        ['/remote/$da', '/remote/$db', '/remote/c/$dc'].formatSep().sort()
      );
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/remote/b',
          '/remote/c/c-a',
          '/remote/c/c-b',
          '/remote/c/d/d-a',
          '/remote/c/d/d-b',
        ].formatSep().sort()
      );
    });

    test('sync --update', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          $da: file('$da'),
          $db: {},
          c: {
            'c-a': file('$c-a'),
            $dc: file('$dc'),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            delete: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(6);
      expect(deleted.length).toEqual(3);
      expect(mapList(deleted, 'fspath').sort()).toEqual(
        ['/remote/$da', '/remote/$db', '/remote/c/$dc'].formatSep().sort()
      );
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/remote/b',
          '/remote/c/c-a',
          '/remote/c/c-b',
          '/remote/c/d/d-a',
          '/remote/c/d/d-b',
        ].formatSep().sort()
      );
    });

    test('sync --update with time offset', async () => {
      const remoteFs = createRemoteFs({ remoteTimeOffsetInHours: 6 });
      fillFs({
        local: {
          a: file('a', 1),
        },
        remote: {
          a: file('$a'),
        },
      });
      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      let deleted;
      const runSync = async () => {
        deleted = await sync(
          {
            srcFsPath: '/local',
            srcFs: localFs,
            targetFs: remoteFs,
            targetFsPath: '/remote',
            transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            transferOption: {
              skipCreate: true,
              delete: false,
              perserveTargetMode: false,
            },
          },
          collect
        );
        await runTasks(task);
      };
      await runSync();
      expect(task.length).toEqual(1);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        ['/remote/a'].formatSep().sort()
      );
      task.length = 0;
      deleted.length = 0;
      await runSync();
      expect(task.length).toEqual(0);
      expect(deleted.length).toEqual(0);
    });

    test('sync --skipDelete', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          c: {
            'c-a': file('$c-a'),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            skipCreate: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(3);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        ['/remote/a', '/remote/c/c-a', '/remote/c/d/d-a'].formatSep().sort()
      );
    });

    test('sync --update', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a', 2),
          c: {
            'c-a': file('$c-a', 1),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            update: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(4);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/b',
          '/remote/c/c-b',
          '/remote/c/d/d-a',
          '/remote/c/d/d-b',
        ].formatSep().sort()
      );
    });

    test('sync both direction"', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            'c-c': file('c-c', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          b: file('$b', 2),
          c: {
            'c-a': file('$c-a'),
            'c-b': file('$c-b', 2),
            d: {
              'd-a': file('$d-a'),
              'd-b': file('$d-b', 2),
              'd-c': file('$d-c'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            bothDiretions: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(8);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/local/b',
          '/remote/c/c-a',
          '/local/c/c-b',
          '/remote/c/c-c',
          '/remote/c/d/d-a',
          '/local/c/d/d-b',
          '/local/c/d/d-c',
        ].formatSep().sort()
      );
    });

    test('sync both direction --skipCreate"', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            'c-c': file('c-c', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          b: file('$b', 2),
          c: {
            'c-a': file('$c-a'),
            'c-b': file('$c-b', 2),
            d: {
              'd-a': file('$d-a'),
              'd-b': file('$d-b', 2),
              'd-c': file('$d-c'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            skipCreate: true,
            bothDiretions: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(6);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/local/b',
          '/remote/c/c-a',
          '/local/c/c-b',
          '/remote/c/d/d-a',
          '/local/c/d/d-b',
        ].formatSep().sort()
      );
    });
  });
});
