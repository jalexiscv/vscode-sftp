import { COMMAND_MARK_LOCAL_TREE_UPLOADED } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { reportError } from '../helper';
import { markLocalTreeAsUploadedInteractive } from '../modules/externalChangeScanner';
import { pickService } from './shared';

export default checkCommand({
  id: COMMAND_MARK_LOCAL_TREE_UPLOADED,

  async handleCommand() {
    const service = await pickService('Select the connection whose local files to mark as uploaded');
    if (!service) {
      return;
    }

    try {
      await markLocalTreeAsUploadedInteractive(service);
    } catch (error) {
      reportError(error, 'mark local files as uploaded');
    }
  },
});
