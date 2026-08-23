import { Uri } from 'vscode';
import { COMMAND_PLAN_DIFF_ITEM } from '../constants';
import { diff } from '../fileHandlers';
import { reportError } from '../helper';
import { showWarningMessage } from '../host';
import { checkCommand } from './abstract/createCommand';
import { planItemFromArg } from './planShared';

export default checkCommand({
  id: COMMAND_PLAN_DIFF_ITEM,

  async handleCommand(arg?: unknown) {
    const resolved = planItemFromArg(arg);
    if (!resolved) {
      // only reachable from the plan item's context menu; the palette hides it
      showWarningMessage('SFTP: select a file of an upload plan in the Activity view first.');
      return;
    }

    try {
      // the same handler as "Diff with Remote": the service owning the local
      // path resolves the remote side, as it would for the upload itself
      await diff(Uri.file(resolved.item.localPath));
    } catch (error) {
      reportError(error, 'diff plan item');
    }
  },
});
