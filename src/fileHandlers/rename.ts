import * as path from 'path';
import { fileOperations, upath } from '../core';
import { toRemotePath, isNotFoundError } from '../helper';
import logger from '../logger';
import createFileHandler from './createFileHandler';
import { refreshRemoteExplorer } from './shared';
import { FileHandleOption } from './option';

interface RenameOption extends FileHandleOption {
  /** absolute local path the file was moved *from* */
  fromLocalPath: string;
  /** when the source doesn't exist remotely, upload instead of failing */
  uploadIfMissing?: boolean;
}

/**
 * Mirrors a local rename or move as a server-side rename.
 *
 * The handler context targets the *new* path; `fromLocalPath` is where the file
 * came from. Doing this as a rename rather than upload-then-delete keeps the
 * file's remote identity (permissions, ownership, inode) and leaves no window
 * where the path is missing on the server — which matters when the remote is a
 * live document root.
 */
export const renameRemote = createFileHandler<RenameOption>({
  name: 'rename',
  async handle(option) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const { remoteFsPath } = this.target;
    const fromRemotePath = toRemotePath(
      option.fromLocalPath,
      this.fileService.baseDir,
      this.config.remotePath
    );

    if (fromRemotePath === remoteFsPath) {
      return;
    }

    // a move can land in a directory that doesn't exist on the server yet
    const targetDir = upath.dirname(remoteFsPath);
    await remoteFs.ensureDir(targetDir);

    try {
      await fileOperations.rename(fromRemotePath, remoteFsPath, remoteFs);
    } catch (error) {
      // The source is missing remotely when the file was never uploaded, or
      // when a previous rename already moved it. Renaming is then pointless
      // but the new path still has to exist, so fall back to a plain upload.
      //
      // Only for a genuinely missing source: uploading after a *permission*
      // failure would leave both the old and the new path on the server and
      // report success, which is worse than surfacing the error.
      if (!option.uploadIfMissing || !isNotFoundError(error)) {
        throw error;
      }

      logger.info(
        `[rename] ${fromRemotePath} not found on the remote, uploading ${remoteFsPath} instead`
      );
      const localFs = this.fileService.getLocalFileSystem();
      const stat = await localFs.lstat(this.target.localFsPath);
      const handle = await localFs.get(this.target.localFsPath);
      await remoteFs.put(handle, remoteFsPath, { mode: stat.mode });
    }
  },
  transformOption() {
    return {
      ignore: this.config.ignore,
      uploadIfMissing: true,
    } as RenameOption;
  },
  afterHandle() {
    // both ends of the move changed; refresh the parent of the new path and
    // let the old one fall out on the next listing
    refreshRemoteExplorer(this.target, false);
  },
});

/** Local paths only — used to decide whether a rename crosses services. */
export function isSameDirectory(a: string, b: string): boolean {
  return path.dirname(a) === path.dirname(b);
}
