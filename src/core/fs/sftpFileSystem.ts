import { Readable, Writable } from 'stream';
import FileSystem, {
  FileEntry,
  FileType,
  FileStats,
  FileOption,
  HashAlgorithm,
  isHashDigest,
} from './fileSystem';
import RemoteFileSystem from './remoteFileSystem';
import { SSHClient } from '../remote-client';
import logger from '../../logger';

type FileHandle = Buffer;

interface SFTPFileDescriptor {
  handle: FileHandle;
  path: string;
}

interface WriteStream extends Writable {
  handle: Buffer;
  path: string;
  flags: string;
  mode: number;
  destroy(): void;
  close(): void;
}

function toSimpleFileMode(mode: number) {
  return mode & parseInt('777', 8); // tslint:disable-line:no-bitwise
}

/**
 * A digest tool that may exist on the server. `probe` runs it against
 * /dev/null, so a tool is only chosen when it is there *and* its output
 * parses to the digest of the empty input; `parse` pulls the hex out of one
 * line of output.
 */
interface HashCommand {
  algorithm: HashAlgorithm;
  command: string;
  emptyDigest: string;
  parse(stdout: string): string;
}

// GNU coreutils >= 9 prefix the line with a backslash when the file name
// needed escaping; shasum and BusyBox print the digest first as well
function firstToken(stdout: string): string {
  return stdout.trim().split(/\s+/)[0].replace(/^\\/, '');
}

// `SHA256(path)= hex` (OpenSSL 1.x, LibreSSL) or `SHA2-256(path)= hex` (3.x)
function afterEquals(stdout: string): string {
  const index = stdout.lastIndexOf('= ');
  return index === -1 ? '' : stdout.slice(index + 2).trim();
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';

// tried in this order, once per connection; sha256 wherever a tool gives it
// (coreutils, perl's shasum, openssl) and md5 only as a last resort
export const SFTP_HASH_COMMANDS: HashCommand[] = [
  { algorithm: 'sha256', command: 'sha256sum', emptyDigest: EMPTY_SHA256, parse: firstToken },
  { algorithm: 'sha256', command: 'shasum -a 256', emptyDigest: EMPTY_SHA256, parse: firstToken },
  { algorithm: 'sha256', command: 'openssl dgst -sha256', emptyDigest: EMPTY_SHA256, parse: afterEquals },
  { algorithm: 'md5', command: 'md5sum', emptyDigest: EMPTY_MD5, parse: firstToken },
];

// single quotes keep every shell metacharacter literal; an embedded quote
// closes, escapes and reopens them
export function quoteForShell(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Remote file system over SFTP, speaking to the ssh2 sftp channel that
 * SSHClient opened. Paths are the server's own; times go through
 * `remoteTimeOffsetInHours` on the way in and out.
 *
 * Besides the SFTP protocol it can lean on the SSH shell, when the account
 * has one, to verify an upload by digest ({@link supportsHash} probes the
 * usual checksum tools once per connection; {@link hashFile} runs the one
 * found). Without a shell both degrade to "not available" instead of failing.
 *
 * Key lifecycle methods:
 * - {@link get} / {@link put} stream files through the sftp channel.
 * - {@link supportsHash} / {@link hashFile} answer the hash level of the
 *   upload verification.
 */
export default class SFTPFileSystem extends RemoteFileSystem {
  // undefined: not probed yet; null: no usable tool on this server
  private _hashCommand: HashCommand | null | undefined;
  private _hashProbe: Promise<HashAlgorithm | null> | undefined;

  get sftp() {
    return this.getClient().getFsClient();
  }

  toFileStat(stat): FileStats {
    return {
      type: FileSystem.getFileTypecharacter(stat),
      mode: toSimpleFileMode(stat.mode), // tslint:disable-line:no-bitwise
      size: stat.size,
      mtime: this.toLocalTime(stat.mtime * 1000),
      atime: this.toLocalTime(stat.atime * 1000),
    };
  }

  toFileEntry(fullPath, item): FileEntry {
    return {
      fspath: fullPath,
      name: item.filename,
      ...this.toFileStat(item.attrs),
    };
  }

  _createClient(option) {
    return new SSHClient(option);
  }

  lstat(path: string): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      this.sftp.lstat(path, (err, stat) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  stat(path: string): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      this.sftp.stat(path, (err, stat) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  open(
    path: string,
    flags: string,
    mode?: number
  ): Promise<SFTPFileDescriptor> {
    return new Promise((resolve, reject) => {
      this.sftp.open(path, flags, mode, (err, handle) => {
        if (err) {
          return reject(err);
        }

        resolve({
          path,
          handle,
        });
      });
    });
  }

  close(fd: SFTPFileDescriptor): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.close(fd.handle, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  fstat(fd: SFTPFileDescriptor): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      this.sftp.fstat(fd.handle, (err, stat) => {
        if (err) {
          // Try stat() for sftp servers that may not support fstat() for
          // whatever reason
          // see WriteStream.prototype.open in ssh2-streams.
          this.sftp.stat(fd.path, (_err, _stat) => {
            if (_err) {
              reject(err);
              return;
            }

            resolve(this.toFileStat(_stat));
          });
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  futimes(fd: SFTPFileDescriptor, atime: number, mtime: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.futimes(
        fd.handle,
        this.toRemoteTimeInSecnonds(atime),
        this.toRemoteTimeInSecnonds(mtime),
        err => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        }
      );
    });
  }

  fchmod(fd: SFTPFileDescriptor, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.fchmod(fd.handle, mode, err => {
        if (err) {
          // Try chmod() for sftp servers that may not support fchmod() for
          // whatever reason
          // see WriteStream.prototype.open in ssh2-streams.
          this.sftp.chmod(fd.path, mode, _err => {
            if (_err) {
              reject(err);
              return;
            }

            resolve();
          });
          return;
        }

        resolve();
      });
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.chmod(path, mode, err => {
        if(err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  get(path, option?: FileOption): Promise<Readable> {
    return new Promise((resolve, reject) => {
      // const opt = { ...option, autoDestroy: false };
      try {
        // const stream = this.sftp.createReadStream(path, opt);
        const stream = this.sftp.createReadStream(path, option);
        resolve(stream);
      } catch (err) {
        reject(err);
      }
    });
  }

  rename(srcPath: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.rename(srcPath, destPath, err => {
        if (err) {
          return reject(err);
        }

        resolve();
      });
    });
  }

  // See: https://github.com/mscdex/ssh2/issues/1054
  renameAtomic(srcPath: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.ext_openssh_rename(srcPath, destPath, err => {
        if (err) {
          return reject(err);
        }

        resolve();
      });
    });
  }

  async put(input: Readable, path, option?: FileOption): Promise<void> {
    if (option && option.fd) {
      const fd = option.fd as SFTPFileDescriptor;
      // const opt = { ...option, handle: fd.handle, autoDestroy: false };
      const opt = { ...option, handle: fd.handle };
      delete opt.fd;

      if (opt.mode) {
        // mode will get ignored if handle passed in.
        // call chmod manunally.
        try {
          await this.fchmod(fd, opt.mode);
        } catch {
          // ignore error
        }
      }

      return this._put(input, path, opt);
    }

    return this._put(input, path, option);
  }

  readlink(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.sftp.readlink(path, (err, linkString) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(linkString);
      });
    });
  }

  symlink(targetPath: string, path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.symlink(targetPath, path, err => {
        if (err) {
          reject(err);
        }
        resolve();
      });
    });
  }

  mkdir(dir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.mkdir(dir, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async ensureDir(dir: string): Promise<void> {
    // test is root path
    // win: c:/, c://, c:\, c:\\
    // *nix: /
    if (dir === '/' || dir.match(/^[a-zA-Z]:(\/|\\)\1?$/)) {
      return;
    }

    let err;
    try {
      await this.mkdir(dir);
      return;
    } catch (error) {
      // avoid nested code block
      err = error;
    }

    switch (err.code) {
      case 2:
        const parentPath = this.pathResolver.dirname(dir);
        if (parentPath === dir) throw err;
        await this.ensureDir(parentPath);
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

  list(dir: string, { showHiddenFiles = true } = {}): Promise<FileEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(dir, (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        const fileEntries = result.map(item =>
          this.toFileEntry(this.pathResolver.join(dir, item.filename), item)
        );
        resolve(fileEntries);
      });
    });
  }

  unlink(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.unlink(path, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!recursive) {
        this.sftp.rmdir(path, err => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
        return;
      }

      this.list(path).then(
        fileEntries => {
          if (!fileEntries.length) {
            this.rmdir(path, false).then(resolve, e => {
              reject(e);
            });
            return;
          }

          const rmPromises = fileEntries.map(file => {
            if (file.type === FileType.Directory) {
              return this.rmdir(file.fspath, true);
            }
            return this.unlink(file.fspath);
          });

          Promise.all(rmPromises)
            .then(() => this.rmdir(path, false))
            .then(resolve, e => {
              // BUG just reject will occur weird bug.
              reject(e);
            });
        },
        err => {
          reject(err);
        }
      );
    });
  }

  /**
   * First checksum tool of {@link SFTP_HASH_COMMANDS} the server runs, probed
   * once per connection (parallel uploads share the probe). A server that
   * refuses `exec` altogether (SFTP-only accounts, chrooted internal-sftp)
   * answers null on the first attempt and is never asked again.
   */
  supportsHash(): Promise<HashAlgorithm | null> {
    if (this._hashCommand !== undefined) {
      return Promise.resolve(this._hashCommand ? this._hashCommand.algorithm : null);
    }
    if (!this._hashProbe) {
      this._hashProbe = this._probeHashCommand().then(command => {
        this._hashCommand = command;
        this._hashProbe = undefined;
        return command ? command.algorithm : null;
      });
    }
    return this._hashProbe;
  }

  async hashFile(path: string, algorithm: HashAlgorithm): Promise<string> {
    await this.supportsHash();
    const command = this._hashCommand;
    if (!command || command.algorithm !== algorithm) {
      throw new Error(`${algorithm} is not available on this server`);
    }

    const result = await this._ssh.exec(`${command.command} ${quoteForShell(path)}`);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(`${command.command} exited with ${result.code}${detail ? ': ' + detail : ''}`);
    }

    const digest = command.parse(result.stdout).toLowerCase();
    if (!isHashDigest(digest, algorithm)) {
      throw new Error(`unexpected ${command.command} output: ${result.stdout.trim().slice(0, 80)}`);
    }
    return digest;
  }

  private get _ssh(): SSHClient {
    return this.getClient() as SSHClient;
  }

  // each tool hashes /dev/null: present and parsable, or on to the next one.
  // An exec the server refuses ends the probe there and then
  private async _probeHashCommand(): Promise<HashCommand | null> {
    for (const candidate of SFTP_HASH_COMMANDS) {
      let result;
      try {
        result = await this._ssh.exec(`${candidate.command} /dev/null`);
      } catch (error) {
        logger.debug(`[sftp] exec not available, hash verification disabled: ${error.message}`);
        return null;
      }

      if (result.code === 0 && candidate.parse(result.stdout).toLowerCase() === candidate.emptyDigest) {
        logger.debug(`[sftp] hashing uploads with ${candidate.command}`);
        return candidate;
      }
    }
    return null;
  }

  private _put(
    input: Readable,
    path,
    option?: {
      flags?: string;
      encoding?: string;
      mode?: number;
      autoClose?: boolean;
      handle?: FileHandle;
    }
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const writer: WriteStream = this.sftp.createWriteStream(path, option);
      writer.once('error', reject).once('finish', resolve); // transffered

      input.once('error', err => {
        reject(err);
        writer.end();
      });
      input.pipe(writer);
    });
  }
}
