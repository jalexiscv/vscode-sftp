import { COMMAND_PLAN_CLEAR_ALL } from '../constants';
import { showConfirmMessage, showInformationMessage, showWarningMessage } from '../host';
import { isPlanRunning } from '../modules/planRunner';
import { clearPlans, getPlans, removePlan } from '../modules/uploadPlan';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_PLAN_CLEAR_ALL,

  async handleCommand() {
    const plans = getPlans();
    if (plans.length === 0) {
      showInformationMessage('SFTP: there are no upload plans to clear.');
      return;
    }

    const confirmed = await showConfirmMessage(
      `SFTP: clear ${plans.length} upload plan(s)? Their reports will be lost.`,
      'Clear',
      'Cancel'
    );
    if (!confirmed) {
      return;
    }

    // a running plan is still being written to by the runner; dropping it
    // would orphan the updates, so it stays and the user is told
    const running = plans.filter(plan => isPlanRunning(plan.id));
    if (running.length === 0) {
      clearPlans();
      return;
    }

    plans.forEach(plan => {
      if (running.indexOf(plan) === -1) {
        removePlan(plan.id);
      }
    });
    showWarningMessage(
      `SFTP: ${running.length} running plan(s) were kept; the other ${plans.length - running.length} were cleared.`
    );
  },
});
