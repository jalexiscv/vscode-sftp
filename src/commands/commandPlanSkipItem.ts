import { COMMAND_PLAN_SKIP_ITEM } from '../constants';
import { reportError } from '../helper';
import { showWarningMessage } from '../host';
import { skipItem } from '../modules/planRunner';
import { checkCommand } from './abstract/createCommand';
import { planItemFromArg } from './planShared';

export default checkCommand({
  id: COMMAND_PLAN_SKIP_ITEM,

  async handleCommand(arg?: unknown) {
    const resolved = planItemFromArg(arg);
    if (!resolved) {
      // only reachable from the plan item's context menu; the palette hides it
      showWarningMessage('SFTP: select a file of an upload plan in the Activity view first.');
      return;
    }

    const { plan, item } = resolved;
    if (item.status !== 'pending' && item.status !== 'failed' && item.status !== 'stale') {
      showWarningMessage(`SFTP: a ${item.status} item cannot be skipped.`);
      return;
    }

    try {
      skipItem(plan.id, item.localPath);
    } catch (error) {
      reportError(error, 'skip plan item');
    }
  },
});
