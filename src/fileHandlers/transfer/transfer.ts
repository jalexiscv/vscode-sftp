import {
  FileSystem,
  FileEntry,
  FileType,
  TransferTask,
  TransferOption as TransferTaskTransferOption,
  TransferDirection,
  fileOperations,
} from '../../core';
import { FileHandleOption } from '../option';
import { flatten } from '../../utils';
import logger from '../../logger';
import { getOpenTextDocuments } from '../../host';

interface InternalTransferOption extends FileHandleOption, TransferTaskTransferOption {}

type ExternalTransferOption<T extends InternalTransferOption> = Pick<
  T,
  Exclude<keyof T, 'mtime' | 'atime' | 'size' | 'mode' | 'fallbackMode'>
>;

type TransferOption = ExternalTransferOption<InternalTransferOption>;
interface SyncOption extends TransferOption {
  // delete extraneous files from dest dirs
  delete?: boolean;

  // skip creating new files on dest
  skipCreate?: boolean;

  // skip updating files that exist on dest
  ignoreExisting?: boolean;

  // update the dest only if a newer version is on the src filesystem
  update?: boolean;

  // make newest file to be present in both locations.
  bothDiretions?: boolean;
}

interface BaseTransferHandleConfig {
  srcFsPath: string;
  targetFsPath: string;
  dirPerm?: number;
  filePerm?: number;
  srcFs: FileSystem;
  targetFs: FileSystem;
  transferDirection: TransferDirection;
}

interface TransferHandleConfig<T> extends BaseTransferHandleConfig {
  transferOption: T;
}

function getAltDirection(direction: TransferDirection) {
  return direction === TransferDirection.LOCAL_TO_REMOTE
    ? TransferDirection.REMOTE_TO_LOCAL
    : TransferDirection.LOCAL_TO_REMOTE;
}

// remote filesystems routinely report mtime with a one second resolution, so
// every comparison in this file has to happen at that granularity
function mtimeInSeconds(entry: FileEntry): number {
  return Math.floor(entry.mtime / 1000);
}

function isFileModified(a: FileEntry, b: FileEntry): boolean {
  // compare time at seconds
  return mtimeInSeconds(a) !== mtimeInSeconds(b) || a.size !== b.size;
}

function toHash<T, R = T>(items: T[], key: string, transform?: (a: T) => R): { [key: string]: R } {
  return items.reduce((hash, item) => {
    const transformedItem = transform ? transform(item) : item;
    hash[transformedItem[key]] = transformedItem;
    return hash;
  }, {});
}

async function transferFolder(
  config: TransferHandleConfig<TransferOption>,
  collect: (t: TransferTask) => void
) {
  const { srcFsPath, targetFsPath, srcFs, targetFs, transferOption } = config;

  if (transferOption.ignore && transferOption.ignore(srcFsPath)) {
    return;
  }

  // Need this to make sure file can correct transfer
  await targetFs.ensureDir(targetFsPath);

  // If dirPerm is configured, we chmod the remote directory after creation.
  if(config.transferOption.dirPerm) {
    logger.info('chmod remote directory as configured by dirPerm, dirPerm is: ', config.transferOption.dirPerm);
    // awaited so a failure can't surface as an unhandled rejection, but not
    // fatal: over FTP this is `SITE CHMOD`, which plenty of servers reject.
    // The directory is already there, so keep transferring into it.
    await targetFs
      .chmod(targetFsPath, parseInt(String(config.transferOption.dirPerm), 8))
      .catch(error => logger.warn(`chmod ${targetFsPath} failed: ${error.message}`));
  }

  const fileEntries = await srcFs.list(srcFsPath);
  await Promise.all(
    fileEntries.map(file =>
      transferWithType(
        {
          ...config,
          transferOption: {
            ...config.transferOption,
            mtime: file.mtime,
            atime: file.atime,
            size: file.size,
          },
          srcFsPath: file.fspath,
          targetFsPath: targetFs.pathResolver.join(targetFsPath, file.name),
          ensureDirExist: false,
        },
        file.type,
        collect
      )
    )
  );

  logger.info('folder transfered.');
}

async function transferFile(
  config: TransferHandleConfig<InternalTransferOption>,
  fileType: FileType,
  collect: (t: TransferTask) => void
) {
  if (config.transferOption.ignore && config.transferOption.ignore(config.srcFsPath)) {
    return;
  }

  collect(
    new TransferTask(
      {
        fsPath: config.srcFsPath,
        fileSystem: config.srcFs,
      },
      {
        fsPath: config.targetFsPath,
        fileSystem: config.targetFs,
      },
      {
        fileType,
        transferDirection: config.transferDirection,
        transferOption: config.transferOption,
      }
    )
  );
}

async function transferWithType(
  config: TransferHandleConfig<InternalTransferOption> & {
    ensureDirExist: boolean;
  },
  fileType: FileType,
  collect: (t: TransferTask) => void
) {
  switch (fileType) {
    case FileType.Directory:
      await transferFolder(config, collect);
      break;
    case FileType.File:
    case FileType.SymbolicLink:
      if (config.ensureDirExist) {
        const { targetFs, targetFsPath } = config;
        await targetFs.ensureDir(targetFs.pathResolver.dirname(targetFsPath));
        // If dirPerm is configured, we chmod the remote directory after creation.
        if(config.transferOption.dirPerm) {
          logger.info('Running chmod on remote directory with perm: ', config.transferOption.dirPerm);
          const dirFsPath = targetFs.pathResolver.dirname(targetFsPath);
          // see transferFolder: awaited so nothing is left dangling, non-fatal
          // because FTP servers commonly refuse `SITE CHMOD`.
          await targetFs
            .chmod(dirFsPath, parseInt(String(config.transferOption.dirPerm), 8))
            .catch(error => logger.warn(`chmod ${dirFsPath} failed: ${error.message}`));
        }
      }
      // <<< save before upload: start
      if (config.transferDirection === TransferDirection.LOCAL_TO_REMOTE) {
        const textDocuments = getOpenTextDocuments();
        const document = textDocuments.find(doc => doc.fileName === config.srcFsPath);
        if (document && !document.isClosed && document.isDirty) {
          await document.save();
          // Update mtime and size after file was saved
          const stat = await config.srcFs.lstat(config.srcFsPath);
          config.transferOption.mtime = stat.mtime;
          config.transferOption.size = stat.size;
          logger.info('save before upload.');
        }
      }
      // save before upload: end >>>
      transferFile(config, fileType, collect);
      break;
    default:
      logger.warn(`Unsupported file type (type = ${fileType}). File ${config.srcFsPath}`);
  }
}

async function removeFile(file: string, fs: FileSystem, fileType: FileType, option) {
  if (option.ignore && option.ignore(file)) {
    return;
  }

  switch (fileType) {
    case FileType.Directory:
      await fileOperations.removeDir(file, fs, option);
      logger.info('folder removed.');
      break;
    case FileType.File:
    case FileType.SymbolicLink:
      await fileOperations.removeFile(file, fs, option);
      logger.info('file removed.');
      break;
    default:
      break;
  }
}

async function _sync(
  config: TransferHandleConfig<SyncOption>,
  collect: (t: TransferTask) => void,
  deleted: FileEntry[]
) {

  const { srcFsPath, targetFsPath, srcFs, targetFs, transferOption, transferDirection } = config;
  if (transferOption.ignore && transferOption.ignore(srcFsPath)) {
    return;
  }

  const altDirection = getAltDirection(transferDirection);
  const syncFiles = (srcFileEntries: FileEntry[], desFileEntries: FileEntry[]) => {
    const srcFileTable = toHash(srcFileEntries, 'id', fileEntry => ({
      ...fileEntry,
      id: fileEntry.name,
    }));

    const desFileTable = toHash(desFileEntries, 'id', fileEntry => ({
      ...fileEntry,
      id: fileEntry.name,
    }));

    const file2trans: [string, string, TransferDirection, InternalTransferOption][] = [];
    const dir2trans: [string, string][] = [];
    const dir2sync: [string, string][] = [];

    const fileMissed: string[] = [];
    const dirMissed: string[] = [];

    Object.keys(srcFileTable).forEach(id => {
      const srcFile = srcFileTable[id];
      const desFile = desFileTable[id];
      delete desFileTable[id];

      // files exist on both side
      if (desFile) {
        if (transferOption.ignoreExisting) {
          return;
        }

        let from: FileEntry = srcFile;
        let to: FileEntry = desFile;
        let direction: TransferDirection = transferDirection;
        switch (from.type) {
          case FileType.Directory:
            dir2sync.push([from.fspath, to.fspath]);
            break;
          case FileType.File:
          case FileType.SymbolicLink:
            if (transferOption.bothDiretions) {
              // from new to old
              if (desFile.mtime > srcFile.mtime) {
                from = desFile;
                to = srcFile;
                direction = altDirection;
              }
            }

            if (transferOption.update) {
              // seconds, like isFileModified: comparing raw milliseconds here
              // made a file "newer" by sub-second noise the remote can't even
              // represent, so it was re-transferred on every sync
              if (mtimeInSeconds(from) <= mtimeInSeconds(to)) {
                return;
              }
            }

            // only transfer changed files
            if (isFileModified(from, to)) {
              file2trans.push([
                from.fspath,
                to.fspath,
                direction,
                {
                  ...transferOption,
                  mode: to.mode, // prefer target mode
                  mtime: from.mtime,
                  atime: from.atime,
                  size: from.size,
                },
              ]);
            }
            break;
          default:
          // do not process
        }
        return;
      }

      // files exist only on src
      if (transferOption.skipCreate) {
        return;
      }

      const fspath = targetFs.pathResolver.join(targetFsPath, srcFile.name);
      switch (srcFile.type) {
        case FileType.Directory:
          dir2trans.push([srcFile.fspath, fspath]);
          break;
        case FileType.File:
        case FileType.SymbolicLink:
          file2trans.push([
            srcFile.fspath,
            fspath,
            transferDirection,
            {
              ...transferOption,
              fallbackMode: srcFile.mode,
              mtime: srcFile.mtime,
              atime: srcFile.atime,
              size: srcFile.size,
            },
          ]);
          break;
        default:
        // do not process
      }
    });

    // files exist only on target
    if (transferOption.bothDiretions) {
      if (transferOption.skipCreate !== true) {
        Object.keys(desFileTable).forEach(id => {
          const file = desFileTable[id];
          const fspath = srcFs.pathResolver.join(srcFsPath, file.name);
          switch (file.type) {
            case FileType.Directory:
              dir2trans.push([file.fspath, fspath]);
              break;
            case FileType.File:
            case FileType.SymbolicLink:
              file2trans.push([
                file.fspath,
                fspath,
                altDirection,
                {
                  ...transferOption,
                  fallbackMode: file.mode,
                  mtime: file.mtime,
                  atime: file.atime,
                  size: file.size,
                },
              ]);
              break;
            default:
            // do not process
          }
        });
      }
    } else if (transferOption.delete) {
      Object.keys(desFileTable).forEach(id => {
        const file = desFileTable[id];
        // `deleted` is what sync() reports back to the caller, so it may only
        // hold entries that are really going to be removed. removeFile skips
        // ignored paths and unsupported types, so the push has to happen after
        // the same checks, not before them.
        if (transferOption.ignore && transferOption.ignore(file.fspath)) {
          return;
        }

        switch (file.type) {
          case FileType.Directory:
            deleted.push(file);
            dirMissed.push(file.fspath);
            break;
          case FileType.File:
          case FileType.SymbolicLink:
            deleted.push(file);
            fileMissed.push(file.fspath);
            break;
          default:
          // do not process
        }
      });
    }

    // side-effect. Awaited together with the transfers below: a removal that
    // outlives the command would report success before the server is done.
    const removePromise = fileMissed
      .map(file => removeFile(file, targetFs, FileType.File, transferOption))
      .concat(dirMissed.map(file => removeFile(file, targetFs, FileType.Directory, transferOption)));

    const transFilePromise = file2trans.map(([src, target, direction, option]) =>
      transferFile(
        {
          ...config,
          transferDirection: direction,
          transferOption: option,
          srcFsPath: src,
          targetFsPath: target,
        },
        FileType.File,
        collect
      )
    );

    const transDirPromise = dir2trans.map(([src, target]) =>
      transferFolder(
        {
          ...config,
          srcFsPath: src,
          targetFsPath: target,
        },
        collect
      )
    );

    const syncPromise = dir2sync.map(([src, target]) =>
      _sync(
        {
          ...config,
          srcFsPath: src,
          targetFsPath: target,
        },
        collect,
        deleted
      )
    );

    return Promise.all([
      ...removePromise,
      ...transFilePromise,
      ...transDirPromise,
      ...syncPromise,
    ]).then(flatten);
  };

  // create dir here so we don't have to ensure it for children files.
  await targetFs.ensureDir(targetFsPath);

  // A failed listing is not an empty directory. Swallowing the error made a
  // transient network failure on the source look like "everything is gone",
  // which with `delete` on wipes the whole destination; on the target side it
  // silently re-transfers the tree. A propagated error is reported once and
  // the user retries, which is the only recoverable outcome of the three.
  const files = await Promise.all([srcFs.list(srcFsPath), targetFs.list(targetFsPath)]);
  await syncFiles(...files);
}

export { TransferOption, SyncOption, TransferDirection };

export interface TransferCallOptions {
  ensureDirExist?: boolean; // default true
}

export async function transfer(
  config: TransferHandleConfig<TransferOption>,
  collect: (t: TransferTask) => void,
  options?: TransferCallOptions
): Promise<void> {
  const stat = await config.srcFs.lstat(config.srcFsPath);
  const transferOption = {
    ...config.transferOption,
    fallbackMode: stat.mode,
    mtime: stat.mtime,
    atime: stat.atime,
    size: stat.size,
    filePerm: config?.filePerm,
    dirPerm: config?.dirPerm,
  };
  await transferWithType(
    {
      ...config,
      transferOption,
      ensureDirExist: options && options.ensureDirExist === false ? false : true,
    },
    stat.type,
    collect
  );
}

export async function sync(
  config: TransferHandleConfig<SyncOption>,
  collect: (t: TransferTask) => void
): Promise<FileEntry[]> {
  const deleted: FileEntry[] = [];
  await _sync(config, collect, deleted);
  return deleted;
}
