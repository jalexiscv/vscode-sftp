import * as vscode from 'vscode';
import { COMMAND_PLAN_EXPORT_REPORT } from '../constants';
import { reportError } from '../helper';
import { formatReport } from '../modules/uploadPlan';
import { checkCommand } from './abstract/createCommand';
import { pickPlan } from './planShared';

export default checkCommand({
  id: COMMAND_PLAN_EXPORT_REPORT,

  async handleCommand(arg?: unknown) {
    const plan = await pickPlan(arg, 'Select the upload plan to export');
    if (!plan) {
      return;
    }

    try {
      // an untitled document rather than a file on disk: the user decides
      // whether to keep it, and where
      const document = await vscode.workspace.openTextDocument({
        content: formatReport(plan),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      reportError(error, 'export upload report');
    }
  },
});
