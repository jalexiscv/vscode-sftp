import { COMMAND_REBUILD_SYNC_INDEX } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { reportError } from '../helper';
import { rebuildSyncIndexInteractive } from '../modules/externalChangeScanner';
import { pickService } from './shared';

export default checkCommand({
  id: COMMAND_REBUILD_SYNC_INDEX,

  async handleCommand() {
    const service = await pickService('Select the connection whose sync index to rebuild');
    if (!service) {
      return;
    }

    try {
      await rebuildSyncIndexInteractive(service);
    } catch (error) {
      reportError(error, 'rebuild sync index');
    }
  },
});
