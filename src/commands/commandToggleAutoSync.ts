import { COMMAND_TOGGLE_AUTO_SYNC } from '../constants';
import { showInformationMessage, setContextValue } from '../host';
import { isPaused, togglePaused } from '../modules/syncControl';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_TOGGLE_AUTO_SYNC,

  async handleCommand() {
    const paused = togglePaused();
    // keeps `when: "sftp.autoSyncPaused"` in package.json in sync with the
    // module state, which is the only source of truth
    setContextValue('autoSyncPaused', isPaused());
    showInformationMessage(
      paused ? 'SFTP: automatic sync paused.' : 'SFTP: automatic sync resumed.'
    );
  },
});
