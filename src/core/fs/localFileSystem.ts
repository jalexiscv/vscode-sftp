import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as crypto from 'crypto';
import FileSystem, {
  FileEntry,
  FileStats,
  FileOption,
  HashAlgorithm,
} from './fileSystem';
import Crc32 from './crc32';

interface Digester {
  update(chunk: Buffer): void;
  digest(): string;
}

// crypto covers everything but crc32, which an FTP server may be the only
// one to offer (XCRC)
function createDigester(algorithm: HashAlgorithm): Digester {
  if (algorithm === 'crc32') {
    return new Crc32();
  }

  const hash = crypto.createHash(algorithm);
  return {
    update: chunk => hash.update(chunk),
    digest: () => hash.digest('hex'),
  };
}

/**
 * The workspace side of every transfer: node's `fs` behind the FileSystem
 * contract the remote implementations share, so the transfer code never has
 * to know which end is local.
 *
 * Key lifecycle methods:
 * - {@link get} / {@link put} stream a file in and out.
 * - {@link hashFile} computes the local digest an upload is compared against,
 *   in whichever algorithm the server could answer with.
 */
export default class LocalFileSystem extends FileSystem {
  constructor(pathResolver: any) {
    super(pathResolver);
  }

  toFileStat(stat: fs.Stats): FileStats {
    return {
      type: FileSystem.getFileTypecharacter(stat),
      size: stat.size,
      mode: stat.mode & parseInt('777', 8), // tslint:disable-line:no-bitwise
      mtime: stat.mtime.getTime(),
      atime: stat.atime.getTime(),
    };
  }

  lstat(path: string): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      fs.lstat(path, (err, stat: fs.Stats) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  readFile(path, option?): Promise<string | Buffer> {
    return new Promise((resolve, reject) => {
      fs.readFile(path, option, (err, data) => {
        if (err) {
          return reject(err);
        }

        resolve(data);
      });
    });
  }

  open(path: string, flags: string, mode?: number): Promise<number> {
    return fse.open(path, flags, mode);
  }

  close(fd: number): Promise<void> {
    return fse.close(fd);
  }

  fstat(fd: number): Promise<FileStats> {
    return fse.fstat(fd).then(stat => this.toFileStat(stat));
  }

  futimes(fd: number, atime: number, mtime: number): Promise<void> {
    return fse.futimes(fd, atime, mtime);
  }

  // the local side can answer any of them; sha256 is what it prefers when
  // asked on its own
  supportsHash(): Promise<HashAlgorithm | null> {
    return Promise.resolve('sha256');
  }

  hashFile(path: string, algorithm: HashAlgorithm): Promise<string> {
    return new Promise((resolve, reject) => {
      let digester: Digester;
      try {
        digester = createDigester(algorithm);
      } catch (err) {
        reject(err);
        return;
      }

      // streamed, so a large file never has to fit in memory. A stream that
      // fails can report it more than once (the read, then the close): keep
      // listening or the second one would be an uncaught 'error'
      const stream = fs.createReadStream(path);
      stream.on('data', (chunk: Buffer) => digester.update(chunk));
      stream.on('error', reject);
      stream.once('end', () => resolve(digester.digest()));
    });
  }

  get(path, option?): Promise<fs.ReadStream> {
    return new Promise((resolve, reject) => {
      try {
        const stream = fs.createReadStream(path, option);
        stream.once('error', reject);
        resolve(stream);
      } catch (err) {
        reject(err);
      }
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      fs.chmod(path, mode,err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  put(input: fs.ReadStream, path, option?: FileOption): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (option && option.fd && typeof option.fd !== 'number') {
        return reject(new Error('fd is not a number'));
      }

      const writer = fs.createWriteStream(path, option as any);
      writer.once('error', reject).once('finish', resolve); // transffered

      input.once('error', err => {
        reject(err);
        writer.end();
      });
      input.pipe(writer);
    });
  }

  readlink(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      fs.readlink(path, (err, linkString) => {
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
      fs.symlink(targetPath, path, null, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  mkdir(dir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.mkdir(dir, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  ensureDir(dir: string): Promise<void> {
    return fse.ensureDir(dir);
  }

  toFileEntry(fullPath: string, stat: FileStats): FileEntry {
    return {
      fspath: fullPath,
      name: this.pathResolver.basename(fullPath),
      ...stat,
    };
  }

  list(dir: string): Promise<FileEntry[]> {
    return new Promise((resolve, reject) => {
      fs.readdir(dir, (err, files) => {
        if (err) {
          reject(err);
          return;
        }

        const fileStatus = files.map(file => {
          const fspath = this.pathResolver.join(dir, file);
          return this.lstat(fspath).then(stat =>
            this.toFileEntry(fspath, stat)
          );
        });

        resolve(Promise.all(fileStatus));
      });
    });
  }

  unlink(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.unlink(path, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    if (recursive) {
      return fse.remove(path);
    }

    return new Promise<void>((resolve, reject) => {
      fs.rmdir(path, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  rename(srcPath: string, destPath: string): Promise<void> {
    return fse.rename(srcPath, destPath);
  }

  renameAtomic(srcPath: string, destPath: string): Promise<void> {
    return fse.rename(srcPath, destPath);
  }
}
