import { COMMAND_ACTIVITY_CLEAR } from '../constants';
import { showConfirmMessage } from '../host';
import { clear } from '../modules/activityLog';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_ACTIVITY_CLEAR,

  async handleCommand() {
    const confirmed = await showConfirmMessage(
      'SFTP: clear the activity log?',
      'Clear',
      'Cancel'
    );
    if (!confirmed) {
      return;
    }

    clear();
  },
});
