import { COMMAND_ACTIVITY_RETRY_ALL_FAILED } from '../constants';
import { showInformationMessage } from '../host';
import logger from '../logger';
import { getFailedEntries } from '../modules/activityLog';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_ACTIVITY_RETRY_ALL_FAILED,

  async handleCommand() {
    const failedEntries = getFailedEntries();
    if (failedEntries.length === 0) {
      showInformationMessage('SFTP: No hay operaciones fallidas para reintentar');
      return;
    }

    let retried = 0;
    let stillFailing = 0;
    // sequential on purpose: firing every retry at once would open as many
    // concurrent transfers as there are failures and starve the connection
    for (const entry of failedEntries) {
      if (!entry.retry) {
        continue;
      }

      try {
        await entry.retry();
        retried += 1;
      } catch (error) {
        stillFailing += 1;
        logger.error(error, `retry activity #${entry.id}`);
      }
    }

    showInformationMessage(`SFTP: ${retried} retried, ${stillFailing} still failing.`);
  },
});
