import { Readable, Writable, PassThrough } from 'stream';
import { Client, FileInfo, FileType as BasicFtpFileType } from 'basic-ftp';
import logger from '../../logger';
import { FileEntry, FileType, FileStats, FileOption } from './fileSystem';
import RemoteFileSystem from './remoteFileSystem';
import { FTPClient } from '../remote-client';

interface FtpFileHandle {
  path: string;
  flags: string;
  mode?: number;
}

const numMap = {
  r: 4,
  w: 2,
  x: 1,
};

// basic-ftp exposes unix permissions as { user, group, world } with 'rwx'
// strings; convert to an octal number, defaulting to 0o666 when unavailable.
function toNumMode(permissions): number {
  if (!permissions) return 0o666;

  const parts = [permissions.user, permissions.group, permissions.world];
  let modeStr = '';
  for (const part of parts) {
    if (typeof part !== 'string') {
      return 0o666;
    }
    let cur = 0;
    for (const char of part) {
      cur += numMap[char] || 0;
    }
    modeStr += cur;
  }

  return parseInt(modeStr, 8);
}

/**
 * Remote filesystem over FTP, backed by the maintained `basic-ftp` package.
 *
 * All commands are serialized through the client's single-concurrency queue
 * (see FTPClient.run) because an FTP control connection can only run one
 * command at a time — the queue lives in the client so the keepalive NOOP is
 * serialized against file operations too. basic-ftp negotiates UTF-8
 * automatically, so listing names no longer need the latin1→utf8 repair the
 * old `ftp` package required.
 *
 * Key lifecycle methods:
 * - {@link list} lists and normalizes directory entries.
 * - {@link put} uploads with a one-shot retry for servers that reject STOR
 *   over an existing file (proftpd mod_rename).
 */
export default class FTPFileSystem extends RemoteFileSystem {
  private _supportMFMT: boolean = true;

  static getFileType(type: BasicFtpFileType): FileType {
    if (type === BasicFtpFileType.Directory) {
      return FileType.Directory;
    } else if (type === BasicFtpFileType.File) {
      return FileType.File;
    } else if (type === BasicFtpFileType.SymbolicLink) {
      return FileType.SymbolicLink;
    } else {
      return FileType.Unknown;
    }
  }

  get ftp(): Client {
    return this.getClient().getFsClient();
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    return (this.getClient() as FTPClient).run(task);
  }

  toFileStat(info: FileInfo): FileStats {
    const mtime = info.modifiedAt
      ? this.toLocalTime(info.modifiedAt.getTime())
      : 0;
    return {
      type: FTPFileSystem.getFileType(info.type),
      mode: toNumMode(info.permissions), // Caution: windows will always get 0o666
      size: info.size,
      mtime,
      atime: mtime,
      target: info.link || undefined,
    };
  }

  toFileEntry(fullPath: string, info: FileInfo): FileEntry {
    return {
      fspath: fullPath,
      name: info.name,
      ...this.toFileStat(info),
    };
  }

  _createClient(option) {
    return new FTPClient(option);
  }

  async lstat(path: string): Promise<FileStats> {
    if (path === '/') {
      return {
        type: FileType.Directory,
        mode: 0o666,
        size: 0,
        mtime: 0,
        atime: 0,
      };
    }

    const parentPath = this.pathResolver.dirname(path);
    const nameIdentity = this.pathResolver.basename(path);
    const stats = await this.list(parentPath);

    const fileStat = stats.find(ns => ns.name === nameIdentity);

    if (!fileStat) {
      throw new Error('file not exist');
    }

    return fileStat;
  }

  open(path: string, flags: string, mode?: number): Promise<FtpFileHandle> {
    return Promise.resolve({
      path,
      flags,
      mode,
    });
  }

  close(_fd: FtpFileHandle): Promise<void> {
    return Promise.resolve();
  }

  fstat(fd: FtpFileHandle): Promise<FileStats> {
    return this.lstat(fd.path);
  }

  futimes(fd: FtpFileHandle, _atime: number, mtime: number): Promise<void> {
    if (!this._supportMFMT) return Promise.resolve();

    return this.atomicSetLastMod(fd.path, new Date(mtime * 1000)).catch(_ => {
      logger.info('Don\'t Support MFMT');
      this._supportMFMT = false;
    });
  }

  async get(path, _option?: FileOption): Promise<Readable> {
    return this.atomicGet(path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.atomicSite(`CHMOD ${mode.toString(8)} ${path}`);
  }

  async put(input: Readable, path, _option?: FileOption): Promise<void> {
    try {
      await this.atomicPut(input, path);
    } catch (error) {
      // some servers (e.g. proftpd with mod_rename) reject a STOR over an
      // existing file with 550. Delete the target and retry once.
      if (!isPermanentNegative(error)) {
        throw error;
      }

      let existing: FileStats | undefined;
      try {
        existing = await this.lstat(path);
      } catch (_e) {
        throw error;
      }
      if (existing.type !== FileType.File) {
        throw error;
      }

      logger.info(`STOR rejected over existing file, deleting and retrying: ${path}`);
      await this.atomicDeleteFile(path);
      await this.atomicPut(input, path);
    }
  }

  readlink(path: string): Promise<string> {
    return this.lstat(path).then(stat => stat.target!);
  }

  symlink(_targetPath: string, _path: string): Promise<void> {
    // TO-DO implement
    return Promise.resolve();
  }

  async mkdir(dir: string): Promise<void> {
    return await this.atomicMakeDir(dir);
  }

  async ensureDir(dir: string): Promise<void> {
    return await this._ensureDir(dir, true);
  }

  async _ensureDir(dir: string, checkExistFirst: boolean): Promise<void> {
    // check if exist first.
    // `ls` command can't make sure to return dotfiles, so this not work for dotfiles,
    // cause ftp don't return distinct error code for dir not exists and dir exists
    if (checkExistFirst) {
      let stat;
      try {
        stat = await this.lstat(dir);
      } catch {
        // ignore error
      }

      if (stat) {
        if (stat.type !== FileType.Directory) {
          logger.error(`${dir} (type = ${stat.type})is not a directory`);
          throw new Error(`${dir} is not a valid directory path`);
        }

        return;
      }
    }

    let err;
    try {
      await this.mkdir(dir);
      return;
    } catch (error) {
      // avoid nested code block
      err = error;
    }

    switch (ftpCode(err)) {
      case 550:
        // Hooray, exists!
        if (err.message.toLowerCase().indexOf('file exists') >= 0) {
          return;
        }

        const parentPath = this.pathResolver.dirname(dir);
        // We are trying to create the root dir, something must go wrong.
        if (parentPath === dir) {
          throw err;
        }

        // If goes here, we can assume the file doesn't exist
        await this._ensureDir(parentPath, false);
        await this.mkdir(dir);
        break;

      // In the case of any other error, just see if there's a dir
      // there already.  If so, then hooray!  If not, then something
      // is borked.
      default:
        try {
          const stat = await this.lstat(dir);
          if (stat.type !== FileType.Directory) throw err;
        } catch {
          // if the stat fails, then that's super weird.
          // let the original error be the failure reason
          throw err;
        }
        break;
    }
  }

  async list(dir: string): Promise<FileEntry[]> {
    const infos = await this.atomicList(dir);

    return infos
      .filter(info => info.name && info.name !== '.' && info.name !== '..')
      .map(info => this.toFileEntry(this.pathResolver.join(dir, info.name), info));
  }

  async unlink(path: string): Promise<void> {
    return await this.atomicDeleteFile(path);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    return await this.atomicRemoveDir(path, recursive);
  }

  async rename(srcPath: string, destPath: string): Promise<void> {
    return await this.renameAtomic(srcPath, destPath);
  }

  async renameAtomic(srcPath: string, destPath: string): Promise<void> {
    return this.run(() => this.ftp.rename(srcPath, destPath).then(() => undefined));
  }

  private atomicList(path: string): Promise<FileInfo[]> {
    return this.run(() => this.ftp.list(path));
  }

  private atomicGet(path: string): Promise<Readable> {
    // basic-ftp writes into a Writable; bridge it to the Readable the
    // transfer layer expects via a PassThrough.
    const task = () => {
      const stream = new PassThrough();
      return this.ftp.downloadTo(stream as Writable, path).then(() => undefined, error => {
        stream.destroy(error);
        throw error;
      }).then(() => stream as Readable);
    };
    return this.run(task);
  }

  private atomicPut(input: Readable, path: string): Promise<void> {
    return this.run(() => this.ftp.uploadFrom(input, path).then(() => undefined));
  }

  private atomicDeleteFile(path: string): Promise<void> {
    return this.run(() => this.ftp.remove(path).then(() => undefined));
  }

  private atomicMakeDir(path: string): Promise<void> {
    // send MKD directly so we get the raw error code (ensureDir does its own
    // existence handling); basic-ftp's ensureDir would swallow the 550
    return this.run(() => this.ftp.send('MKD ' + path).then(() => undefined));
  }

  private atomicRemoveDir(path: string, recursive: boolean): Promise<void> {
    const task = () =>
      recursive
        ? this.ftp.removeDir(path)
        : this.ftp.send('RMD ' + path).then(() => undefined);
    return this.run(task);
  }

  private atomicSite(command: string): Promise<void> {
    return this.run(() => this.ftp.send('SITE ' + command).then(() => undefined));
  }

  private atomicSetLastMod(path: string, date: Date): Promise<void> {
    const dateStr =
      date.getUTCFullYear() +
      ('00' + (date.getUTCMonth() + 1)).slice(-2) +
      ('00' + date.getUTCDate()).slice(-2) +
      ('00' + date.getUTCHours()).slice(-2) +
      ('00' + date.getUTCMinutes()).slice(-2) +
      ('00' + date.getUTCSeconds()).slice(-2);

    return this.run(() =>
      this.ftp.send(`MFMT ${dateStr} ${path}`).then(() => undefined)
    );
  }
}

// basic-ftp throws FTPError with a numeric `code`; normalize access to it
function ftpCode(error): number | undefined {
  return error && typeof error.code === 'number' ? error.code : undefined;
}

function isPermanentNegative(error): boolean {
  const code = ftpCode(error);
  return code !== undefined && code >= 500 && code < 600;
}
