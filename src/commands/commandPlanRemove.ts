import { COMMAND_PLAN_REMOVE } from '../constants';
import { showWarningMessage } from '../host';
import { isPlanRunning } from '../modules/planRunner';
import { removePlan } from '../modules/uploadPlan';
import { checkCommand } from './abstract/createCommand';
import { pickPlan } from './planShared';

export default checkCommand({
  id: COMMAND_PLAN_REMOVE,

  async handleCommand(arg?: unknown) {
    const plan = await pickPlan(arg, 'Select the upload plan to remove');
    if (!plan) {
      return;
    }

    if (isPlanRunning(plan.id)) {
      showWarningMessage(`SFTP: plan ${plan.id} is running; wait for it to finish before removing it.`);
      return;
    }

    removePlan(plan.id);
  },
});
