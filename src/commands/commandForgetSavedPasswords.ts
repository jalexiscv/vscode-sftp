import { COMMAND_FORGET_SAVED_PASSWORDS } from '../constants';
import { clearSavedPasswords } from '../modules/savedPasswords';
import { showInformationMessage } from '../host';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_FORGET_SAVED_PASSWORDS,

  async handleCommand() {
    const removed = await clearSavedPasswords();
    showInformationMessage(
      removed > 0
        ? `SFTP: ${removed} saved password(s) removed.`
        : 'SFTP: there are no saved passwords.'
    );
  },
});
