import { COMMAND_PLAN_MARK_UPLOADED } from '../constants';
import { reportError } from '../helper';
import { showChoiceMessage, showInformationMessage, showWarningMessage } from '../host';
import { isPlanRunning, markAsUploaded } from '../modules/planRunner';
import { checkCommand } from './abstract/createCommand';
import { pickPlan } from './planShared';

// what "mark as uploaded" settles: the items a run would pick up
const OPEN_STATUSES = ['pending', 'stale', 'failed'];

export default checkCommand({
  id: COMMAND_PLAN_MARK_UPLOADED,

  async handleCommand(arg?: unknown) {
    const plan = await pickPlan(arg, 'Select the upload plan to mark as uploaded');
    if (!plan) {
      return;
    }

    if (isPlanRunning(plan.id)) {
      showWarningMessage(`SFTP: plan ${plan.id} is running; wait for it to finish first.`);
      return;
    }

    const open = plan.items.filter(item => OPEN_STATUSES.indexOf(item.status) !== -1);
    if (open.length === 0) {
      showInformationMessage(`SFTP: plan ${plan.id} has nothing left to mark as uploaded.`);
      return;
    }

    // a whole plan can be thousands of files, and the answer is remembered:
    // one modal, with the count and what it means, before anything is written
    const confirmLabel = `Mark ${open.length} file(s) as uploaded`;
    const choice = await showChoiceMessage(
      `SFTP: record ${open.length} file(s) of plan ${plan.id} as already uploaded to ` +
        `${plan.serviceName || 'the server'}?\n\n` +
        'Nothing is transferred: they are recorded in the sync index as being on the server ' +
        'in their current version and only proposed again once they change.',
      [confirmLabel],
      { modal: true }
    );
    if (choice !== confirmLabel) {
      return;
    }

    try {
      const marked = await markAsUploaded(plan.id);
      showInformationMessage(`SFTP: ${marked.length} file(s) of plan ${plan.id} marked as uploaded.`);
    } catch (error) {
      reportError(error, 'mark plan as uploaded');
    }
  },
});
