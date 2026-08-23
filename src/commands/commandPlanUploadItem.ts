import { COMMAND_PLAN_UPLOAD_ITEM } from '../constants';
import { reportError } from '../helper';
import { showWarningMessage } from '../host';
import { runPlan } from '../modules/planRunner';
import { checkCommand } from './abstract/createCommand';
import { planItemFromArg } from './planShared';

export default checkCommand({
  id: COMMAND_PLAN_UPLOAD_ITEM,

  async handleCommand(arg?: unknown) {
    const resolved = planItemFromArg(arg);
    if (!resolved) {
      // only reachable from the plan item's context menu; the palette hides it
      showWarningMessage('SFTP: select a file of an upload plan in the Activity view first.');
      return;
    }

    const { plan, item } = resolved;
    if (item.status === 'uploading') {
      showWarningMessage(`SFTP: ${item.localPath} is being uploaded already.`);
      return;
    }

    try {
      // the outcome shows in the tree: the item's icon and status move as it runs
      await runPlan(plan.id, { itemPaths: [item.localPath] });
    } catch (error) {
      reportError(error, 'upload plan item');
    }
  },
});
