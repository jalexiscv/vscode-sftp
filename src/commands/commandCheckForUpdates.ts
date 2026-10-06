import { COMMAND_CHECK_FOR_UPDATES } from '../constants';
import { checkForUpdates } from '../modules/updateChecker';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_CHECK_FOR_UPDATES,

  // interactive: every outcome (nothing new, a failure, an offer) is said
  handleCommand() {
    return checkForUpdates({ silent: false });
  },
});
