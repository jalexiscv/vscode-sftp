import { COMMAND_RESTORE_FROM_TRASH } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { showQuickPick, showInformationMessage } from '../host';
import { getAllFileService } from '../modules/serviceManager';
import { getTrashEntries, restoreFromTrash, TrashEntry } from '../modules/remoteTrash';
import { simplifyPath, reportError } from '../helper';
import app from '../app';
import logger from '../logger';
import * as activityLog from '../modules/activityLog';

interface TrashPickItem {
  label: string;
  description: string;
  detail: string;
  entry: TrashEntry;
}

function formatWhen(timestamp: number): string {
  const when = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(when.getDate())}/${pad(when.getMonth() + 1)} ${pad(when.getHours())}:${pad(
    when.getMinutes()
  )}`;
}

export function findServiceForEntry(entry: TrashEntry) {
  return getAllFileService().find(service => service.baseDir === entry.serviceBaseDir);
}

export async function restoreEntry(entry: TrashEntry): Promise<void> {
  const fileService = findServiceForEntry(entry);
  if (!fileService) {
    throw new Error(
      `No configuration found for "${entry.serviceBaseDir}". ` +
        'The connection it was deleted from is no longer in sftp.json.'
    );
  }

  const config = fileService.getConfig();
  const activityId = activityLog.record({
    kind: activityLog.ActivityKind.Restore,
    localPath: entry.localPath,
    remotePath: entry.originalRemotePath,
    serviceName: fileService.name,
    profile: app.state.profile,
  });

  try {
    await restoreFromTrash(entry, fileService, config);
    activityLog.succeed(activityId);
  } catch (error) {
    activityLog.fail(activityId, error);
    throw error;
  }
}

export default checkCommand({
  id: COMMAND_RESTORE_FROM_TRASH,

  async handleCommand() {
    const entries = getTrashEntries();
    if (entries.length === 0) {
      showInformationMessage('SFTP: the remote trash is empty.');
      return;
    }

    const items: TrashPickItem[] = entries.map(entry => ({
      label: `$(${entry.isDirectory ? 'folder' : 'file'}) ${basename(entry.originalRemotePath)}`,
      description: formatWhen(entry.deletedAt),
      detail: entry.localPath ? simplifyPath(entry.localPath) : entry.originalRemotePath,
      entry,
    }));

    const picked = await showQuickPick(items, {
      placeHolder: 'Select a deleted file to restore on the server',
      matchOnDetail: true,
    });

    if (!picked) {
      return;
    }

    try {
      await restoreEntry(picked.entry);
      showInformationMessage(`SFTP: restored ${picked.entry.originalRemotePath}`);
    } catch (error) {
      reportError(error, 'restore from trash');
    }
  },
});

function basename(remotePath: string): string {
  const parts = remotePath.split('/');
  const name = parts[parts.length - 1];
  if (!name) {
    logger.debug(`[trash] unexpected remote path without a basename: ${remotePath}`);
  }
  return name || remotePath;
}
