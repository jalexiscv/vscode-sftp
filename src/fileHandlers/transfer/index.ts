import { TransferResult, TransferFailedError, FileSystem, FileType } from '../../core';
import { markReported, simplifyPath } from '../../helper';
import { showInformationMessage } from '../../host';
import logger from '../../logger';
import { suppressAutoSync } from '../../modules/syncControl';
import { refreshRemoteExplorer } from '../shared';
import createFileHandler, { FileHandlerContext } from '../createFileHandler';
import { transfer, sync, TransferOption, SyncOption, TransferDirection } from './transfer';

type TransferAction = 'upload' | 'download' | 'sync';

/**
 * Whether the target of an upload handler is itself kept off the server by
 * `uploadExclude`. Stat'ed so a `dir/` pattern can match a folder target; a
 * target that does not exist is left to transfer() to report.
 */
async function isTargetUploadExcluded(
  localFs: FileSystem,
  localFsPath: string,
  option: TransferOption
): Promise<boolean> {
  if (!option.uploadExclude) {
    return false;
  }

  let isDirectory = false;
  try {
    const stat = await localFs.lstat(localFsPath);
    isDirectory = stat.type === FileType.Directory;
  } catch (error) {
    return false;
  }
  return option.uploadExclude(localFsPath, isDirectory);
}

/**
 * Turns a batch with failures into a rejection, so a handler can no longer
 * resolve after a failed put. Cancelled tasks are not failures.
 *
 * Each failed task was already reported by the service's `afterTransfer` hook,
 * so the aggregate is flagged as reported: callers log it, they do not show
 * it again.
 */
function assertTransferSucceeded(result: TransferResult, action: TransferAction) {
  if (result.failed.length === 0) {
    return;
  }

  const total = result.succeeded.length + result.failed.length + result.cancelled.length;
  const error = new TransferFailedError(result.failed, total, action);
  if (result.connectionLost) {
    // the per-file hook stays quiet for a lost connection (every task in
    // flight fails with it), so this aggregate is the one notice the user
    // gets: it is not flagged as reported, and it says the rest was not tried
    error.message =
      `Connection lost while trying to ${action} (${result.connectionLost.message}): ` +
      `${result.succeeded.length} done, ${result.failed.length} interrupted; ` +
      'the remaining files were not attempted. Run the command again once the server is back.';
    throw error;
  }
  throw markReported(error);
}

function createTransferHandle(direction: TransferDirection) {
  async function run(this: FileHandlerContext, option) {
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;

    // Before connecting: nothing would be sent. The automatic paths (save,
    // watcher, scan) filter excluded paths before they get here, so what
    // reaches this point was asked for explicitly and deserves an answer.
    if (
      direction === TransferDirection.LOCAL_TO_REMOTE &&
      (await isTargetUploadExcluded(localFs, localFsPath, option))
    ) {
      logger.info(`[upload] ${localFsPath} skipped: excluded from upload by uploadExclude`);
      showInformationMessage(
        `SFTP: ${simplifyPath(localFsPath)} is excluded from upload (uploadExclude). ` +
          'Use "Force Upload" to send it anyway.'
      );
      return;
    }

    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const scheduler = this.fileService.createTransferScheduler(this.config.concurrency);
    let transferConfig;

    if (direction === TransferDirection.REMOTE_TO_LOCAL) {
      transferConfig = {
        srcFsPath: remoteFsPath,
        srcFs: remoteFs,
        targetFsPath: localFsPath,
        targetFs: localFs,
        transferOption: option,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
      };
    } else {
      transferConfig = {
        srcFsPath: localFsPath,
        srcFs: localFs,
        targetFsPath: remoteFsPath,
        targetFs: remoteFs,
        transferOption: option,
        filePerm: this.config.filePerm,
        dirPerm: this.config.dirPerm,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      };
    }
    // todo: abort at here. we should stop collect task
    await transfer(transferConfig, t => scheduler.add(t));
    const result = await scheduler.run();
    assertTransferSucceeded(
      result,
      direction === TransferDirection.REMOTE_TO_LOCAL ? 'download' : 'upload'
    );
  }

  if (direction === TransferDirection.LOCAL_TO_REMOTE) {
    return run;
  }

  // A download writes local files the watcher and uploadOnSave would otherwise
  // see as the user's own edits and push straight back to the server. Uploads
  // are not wrapped: suppressing them would swallow real saves made meanwhile.
  return function handle(this: FileHandlerContext, option) {
    return suppressAutoSync(() => run.call(this, option));
  };
}

const uploadHandle = createTransferHandle(TransferDirection.LOCAL_TO_REMOTE);
const downloadHandle = createTransferHandle(TransferDirection.REMOTE_TO_LOCAL);

export const sync2Remote = createFileHandler<SyncOption>({
  name: 'sync local ➞ remote',
  handle(option) {
    const run = async () => {
      const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
      const localFs = this.fileService.getLocalFileSystem();
      const { localFsPath, remoteFsPath } = this.target;
      const scheduler = this.fileService.createTransferScheduler(this.config.concurrency);
      // Attach filePerm and dirPerm to transferOption
      option.filePerm = this.config.filePerm;
      option.dirPerm = this.config.dirPerm;
      await sync(
        {
          srcFsPath: localFsPath,
          srcFs: localFs,
          targetFsPath: remoteFsPath,
          targetFs: remoteFs,
          transferOption: option,
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        },
        t => scheduler.add(t)
      );
      const result = await scheduler.run();
      assertTransferSucceeded(result, option.bothDiretions ? 'sync' : 'upload');
    };

    // both directions also downloads, and those writes must not be mirrored
    // back; a plain local -> remote sync writes nothing locally
    return option.bothDiretions ? suppressAutoSync(run) : run();
  },
  transformOption() {
    const config = this.config;
    const syncOption = config.syncOption || {};
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      verifyUpload: config.verifyUpload,
      retries: config.uploadRetries,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      uploadExclude: config.uploadExclude,
      delete: syncOption.delete,
      skipCreate: syncOption.skipCreate,
      ignoreExisting: syncOption.ignoreExisting,
      update: syncOption.update,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, true);
  },
});

export const sync2Local = createFileHandler<SyncOption>({
  name: 'sync remote ➞ local',
  handle(option) {
    // everything this writes (and, with syncOption.delete, removes) locally is
    // the extension's doing, not an edit to upload or a deletion to mirror
    return suppressAutoSync(async () => {
      const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
      const localFs = this.fileService.getLocalFileSystem();
      const { localFsPath, remoteFsPath } = this.target;
      const scheduler = this.fileService.createTransferScheduler(this.config.concurrency);
      await sync(
        {
          srcFsPath: remoteFsPath,
          srcFs: remoteFs,
          targetFsPath: localFsPath,
          targetFs: localFs,
          transferOption: option,
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        },
        t => scheduler.add(t)
      );
      const result = await scheduler.run();
      assertTransferSucceeded(result, option.bothDiretions ? 'sync' : 'download');
    });
  },
  transformOption() {
    const config = this.config;
    const syncOption = config.syncOption || {};
    return {
      perserveTargetMode: false,
      retries: config.uploadRetries,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      delete: syncOption.delete,
      skipCreate: syncOption.skipCreate,
      ignoreExisting: syncOption.ignoreExisting,
      update: syncOption.update,
    };
  },
});

export const upload = createFileHandler<TransferOption>({
  name: 'upload',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      verifyUpload: config.verifyUpload,
      retries: config.uploadRetries,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      uploadExclude: config.uploadExclude,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, this.fileService);
  },
});

export const uploadFile = createFileHandler<TransferOption>({
  name: 'upload file',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      verifyUpload: config.verifyUpload,
      retries: config.uploadRetries,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      uploadExclude: config.uploadExclude,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});

export const uploadFolder = createFileHandler<TransferOption>({
  name: 'upload folder',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      verifyUpload: config.verifyUpload,
      retries: config.uploadRetries,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      uploadExclude: config.uploadExclude,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, true);
  },
});

export const download = createFileHandler<TransferOption>({
  name: 'download',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      retries: config.uploadRetries,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
});

export const downloadFile = createFileHandler<TransferOption>({
  name: 'download file',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      retries: config.uploadRetries,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
});

export const downloadFolder = createFileHandler<TransferOption>({
  name: 'download folder',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      retries: config.uploadRetries,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
});
