import { FileSystem, FileType } from '../../core';
import { simplifyPath } from '../../helper';
import { showInformationMessage } from '../../host';
import logger from '../../logger';
import { suppressAutoSync } from '../../modules/syncControl';
import { refreshRemoteExplorer } from '../shared';
import createFileHandler, { FileHandlerContext } from '../createFileHandler';
import { transfer, sync, TransferOption, SyncOption, TransferDirection } from './transfer';
import { runResumable } from './resume';

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

    // a lost connection holds the command and walks the target again over a
    // fresh connection, skipping what already went through (see ./resume)
    await runResumable<TransferOption>({
      ctx: this,
      action: direction === TransferDirection.REMOTE_TO_LOCAL ? 'download' : 'upload',
      option,
      walk: (remoteFs, attemptOption, collect) => {
        let transferConfig;
        if (direction === TransferDirection.REMOTE_TO_LOCAL) {
          transferConfig = {
            srcFsPath: remoteFsPath,
            srcFs: remoteFs,
            targetFsPath: localFsPath,
            targetFs: localFs,
            transferOption: attemptOption,
            transferDirection: TransferDirection.REMOTE_TO_LOCAL,
          };
        } else {
          transferConfig = {
            srcFsPath: localFsPath,
            srcFs: localFs,
            targetFsPath: remoteFsPath,
            targetFs: remoteFs,
            transferOption: attemptOption,
            filePerm: this.config.filePerm,
            dirPerm: this.config.dirPerm,
            transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          };
        }
        // todo: abort at here. we should stop collect task
        return transfer(transferConfig, collect);
      },
    });
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
      const localFs = this.fileService.getLocalFileSystem();
      const { localFsPath, remoteFsPath } = this.target;
      // Attach filePerm and dirPerm to transferOption
      option.filePerm = this.config.filePerm;
      option.dirPerm = this.config.dirPerm;
      await runResumable<SyncOption>({
        ctx: this,
        action: option.bothDiretions ? 'sync' : 'upload',
        option,
        walk: (remoteFs, attemptOption, collect) =>
          sync(
            {
              srcFsPath: localFsPath,
              srcFs: localFs,
              targetFsPath: remoteFsPath,
              targetFs: remoteFs,
              transferOption: attemptOption,
              transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            },
            collect
          ).then(() => undefined),
      });
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
      const localFs = this.fileService.getLocalFileSystem();
      const { localFsPath, remoteFsPath } = this.target;
      await runResumable<SyncOption>({
        ctx: this,
        action: option.bothDiretions ? 'sync' : 'download',
        option,
        walk: (remoteFs, attemptOption, collect) =>
          sync(
            {
              srcFsPath: remoteFsPath,
              srcFs: remoteFs,
              targetFsPath: localFsPath,
              targetFs: localFs,
              transferOption: attemptOption,
              transferDirection: TransferDirection.REMOTE_TO_LOCAL,
            },
            collect
          ).then(() => undefined),
      });
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
