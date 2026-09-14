import { COMMAND_PLAN_MARK_ITEM_UPLOADED } from '../constants';
import { reportError } from '../helper';
import { showWarningMessage } from '../host';
import { markAsUploaded } from '../modules/planRunner';
import { checkCommand } from './abstract/createCommand';
import { planItemFromArg } from './planShared';

export default checkCommand({
  id: COMMAND_PLAN_MARK_ITEM_UPLOADED,

  async handleCommand(arg?: unknown) {
    const resolved = planItemFromArg(arg);
    if (!resolved) {
      // only reachable from the plan item's context menu; the palette hides it
      showWarningMessage('SFTP: select a file of an upload plan in the Activity view first.');
      return;
    }

    const { plan, item } = resolved;
    if (item.status !== 'pending' && item.status !== 'failed' && item.status !== 'stale') {
      showWarningMessage(`SFTP: a ${item.status} item cannot be marked as uploaded.`);
      return;
    }

    try {
      // the outcome shows in the tree: the item settles as "assumed"
      await markAsUploaded(plan.id, [item.localPath]);
    } catch (error) {
      reportError(error, 'mark plan item as uploaded');
    }
  },
});
