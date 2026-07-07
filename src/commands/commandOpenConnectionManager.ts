import { COMMAND_OPEN_CONNECTION_MANAGER } from '../constants';
import { openConnectionManager } from '../modules/connectionManager';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_OPEN_CONNECTION_MANAGER,

  handleCommand() {
    openConnectionManager();
  },
});
