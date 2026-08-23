import { Readable, Transform, TransformCallback } from 'stream';
import * as fileOperations from './fileBaseOperations';
import CustomError from './customError';
import { FileSystem, FileType } from './fs';
import { Task } from './scheduler';
import logger from '../logger';
import { isNotFoundError } from '../helper';

let hasWarnedModifedTimePermission = false;

export enum TransferDirection {
  LOCAL_TO_REMOTE = 'local ➞ remote',
  REMOTE_TO_LOCAL = 'remote ➞ local',
}

/** Post-upload checks a transfer can run; `hash` is planned, not offered yet. */
export type VerifyUploadLevel = 'none' | 'stat';

export const DEFAULT_VERIFY_UPLOAD: VerifyUploadLevel = 'stat';
export const DEFAULT_TRANSFER_RETRIES = 2;
export const ERROR_CODE_VERIFY = 'EVERIFY';

// each retry waits RETRY_BASE_DELAY_MS × attempt before re-opening the source
const RETRY_BASE_DELAY_MS = 500;
// remote file systems report mtime in whole seconds and some round them
const MTIME_TOLERANCE_IN_SECONDS = 2;

interface FileHandle {
  fsPath: string;
  fileSystem: FileSystem;
}

export interface TransferOption {
  atime: number;
  mtime: number;
  // source size known at collection time (a listing or lstat); downloads reuse
  // it so FTP is not asked to LIST the parent directory again per file
  size?: number;
  mode?: number;
  filePerm?: number;
  dirPerm?: number;
  fallbackMode?: number;
  perserveTargetMode: boolean;
  useTempFile?: boolean;
  openSsh?: boolean;
  // what to check on the server once an upload finished; 'stat' when omitted
  verifyUpload?: VerifyUploadLevel;
  // how many times a failed attempt is repeated before giving up; 2 when omitted
  retries?: number;
}

export interface TransferVerification {
  level: VerifyUploadLevel;
  ok: boolean;
  reason?: string;
}

/**
 * Raised when a transfer finished at protocol level but what arrived does not
 * match what was sent: fewer bytes than the source holds, a different size on
 * the server, or no file at all after the upload. `reason` carries the
 * human-readable cause; `code` is always {@link ERROR_CODE_VERIFY}.
 */
export class TransferVerificationError extends CustomError {
  readonly reason: string;

  constructor(reason: string, fsPath: string) {
    super(ERROR_CODE_VERIFY, `Transfer verification failed for ${fsPath}: ${reason}`);
    this.reason = reason;
  }
}

/**
 * Counts the bytes flowing from the source stream into the target file
 * system, so the task can compare what was handed over against the source
 * size. A Transform (not a 'data' listener) keeps the source paused until the
 * target starts reading and preserves backpressure.
 */
class ByteCounter extends Transform {
  bytes: number = 0;

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
    this.bytes += chunk.length;
    this.push(chunk);
    callback();
  }
}

/**
 * One file (or symlink) going from a source file system to a target one, in
 * either direction. It is the unit the transfer scheduler runs, cancels and
 * reports on.
 *
 * Beyond streaming the bytes it is responsible for proving the transfer
 * landed: every attempt counts the bytes handed to the target against the
 * source size, an upload is then checked against the server according to
 * {@link TransferOption.verifyUpload}, and a failed attempt is retried with an
 * increasing delay unless the task was cancelled. The outcome is exposed
 * through {@link verification}, {@link bytesTransferred}, {@link expectedSize}
 * and {@link attempts}.
 *
 * Key lifecycle methods:
 * - {@link run} transfers with retries; rejects with
 *   {@link TransferVerificationError} when what arrived does not match what
 *   was sent.
 * - {@link cancel} aborts the source stream and stops further retries.
 */
export default class TransferTask implements Task {
  readonly fileType: FileType;
  private readonly _srcFsPath: string;
  private readonly _targetFsPath: string;
  private readonly _srcFs: FileSystem;
  private readonly _targetFs: FileSystem;
  private readonly _transferDirection: TransferDirection;
  private readonly _TransferOption: TransferOption;
  private _handle: Readable | undefined;
  private _counter: ByteCounter | undefined;
  private _retryWait: (() => void) | undefined;
  private _cancelled: boolean = false;
  private _attempts: number = 0;
  private _bytesTransferred: number = 0;
  private _expectedSize: number | undefined;
  private _verification: TransferVerification | undefined;

  constructor(
    src: FileHandle,
    target: FileHandle,
    option: {
      fileType: FileType;
      transferDirection: TransferDirection;
      transferOption: TransferOption;
    }
  ) {
    this._srcFsPath = src.fsPath;
    this._targetFsPath = target.fsPath;
    this._srcFs = src.fileSystem;
    this._targetFs = target.fileSystem;
    this._TransferOption = option.transferOption;
    this._transferDirection = option.transferDirection;
    this.fileType = option.fileType;
  }

  get localFsPath() {
    if (this._transferDirection === TransferDirection.REMOTE_TO_LOCAL) {
      return this._targetFsPath;
    } else {
      return this._srcFsPath;
    }
  }

  get srcFsPath() {
    return this._srcFsPath;
  }

  get targetFsPath() {
    return this._targetFsPath;
  }

  get transferType() {
    return this._transferDirection;
  }

  /** Bytes handed to the target file system by the last attempt. */
  get bytesTransferred(): number {
    return this._bytesTransferred;
  }

  /** Source size the transfer was measured against; unset until run() stats it. */
  get expectedSize(): number | undefined {
    return this._expectedSize;
  }

  /** Attempts made so far, the first one included. */
  get attempts(): number {
    return this._attempts;
  }

  /** Outcome of the post-transfer checks of the last attempt; unset for symlinks. */
  get verification(): TransferVerification | undefined {
    return this._verification;
  }

  /** mtime of the source as it was collected ({@link TransferOption.mtime}), in ms. */
  get sourceMtime(): number {
    return this._TransferOption.mtime;
  }

  /** Size of the source as it was collected, when the collector knew it. */
  get sourceSize(): number | undefined {
    return this._TransferOption.size;
  }

  async run() {
    const retries = this._maxRetries();
    let attempt = 0;
    while (true) {
      attempt += 1;
      this._attempts = attempt;
      try {
        await this._transferOnce();
        return;
      } catch (error) {
        this._releaseStreams();
        if (this._cancelled || FileSystem.isAbortedError(error) || attempt > retries) {
          throw error;
        }

        const message = error && error.message ? error.message : String(error);
        logger.warn(`[transfer] retry ${attempt}/${retries} for ${this.localFsPath}: ${message}`);
        await this._waitBeforeRetry(attempt);
        if (this._cancelled) {
          throw FileSystem.createAbortedError();
        }
      }
    }
  }

  cancel() {
    if (this._cancelled) {
      return;
    }

    this._cancelled = true;
    if (this._handle) {
      FileSystem.abortReadableStream(this._handle);
    }
    if (this._retryWait) {
      this._retryWait();
    }
  }

  isCancelled(): boolean {
    return this._cancelled;
  }

  private async _transferOnce() {
    this._bytesTransferred = 0;
    this._verification = undefined;

    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    switch (this.fileType) {
      case FileType.File:
        await this._transferFile();
        break;
      case FileType.SymbolicLink:
        await fileOperations.transferSymlink(
          src,
          target,
          srcFs,
          targetFs,
          this._TransferOption
        );
        break;
      default:
        logger.warn(`Unsupported file type (type = ${this.fileType}). File ${src}`);
    }
  }

  private async _transferFile() {
    const target = this._targetFsPath;
    const targetFs = this._targetFs;
    const {
      perserveTargetMode,
      useTempFile,
      openSsh,
      fallbackMode,
      atime,
      mtime,
      filePerm,
    } = this._TransferOption;
    // Set the mode if it's specified in the config, otherwise get mode from server.
    let mode = filePerm ? parseInt(String(filePerm), 8) : this._TransferOption.mode;
    let targetFd; // Destination file
    let uploadFd; // Temp file or destination file when no temp file is used
    let handle: Readable;
    const uploadTarget = target + (useTempFile ? '.new' : '');

    // measured before anything is opened: what the target ends up holding is
    // compared against this
    const expectedSize = await this._resolveExpectedSize();
    this._expectedSize = expectedSize;

    // Use mode first.
    // Then check perserveTargetMode and fallback to fallbackMode if fail to get mode of target
    if (mode === undefined && perserveTargetMode) {
      if (useTempFile) {
        [targetFd, uploadFd] = await Promise.all([
          targetFs.open(target, 'r')  // Get handle for reading the target mode
            .catch(() => null), // Return null if target file doesn't exist
          targetFs.open(uploadTarget, 'w'),  // Get handle for the file upload
        ]);
      } else {
        targetFd = uploadFd = await targetFs.open(uploadTarget, 'w');
      }

      if (targetFd) {
        [handle, mode] = await Promise.all([
          this._openSource(),
          targetFs
            .fstat(targetFd)
            .then(stat => stat.mode)
            .catch(() => fallbackMode),
        ]);

        if (useTempFile) {
          targetFs.close(targetFd);
        }

      } else {
        handle = await this._openSource();
        mode = fallbackMode;
      }

    } else {
      [handle, uploadFd] = await Promise.all([
        this._openSource(),
        targetFs.open(uploadTarget, 'w'),
      ]);
    }

    const input = this._countBytes(handle);

    try {
      // a cancel() that raced the open above already aborted the source; the
      // target would otherwise wait for an 'end' that never comes
      if (this._cancelled) {
        throw FileSystem.createAbortedError();
      }

      if (useTempFile) {
        logger.info('uploading temp file: ' + uploadTarget);
      }
      await targetFs.put(input, uploadTarget, {
        mode,
        fd: uploadFd,
        autoClose: false,
      });

      this._bytesTransferred = input.bytes;
      if (input.bytes !== expectedSize) {
        throw this._verificationError(
          `bytes mismatch (sent ${input.bytes}, expected ${expectedSize})`
        );
      }

      let mtimeApplied = false;
      if (atime && mtime) {
        try {
          await targetFs.futimes(
            uploadFd,
            Math.floor(atime / 1000),
            Math.floor(mtime / 1000)
          );
          mtimeApplied = true;
        } catch (error) {
          if (!hasWarnedModifedTimePermission) {
            hasWarnedModifedTimePermission = true;
            logger.warn(
              `Can't set modified time to the file because ${error.message}`
            );
          }
        }
      }

      if (useTempFile) {
        logger.info('moving from: ' + target + '.new' + ' to: ' + target);
        if(openSsh) {
          await targetFs.renameAtomic(uploadTarget, target);
        } else {
          try {
            await targetFs.unlink(target);
          } catch(error) {
            // Just ignore
          }
          await targetFs.rename(uploadTarget, target);
        }
      }

      // the final path is what gets checked, not the temp file
      if (this._verifyLevel() === 'stat') {
        await this._verifyUpload(target, expectedSize, mtimeApplied);
      } else {
        this._verification = { level: this._verifyLevel(), ok: true };
      }

    } finally {
      await targetFs.close(uploadFd);
    }
  }

  // the remote stat taken while collecting is reused for downloads (over FTP
  // an lstat is a LIST of the whole parent directory); a local stat is cheap
  // and, unlike the collected one, sees a file rewritten since then
  private async _resolveExpectedSize(): Promise<number> {
    const { size } = this._TransferOption;
    if (
      this._transferDirection === TransferDirection.REMOTE_TO_LOCAL &&
      typeof size === 'number'
    ) {
      return size;
    }

    const stat = await this._srcFs.lstat(this._srcFsPath);
    return stat.size;
  }

  private async _openSource(): Promise<Readable> {
    const handle = await this._srcFs.get(this._srcFsPath);
    // stored as soon as it exists so cancel() and a failed sibling open() can
    // still reach it
    this._handle = handle;
    if (this._cancelled) {
      FileSystem.abortReadableStream(handle);
    }
    return handle;
  }

  // pipe() forwards data, not errors, and the target only watches the stream
  // it is handed: a failed or aborted source has to be mirrored onto the
  // counter or put() would wait for a 'finish' that never comes
  private _countBytes(handle: Readable): ByteCounter {
    const counter = new ByteCounter();
    // put() attaches its own 'error' listener; this one only keeps an abort
    // that lands before put() is listening from becoming an uncaught exception
    counter.on('error', () => undefined);
    handle.once('error', err => {
      // emitted, not destroy(err): a counter that already ended has
      // auto-destroyed and would swallow the error, while put() is still
      // waiting on it (same reason abortReadableStream emits)
      counter.emit('error', err);
      counter.destroy();
    });
    handle.pipe(counter);
    this._counter = counter;
    return counter;
  }

  // streams of a failed attempt are torn down before the next one re-opens
  // the source; the target fd is closed by _transferFile itself
  private _releaseStreams() {
    const handle = this._handle;
    const counter = this._counter;
    this._handle = undefined;
    this._counter = undefined;
    if (counter) {
      counter.destroy();
    }
    if (handle && typeof handle.destroy === 'function') {
      handle.destroy();
    }
  }

  private async _verifyUpload(target: string, expectedSize: number, mtimeApplied: boolean) {
    const targetFs = this._targetFs;
    let remoteSize: number;
    try {
      remoteSize = await targetFs.statSize(target);
    } catch (error) {
      throw this._verificationError(
        isNotFoundError(error)
          ? 'not found after upload'
          : `stat failed after upload (${error.message})`
      );
    }

    if (remoteSize !== expectedSize) {
      throw this._verificationError(
        `size mismatch (local ${expectedSize}, remote ${remoteSize})`
      );
    }
    this._verification = { level: 'stat', ok: true };

    // mtime is a hint, never a failure: it only says something when this very
    // transfer managed to set it, and even then clocks and offsets get in the way
    if (mtimeApplied) {
      await this._warnIfMtimeDiffers(target);
    }
  }

  private async _warnIfMtimeDiffers(target: string) {
    const { mtime } = this._TransferOption;
    let remoteMtime: number | undefined;
    try {
      remoteMtime = await this._targetFs.statMtime(target);
    } catch (error) {
      logger.debug(`[transfer] can't read mtime after upload of ${target}: ${error.message}`);
      return;
    }
    if (remoteMtime === undefined) {
      return;
    }

    const localSeconds = Math.floor(mtime / 1000);
    const remoteSeconds = Math.floor(remoteMtime / 1000);
    if (Math.abs(remoteSeconds - localSeconds) > MTIME_TOLERANCE_IN_SECONDS) {
      logger.warn(
        `[transfer] mtime differs after upload of ${this.localFsPath}: ` +
          `local ${localSeconds}s, remote ${remoteSeconds}s. Check remoteTimeOffsetInHours.`
      );
    }
  }

  private _verificationError(reason: string): TransferVerificationError {
    this._verification = { level: this._verifyLevel(), ok: false, reason };
    return new TransferVerificationError(reason, this.localFsPath);
  }

  // a server-side check only makes sense for uploads; downloads still count bytes
  private _verifyLevel(): VerifyUploadLevel {
    if (this._transferDirection !== TransferDirection.LOCAL_TO_REMOTE) {
      return 'none';
    }
    return this._TransferOption.verifyUpload === 'none' ? 'none' : DEFAULT_VERIFY_UPLOAD;
  }

  private _maxRetries(): number {
    const { retries } = this._TransferOption;
    if (typeof retries === 'number' && retries >= 0) {
      return Math.floor(retries);
    }
    return DEFAULT_TRANSFER_RETRIES;
  }

  private _waitBeforeRetry(attempt: number): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this._retryWait = undefined;
        resolve();
      }, RETRY_BASE_DELAY_MS * attempt);
      // unref'd so a pending retry never holds the process open (see syncControl)
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      // cancel() cuts the wait short instead of letting it run out
      this._retryWait = () => {
        clearTimeout(timer);
        this._retryWait = undefined;
        resolve();
      };
    });
  }
}
