import { Readable, Transform, TransformCallback } from 'stream';
import * as fileOperations from './fileBaseOperations';
import CustomError from './customError';
import { FileSystem, FileType } from './fs';
import { HashAlgorithm } from './fs/fileSystem';
import { Task } from './scheduler';
import logger from '../logger';
import { isNotFoundError } from '../helper';
import { isConnectionLostError, markConnectionLost } from './connectionHealth';

let hasWarnedModifedTimePermission = false;
// remote file systems already told once that they cannot hash (one per connection)
const hasWarnedHashUnavailable = new WeakSet<FileSystem>();

export enum TransferDirection {
  LOCAL_TO_REMOTE = 'local ➞ remote',
  REMOTE_TO_LOCAL = 'remote ➞ local',
}

/**
 * Post-upload checks a transfer can run: `stat` compares the remote size,
 * `hash` also compares a digest and degrades to `stat` when the server cannot
 * compute one.
 */
export type VerifyUploadLevel = 'none' | 'stat' | 'hash';

export const DEFAULT_VERIFY_UPLOAD: VerifyUploadLevel = 'stat';
export const DEFAULT_TRANSFER_RETRIES = 2;
export const ERROR_CODE_VERIFY = 'EVERIFY';

// each retry waits RETRY_BASE_DELAY_MS × attempt before re-opening the source
export const RETRY_BASE_DELAY_MS = 500;
// the delay actually used; only setRetryBaseDelayForTest() moves it
let retryBaseDelayMs = RETRY_BASE_DELAY_MS;
// remote file systems report mtime in whole seconds and some round them
const MTIME_TOLERANCE_IN_SECONDS = 2;

/**
 * Test hook: shortens the base delay between retries, or restores the default
 * when called without a value. The retry tests drive real streams over memfs,
 * which do not tolerate fake timers, and 500 ms × attempt per retry adds up
 * to seconds of wall-clock wait for every case that exhausts the retries.
 * Production code never calls it.
 */
export function setRetryBaseDelayForTest(ms: number = RETRY_BASE_DELAY_MS): void {
  retryBaseDelayMs = ms;
}

/**
 * Where a failed attempt was when it broke: reaching the source (stat, open,
 * read) or working on the target (open, write, futimes, rename, verify). The
 * same "not found" means opposite things on each side, see
 * {@link isRetryableTransferError}.
 */
export type TransferPhase = 'source' | 'target';

// errno codes no retry can fix: permissions, a path of the wrong kind, a
// read-only target or an operation the file system does not implement
const PERMANENT_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'EROFS', 'ENOTSUP']);

// SFTP status codes; ssh2 reports them as bare numbers (2 is NO_SUCH_FILE and
// goes through isNotFoundError, 4 is the generic FAILURE and is retried)
const SFTP_PERMISSION_DENIED = 3;
const SFTP_OP_UNSUPPORTED = 8;
// basic-ftp reports reply codes as numbers too; three digits tell them apart
const FTP_FIRST_REPLY_CODE = 100;
// "exceeded storage allocation": the one permanent negative reply the server
// may answer differently once it has made room
const FTP_EXCEEDED_STORAGE = 552;

/**
 * Whether an attempt that failed with `error` deserves another one.
 *
 * Retrying buys nothing against a permanent answer and, at 500 ms × attempt
 * per file, costs minutes on a batch the server refuses wholesale (FTP runs
 * one transfer at a time), so only what a moment later could succeed is
 * retried:
 *
 * - never: a cancelled transfer; permission denied (`EACCES`, `EPERM`, SFTP
 *   `3`); a path of the wrong kind (`EISDIR`, `ENOTDIR`); a read-only or
 *   unsupporting file system (`EROFS`, `ENOTSUP`, SFTP `8`); a source that is
 *   not there (`ENOENT`, SFTP `2`, FTP `550` or a "no such file" message
 *   while reaching the source: it will not come back); any other FTP
 *   permanent negative reply (`5xx`: `530`/`532` auth, `550` unavailable,
 *   `553` name not allowed...) except `552`.
 * - always: a failed verification ({@link ERROR_CODE_VERIFY}: bytes, size,
 *   hash, or a target not found after the upload); network errors and
 *   timeouts (`ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ECONNREFUSED`...); SFTP
 *   `4` FAILURE and every other SFTP status; FTP transient negative replies
 *   (`4xx`: `421`, `425`, `426`, `450`, `451`, `452`) and `552`; a target
 *   that went missing mid-transfer; and anything unknown.
 */
export function isRetryableTransferError(error: any, phase: TransferPhase): boolean {
  if (!error) {
    return true;
  }
  if (FileSystem.isAbortedError(error)) {
    return false;
  }

  const code = error.code;
  if (code === ERROR_CODE_VERIFY) {
    return true;
  }
  if (typeof code === 'string' && PERMANENT_ERROR_CODES.has(code)) {
    return false;
  }
  // a source that is gone will not come back; a target that vanished may
  if (phase === 'source' && isNotFoundError(error)) {
    return false;
  }
  if (typeof code === 'number') {
    if (code < FTP_FIRST_REPLY_CODE) {
      return code !== SFTP_PERMISSION_DENIED && code !== SFTP_OP_UNSUPPORTED;
    }
    if (code >= 500 && code < 600) {
      return code === FTP_EXCEEDED_STORAGE;
    }
  }
  return true;
}

// the message, plus the code when the message does not already carry it
// (ssh2's "Permission denied" says nothing about its status 3); a
// verification error spells its reason out and needs no suffix
function describeError(error: any): string {
  const message = String(error && error.message ? error.message : error);
  const code = error && error.code;
  if (code === ERROR_CODE_VERIFY) {
    return message;
  }
  if (
    (typeof code === 'string' && code !== '' && !message.includes(code)) ||
    (typeof code === 'number' && !message.includes(String(code)))
  ) {
    return `${message} (code ${code})`;
  }
  return message;
}

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
  // the check that was actually run: a 'hash' request that degraded reports 'stat'
  level: VerifyUploadLevel;
  ok: boolean;
  // why it failed, or why a 'hash' request was answered by 'stat'
  reason?: string;
  // digest the file was compared with, when level is 'hash'
  algorithm?: HashAlgorithm;
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
 * landed: every attempt measures the source again and counts the bytes handed
 * to the target against it, an upload is then checked against the server
 * according to {@link TransferOption.verifyUpload}, and a failed attempt is
 * retried with an increasing delay unless the task was cancelled or the error
 * is one no retry can fix ({@link isRetryableTransferError}). The outcome is
 * exposed through {@link verification}, {@link bytesTransferred},
 * {@link expectedSize} and {@link attempts}.
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
  // the error raised while reaching the source during the current attempt,
  // so run() can tell which side an error came from (see _phaseOf)
  private _sourceError: unknown;
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
        // the connection is gone, not the file: a retry would run against the
        // same dead client (the reconnection happens on the next getFs), so
        // the task gives up at once and the caller puts the batch on hold
        if (isConnectionLostError(error)) {
          logger.warn(`[transfer] connection lost while ${this.transferType} ${this.localFsPath}: ${describeError(error)}`);
          throw markConnectionLost(error);
        }
        if (!isRetryableTransferError(error, this._phaseOf(error))) {
          logger.warn(`[transfer] not retrying ${this.localFsPath}: ${describeError(error)}`);
          throw error;
        }

        logger.warn(
          `[transfer] retry ${attempt}/${retries} for ${this.localFsPath}: ${describeError(error)}`
        );
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
    this._sourceError = undefined;

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
      const level = this._verifyLevel();
      if (level === 'none') {
        this._verification = { level, ok: true };
      } else {
        // 'hash' builds on the size check: a wrong size needs no digest
        await this._verifyUpload(target, expectedSize, mtimeApplied);
        if (level === 'hash') {
          await this._verifyHash(target);
        }
      }

    } finally {
      await targetFs.close(uploadFd);
    }
  }

  private async _resolveExpectedSize(): Promise<number> {
    try {
      return await this._measureSource();
    } catch (error) {
      this._sourceError = error;
      throw error;
    }
  }

  // uploads lstat the local source on every attempt: it is cheap and, unlike
  // the size collected while listing, sees a file rewritten since then.
  // Downloads trust the collected size on the first attempt (over FTP a stat
  // is a SIZE or a LIST of the whole parent directory) and measure the source
  // again on every retry: a remote file that grew since the listing (a log, a
  // cache) would otherwise fail the byte count on every attempt although each
  // download was complete
  private _measureSource(): Promise<number> {
    const { size } = this._TransferOption;
    if (this._transferDirection === TransferDirection.REMOTE_TO_LOCAL) {
      if (this._attempts === 1 && typeof size === 'number') {
        return Promise.resolve(size);
      }
      return this._srcFs.statSize(this._srcFsPath);
    }

    return this._srcFs.lstat(this._srcFsPath).then(stat => stat.size);
  }

  // the error that reached run() is compared by identity with the one the
  // source raised: stat, get and the read stream all record theirs, the
  // target never does, so anything else belongs to the target side
  private _phaseOf(error: unknown): TransferPhase {
    return this._sourceError !== undefined && error === this._sourceError ? 'source' : 'target';
  }

  private async _openSource(): Promise<Readable> {
    let handle: Readable;
    try {
      handle = await this._srcFs.get(this._srcFsPath);
    } catch (error) {
      this._sourceError = error;
      throw error;
    }
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
      // a source that fails mid-stream is still a source-side failure (the
      // local open is lazy, so even a missing file can surface here)
      this._sourceError = err;
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

  // the digest is the only check that sees the content. When the server
  // cannot produce one, or fails to for this file, the upload is still as good
  // as 'stat' found it, so the level degrades instead of the upload failing;
  // only a digest that differs is a failure (and enters the retries)
  private async _verifyHash(target: string) {
    const targetFs = this._targetFs;
    let algorithm: HashAlgorithm | null;
    try {
      algorithm = await targetFs.supportsHash();
    } catch (error) {
      algorithm = null;
    }
    if (!algorithm) {
      this._degradeToStat('hash not available on this server, verified by size', true);
      return;
    }

    let local: string;
    let remote: string;
    try {
      [remote, local] = await Promise.all([
        targetFs.hashFile(target, algorithm),
        this._srcFs.hashFile(this._srcFsPath, algorithm),
      ]);
    } catch (error) {
      this._degradeToStat(`hash check failed (${error.message}), verified by size`, false);
      return;
    }

    if (remote !== local) {
      throw this._verificationError(
        `hash mismatch (${algorithm}: local ${local.slice(0, 8)}…, remote ${remote.slice(0, 8)}…)`,
        { algorithm }
      );
    }
    this._verification = { level: 'hash', ok: true, algorithm };
  }

  // the size check already passed when this is called; `once` keeps a server
  // that cannot hash at all from warning on every file of the batch
  private _degradeToStat(reason: string, once: boolean) {
    this._verification = { level: 'stat', ok: true, reason };
    if (once) {
      if (hasWarnedHashUnavailable.has(this._targetFs)) {
        return;
      }
      hasWarnedHashUnavailable.add(this._targetFs);
    }
    logger.warn(`[transfer] ${this.localFsPath}: ${reason}`);
  }

  private _verificationError(
    reason: string,
    extra: Partial<TransferVerification> = {}
  ): TransferVerificationError {
    this._verification = { level: this._verifyLevel(), ok: false, reason, ...extra };
    return new TransferVerificationError(reason, this.localFsPath);
  }

  // a server-side check only makes sense for uploads; downloads still count bytes
  private _verifyLevel(): VerifyUploadLevel {
    if (this._transferDirection !== TransferDirection.LOCAL_TO_REMOTE) {
      return 'none';
    }
    const { verifyUpload } = this._TransferOption;
    if (verifyUpload === 'none' || verifyUpload === 'hash') {
      return verifyUpload;
    }
    return DEFAULT_VERIFY_UPLOAD;
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
      }, retryBaseDelayMs * attempt);
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
