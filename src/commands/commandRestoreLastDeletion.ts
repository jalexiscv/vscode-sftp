import { COMMAND_RESTORE_LAST_DELETION } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { showInformationMessage, showConfirmMessage } from '../host';
import { getLastTrashEntries } from '../modules/remoteTrash';
import { reportError } from '../helper';
import { restoreEntry } from './commandRestoreFromTrash';

/**
 * Undo for the most recent deletion batch.
 *
 * Restores every entry of the batch rather than only the newest one: deleting
 * several files at once (a multi-select, a `rm` of a glob) produces one entry
 * each, and bringing back only one would leave the rest gone with no obvious
 * way to notice. A deleted *folder* is a single entry, since the monitor
 * collapses its children under it.
 */
export default checkCommand({
  id: COMMAND_RESTORE_LAST_DELETION,

  async handleCommand() {
    const entries = getLastTrashEntries();
    if (entries.length === 0) {
      showInformationMessage('SFTP: there is nothing to restore.');
      return;
    }

    const label =
      entries.length === 1
        ? entries[0].originalRemotePath
        : `${entries.length} files deleted together`;

    const confirmed = await showConfirmMessage(
      `SFTP: restore ${label} on the server?`,
      'Restore',
      'Cancel'
    );
    if (!confirmed) {
      return;
    }

    let restored = 0;
    const failures: string[] = [];
    for (const entry of entries) {
      try {
        await restoreEntry(entry);
        restored++;
      } catch (error) {
        failures.push(`${entry.originalRemotePath}: ${error.message}`);
      }
    }

    if (failures.length === 0) {
      showInformationMessage(`SFTP: restored ${restored} item(s).`);
      return;
    }

    reportError(
      new Error(
        `Restored ${restored} of ${entries.length} item(s). Failures:\n${failures.join('\n')}`
      ),
      'restore last deletion'
    );
  },
});
