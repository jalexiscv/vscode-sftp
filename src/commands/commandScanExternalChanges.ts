import { COMMAND_SCAN_EXTERNAL_CHANGES, VIEW_ACTIVITY } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { executeCommand, showInformationMessage, withProgress } from '../host';
import { reportError } from '../helper';
import { FileService } from '../core';
import { runScan, ScanOutcome } from '../modules/externalChangeScanner';
import { pickService } from './shared';

const SHOW_ACTIVITY_LABEL = 'Show activity';

function describeOutcome(name: string, outcome: ScanOutcome): { message: string; activity: boolean } {
  switch (outcome.status) {
    case 'up-to-date':
      return {
        message: `SFTP: ${name} is up to date (${outcome.filesScanned} file(s) scanned).`,
        activity: false,
      };
    case 'cancelled':
      return { message: `SFTP: scan of ${name} cancelled.`, activity: false };
    case 'planned': {
      const plan = outcome.plan!;
      const summary = outcome.summary!;
      if (outcome.decision === 'skip') {
        return { message: `SFTP: ${plan.items.length} changed file(s) skipped.`, activity: false };
      }
      if (outcome.decision === 'review') {
        return {
          message: `SFTP: ${plan.items.length} changed file(s) are waiting in the upload plan.`,
          activity: true,
        };
      }
      const parts = [`${summary.verified} file(s) uploaded and verified`];
      if (summary.failed > 0) {
        parts.push(`${summary.failed} failed`);
      }
      if (summary.skipped > 0) {
        parts.push(`${summary.skipped} skipped`);
      }
      if (summary.stale > 0) {
        parts.push(`${summary.stale} changed again during upload`);
      }
      return { message: `SFTP: ${parts.join(', ')}.`, activity: true };
    }
    default:
      return {
        message: `SFTP: ${name} was not scanned${outcome.reason ? `: ${outcome.reason}` : '.'}`,
        activity: false,
      };
  }
}

async function scanInteractive(service: FileService): Promise<void> {
  const name = service.name || service.baseDir;
  const outcome = await withProgress(
    { title: `SFTP: checking ${name} for external changes`, cancellable: true },
    (progress, token) => {
      // cancelling during the upload phase stops the service's transfers; the
      // scan itself is polled cooperatively
      token.onCancellationRequested(() => service.cancelTransferTasks());
      return runScan(service, 'manual', {
        isCancelled: () => token.isCancellationRequested,
        onStatus: status => progress.report({ message: status }),
      });
    }
  );

  const { message, activity } = describeOutcome(name, outcome);
  if (!activity) {
    showInformationMessage(message);
    return;
  }
  const choice = await showInformationMessage(message, SHOW_ACTIVITY_LABEL);
  if (choice === SHOW_ACTIVITY_LABEL) {
    executeCommand(`${VIEW_ACTIVITY}.focus`);
  }
}

export default checkCommand({
  id: COMMAND_SCAN_EXTERNAL_CHANGES,

  async handleCommand() {
    const service = await pickService('Select the connection to scan for external changes');
    if (!service) {
      return;
    }

    try {
      await scanInteractive(service);
    } catch (error) {
      reportError(error, 'scan external changes');
    }
  },
});
