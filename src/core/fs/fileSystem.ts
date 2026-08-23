import { Readable } from 'stream';
import * as fs from 'fs';

interface FileSystemError extends Error {
  code: string;
}

export const ERROR_MSG_STREAM_INTERRUPT = 'sftp.stream.interrupt';

export type FileHandle = unknown;

export enum FileType {
  Directory = 1,
  File,
  SymbolicLink,
  Unknown,
}

export interface FileOption {
  flags?: string;
  encoding?: string;
  mode?: number;
  autoClose?: boolean;
  fd?: FileHandle;
}

export interface FileStats {
  type: FileType;
  mode: number;
  size: number;
  mtime: number;
  atime: number;
  // symbol link target
  target?: string;
}

export type FileEntry = FileStats & {
  fspath: string;
  name: string;
};

/** Digests a file system can compute, strongest first. */
export type HashAlgorithm = 'sha256' | 'sha1' | 'md5' | 'crc32';

/** Hex digest length of each algorithm; what a server answers is checked against it. */
export const HASH_HEX_LENGTH: { [algorithm in HashAlgorithm]: number } = {
  sha256: 64,
  sha1: 40,
  md5: 32,
  crc32: 8,
};

/** True for a lowercase hex digest of the length `algorithm` produces. */
export function isHashDigest(value: string, algorithm: HashAlgorithm): boolean {
  return new RegExp(`^[0-9a-f]{${HASH_HEX_LENGTH[algorithm]}}$`).test(value);
}

export default abstract class FileSystem {
  static getFileTypecharacter(stat: fs.Stats): FileType {
    if (stat.isDirectory()) {
      return FileType.Directory;
    } else if (stat.isFile()) {
      return FileType.File;
    } else if (stat.isSymbolicLink()) {
      return FileType.SymbolicLink;
    } else {
      return FileType.Unknown;
    }
  }

  pathResolver: any;

  constructor(pathResolver: any) {
    this.pathResolver = pathResolver;
  }

  abstract readFile(path: string, option?: FileOption): Promise<string | Buffer>;
  abstract open(path: string, flags: string, mode?: number): Promise<FileHandle>;
  abstract close(fd: FileHandle): Promise<void>;
  abstract fstat(fd: FileHandle): Promise<FileStats>;
  /**
   * Change the file system timestamps of the object referenced by the supplied file descriptor.
   *
   * @abstract
   * @param {FileHandle} fd
   * @param {number} atime time in seconds
   * @param {number} mtime time in seconds
   * @returns {Promise<void>}
   * @memberof FileSystem
   */
  abstract futimes(fd: FileHandle, atime: number, mtime: number): Promise<void>;
  abstract get(path: string, option?: FileOption): Promise<Readable>;
  abstract put(input: Readable, path, option?: FileOption): Promise<void>;
  abstract mkdir(dir: string): Promise<void>;
  abstract ensureDir(dir: string): Promise<void>;
  abstract chmod(path: string, mode: number): Promise<void>;
  abstract list(dir: string, option?): Promise<FileEntry[]>;
  abstract lstat(path: string): Promise<FileStats>;

  // stat follows symlinks; file systems without a native followed-stat
  // fall back to lstat
  stat(path: string): Promise<FileStats> {
    return this.lstat(path);
  }

  /**
   * Size of `path` as the file system reports it right now, used to verify
   * that an upload landed whole. One lstat() by default; a file system for
   * which a stat is expensive overrides it with a dedicated query (FTP: SIZE,
   * because its lstat() lists the whole parent directory).
   */
  statSize(path: string): Promise<number> {
    return this.lstat(path).then(stat => stat.size);
  }

  /**
   * Modification time of `path` in milliseconds on the local clock (remote
   * file systems already apply `remoteTimeOffsetInHours`), or `undefined`
   * when the file system cannot answer cheaply. It only feeds a post-upload
   * hint, so a file system is free to opt out rather than pay for it.
   */
  statMtime(path: string): Promise<number | undefined> {
    return this.lstat(path).then(stat => stat.mtime);
  }

  /**
   * Strongest digest this file system can compute for its files, or `null`
   * when it cannot compute any (no shell on the SSH server, no hash command
   * in FTP's FEAT). Implementations probe once and cache the answer for the
   * life of the connection; the default is "no".
   */
  supportsHash(): Promise<HashAlgorithm | null> {
    return Promise.resolve(null);
  }

  /**
   * Lowercase hex digest of `path` with `algorithm`, which should be the one
   * {@link supportsHash} reported. Rejects when the file system cannot hash
   * (the default) or when the server's answer cannot be trusted; the caller
   * decides whether that degrades to a weaker check or fails.
   */
  hashFile(_path: string, _algorithm: HashAlgorithm): Promise<string> {
    return Promise.reject(new Error('hash not supported'));
  }
  abstract readlink(path: string): Promise<string>;
  abstract symlink(targetPath: string, path: string): Promise<void>;
  abstract unlink(path: string): Promise<void>;
  abstract rmdir(path: string, recursive: boolean): Promise<void>;
  abstract rename(srcPath: string, destPath: string): Promise<void>;
  abstract renameAtomic(srcPath: string, destPath: string): Promise<void>;

  // the error a transfer rejects with when it was cancelled rather than failed
  static createAbortedError(): Error {
    const err = new Error('Transfer Aborted') as FileSystemError;
    err.code = ERROR_MSG_STREAM_INTERRUPT;
    return err;
  }

  static abortReadableStream(stream: Readable) {
    const err = FileSystem.createAbortedError();

    // don't do `stream.destroy(err)`! `sftp.ReadaStream` do not support `err` parameter in `destory` method.
    stream.emit('error', err);
    stream.destroy();
  }

  static isAbortedError(err: FileSystemError) {
    return err.code === ERROR_MSG_STREAM_INTERRUPT;
  }
}
