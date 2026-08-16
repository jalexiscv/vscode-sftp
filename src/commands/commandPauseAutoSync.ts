import { COMMAND_PAUSE_AUTO_SYNC } from '../constants';
import { showInformationMessage, setContextValue } from '../host';
import { isPaused, setPaused } from '../modules/syncControl';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_PAUSE_AUTO_SYNC,

  async handleCommand() {
    setPaused(true);
    // keeps `when: "sftp.autoSyncPaused"` in package.json in sync with the
    // module state, which is the only source of truth
    setContextValue('autoSyncPaused', isPaused());
    showInformationMessage('SFTP: automatic sync paused.');
  },
});
