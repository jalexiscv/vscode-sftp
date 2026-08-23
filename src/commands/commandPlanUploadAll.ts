import { COMMAND_PLAN_UPLOAD_ALL } from '../constants';
import { reportError } from '../helper';
import { showInformationMessage, showWarningMessage } from '../host';
import { isPlanRunning, runPlan } from '../modules/planRunner';
import { formatSummary, summarize } from '../modules/uploadPlan';
import { checkCommand } from './abstract/createCommand';
import { pickPlan } from './planShared';

export default checkCommand({
  id: COMMAND_PLAN_UPLOAD_ALL,

  async handleCommand(arg?: unknown) {
    const plan = await pickPlan(arg, 'Select the upload plan to run');
    if (!plan) {
      return;
    }

    if (isPlanRunning(plan.id)) {
      showWarningMessage(`SFTP: plan ${plan.id} is already running.`);
      return;
    }

    const before = summarize(plan);
    if (before.pending + before.failed + before.stale === 0) {
      showInformationMessage(`SFTP: plan ${plan.id} has nothing left to upload.`);
      return;
    }

    try {
      const summary = await runPlan(plan.id);
      const message = `SFTP: plan ${plan.id} finished — ${formatSummary(summary)}.`;
      if (summary.failed > 0) {
        showWarningMessage(message);
      } else {
        showInformationMessage(message);
      }
    } catch (error) {
      reportError(error, 'upload plan');
    }
  },
});
