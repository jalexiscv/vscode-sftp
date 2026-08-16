import { COMMAND_EMPTY_TRASH } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { showChoiceMessage, showInformationMessage } from '../host';
import { getAllFileService } from '../modules/serviceManager';
import { emptyTrash, getTrashEntries, listTrashRoots } from '../modules/remoteTrash';
import { reportError } from '../helper';

export default checkCommand({
  id: COMMAND_EMPTY_TRASH,

  async handleCommand() {
    const services = getAllFileService();
    if (services.length === 0) {
      showInformationMessage('SFTP: no configuration loaded.');
      return;
    }

    const pending = getTrashEntries().length;
    // one root per profile that has entries: a trash configured per profile
    // lives on a different server, and the dialog must name all of them
    const roots: string[] = [];
    services.forEach(service => {
      listTrashRoots(service).forEach(root => {
        if (roots.indexOf(root) === -1) {
          roots.push(root);
        }
      });
    });

    if (roots.length === 0) {
      showInformationMessage('SFTP: no reachable trash folder to empty.');
      return;
    }

    const choice = await showChoiceMessage(
      `SFTP: permanently delete the remote trash?\n\n` +
        `${pending} tracked item(s) will become unrecoverable.\n` +
        `Folders to be removed:\n${roots.map(r => `  • ${r}`).join('\n')}`,
      ['Empty trash', 'Cancel'],
      { modal: true, warning: true }
    );

    if (choice !== 'Empty trash') {
      return;
    }

    for (const service of services) {
      try {
        await emptyTrash(service);
      } catch (error) {
        reportError(error, `when emptying the trash of ${service.name || service.baseDir}`);
      }
    }

    showInformationMessage('SFTP: remote trash emptied.');
  },
});
