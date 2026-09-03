import * as path from 'path';
import * as vscode from 'vscode';
import app from '../app';
import { COMMAND_ACTIVITY_FOCUS, COMMAND_PLAN_PREVIEW } from '../constants';
import { FileService, ServiceConfig, UResource, uploadIgnoreOf } from '../core';
import { isSubpathOf, reportError, simplifyPath } from '../helper';
import {
  executeCommand,
  getActiveTextEditor,
  showInformationMessage,
  showOpenDialog,
  showQuickPick,
  showWarningMessage,
} from '../host';
import logger from '../logger';
import { scanLocalTree } from '../modules/localScanner';
import { runPlan } from '../modules/planRunner';
import { getAllFileService, getFileService } from '../modules/serviceManager';
import { getSyncIndex, indexKeyFor } from '../modules/syncIndex';
import { createPlan, diffAgainstIndex, formatSummary, UploadPlan } from '../modules/uploadPlan';
import { checkCommand } from './abstract/createCommand';

/**
 * "SFTP: Preview Upload (Dry Run)": what *would* be uploaded, without
 * uploading it. Scans the chosen scope, compares it with the sync index and
 * registers the result as a pending plan in the activity view, from where the
 * user can upload all of it, some of it, or nothing.
 */

interface ServicePickItem extends vscode.QuickPickItem {
  service: FileService;
}

interface ScopePickItem extends vscode.QuickPickItem {
  /** null means "ask with the folder dialog" */
  dir: string | null;
}

const UPLOAD_ALL = 'Upload all';

function hostOf(service: FileService): string {
  try {
    return service.getConfig().host || '';
  } catch (error) {
    // an unresolvable config is reported when the service is actually used
    return '';
  }
}

function activeFolderIn(service: FileService): string | undefined {
  const editor = getActiveTextEditor();
  if (!editor || !editor.document || editor.document.uri.scheme !== 'file') {
    return undefined;
  }

  const dir = path.dirname(editor.document.uri.fsPath);
  return isSubpathOf(service.baseDir, dir) ? dir : undefined;
}

/** The service to preview: the only one, or a pick with the active file's first. */
async function pickService(): Promise<FileService | undefined> {
  const services = getAllFileService();
  if (services.length === 0) {
    showInformationMessage('SFTP: no configuration loaded.');
    return undefined;
  }
  if (services.length === 1) {
    return services[0];
  }

  const editor = getActiveTextEditor();
  const active =
    editor && editor.document && editor.document.uri.scheme === 'file'
      ? getFileService(editor.document.uri)
      : undefined;
  const ordered = active
    ? [active].concat(services.filter(service => service !== active))
    : services;

  const items: ServicePickItem[] = ordered.map(service => ({
    label: service.name || simplifyPath(service.baseDir) || service.baseDir,
    description: hostOf(service),
    detail: service.baseDir,
    service,
  }));

  const picked = await showQuickPick(items, { placeHolder: 'Select the configuration to preview' });
  return picked ? picked.service : undefined;
}

/** The folder to scan: the whole service, the active file's folder, or a picked one. */
async function pickScope(service: FileService): Promise<string | undefined> {
  const items: ScopePickItem[] = [
    {
      label: '$(root-folder) Project',
      description: simplifyPath(service.baseDir) || service.baseDir,
      dir: service.baseDir,
    },
  ];

  const activeDir = activeFolderIn(service);
  if (activeDir) {
    items.push({
      label: '$(folder-active) Active folder',
      description: simplifyPath(activeDir) || activeDir,
      dir: activeDir,
    });
  }
  items.push({ label: '$(folder-opened) Pick folder…', dir: null });

  const picked = await showQuickPick(items, { placeHolder: 'What should be previewed?' });
  if (!picked) {
    return undefined;
  }
  if (picked.dir) {
    return picked.dir;
  }

  const chosen = await showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(service.baseDir),
    openLabel: 'Preview',
  });
  if (!chosen || chosen.length === 0) {
    return undefined;
  }

  const dir = chosen[0].fsPath;
  if (!isSubpathOf(service.baseDir, dir)) {
    showWarningMessage(`SFTP: ${dir} is outside ${service.baseDir}; nothing to preview there.`);
    return undefined;
  }
  return dir;
}

function describeItems(plan: UploadPlan): string {
  let created = 0;
  let modified = 0;
  plan.items.forEach(item => {
    if (item.reason === 'new') {
      created++;
    } else {
      modified++;
    }
  });
  return `${created} new, ${modified} modified`;
}

export default checkCommand({
  id: COMMAND_PLAN_PREVIEW,

  async handleCommand() {
    const service = await pickService();
    if (!service) {
      return;
    }

    const scopeDir = await pickScope(service);
    if (!scopeDir) {
      return;
    }

    let config: ServiceConfig;
    try {
      config = service.getConfig();
    } catch (error) {
      reportError(error);
      return;
    }

    const index = await getSyncIndex(
      indexKeyFor({
        baseDir: service.baseDir,
        host: config.host,
        port: config.port,
        remotePath: config.remotePath,
        profile: app.state.profile,
      })
    );

    const scan = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `SFTP: scanning ${simplifyPath(scopeDir) || scopeDir}`,
        cancellable: true,
      },
      (progress, token) =>
        scanLocalTree(scopeDir, {
          ignore: uploadIgnoreOf(config),
          isCancelled: () => token.isCancellationRequested,
          onProgress: (files, dirs) => progress.report({ message: `${files} files in ${dirs} folders` }),
        })
    );
    if (scan.cancelled) {
      showInformationMessage('SFTP: preview cancelled.');
      return;
    }

    // the same resolution the file handlers use, so the plan's remote paths
    // are exactly where an upload would put the files
    const toRemotePath = (localFsPath: string) =>
      UResource.from(vscode.Uri.file(localFsPath), {
        localBasePath: service.baseDir,
        remoteBasePath: config.remotePath,
        remoteId: service.id,
        remote: { host: config.host, port: config.port },
      }).remoteFsPath;

    const diff = diffAgainstIndex({ baseDir: service.baseDir, scanned: scan.files, index, toRemotePath });
    logger.info(
      `[plan-preview] ${service.name || service.baseDir}: ${scan.files.length} file(s) scanned, ` +
        `${diff.items.length} to upload, ${diff.unchanged} unchanged, ${scan.durationMs} ms`
    );

    if (diff.items.length === 0) {
      showInformationMessage(
        `SFTP: nothing to upload in ${simplifyPath(scopeDir) || scopeDir} — ` +
          `${diff.unchanged} file(s) unchanged since their last verified upload.`
      );
      return;
    }

    const plan = createPlan({
      serviceName: service.name,
      profile: app.state.profile,
      source: 'command',
      items: diff.items,
    });

    try {
      await executeCommand(COMMAND_ACTIVITY_FOCUS);
    } catch (error) {
      // the view may be hidden by `sftp.showActivityView`; the plan exists anyway
      logger.debug(`[plan-preview] cannot focus the activity view: ${error.message}`);
    }

    let message =
      `SFTP: ${diff.items.length} file(s) would be uploaded (${describeItems(plan)}); ` +
      `${diff.unchanged} unchanged.`;
    if (index.size === 0) {
      message +=
        ' The sync index is empty, so every file counts as new — run "SFTP: Rebuild Sync Index" ' +
        'to seed it from the server.';
    }

    const choice = await showInformationMessage(message, UPLOAD_ALL);
    if (choice !== UPLOAD_ALL) {
      return;
    }

    try {
      const summary = await runPlan(plan.id);
      showInformationMessage(`SFTP: plan ${plan.id} finished — ${formatSummary(summary)}.`);
    } catch (error) {
      reportError(error, 'upload plan');
    }
  },
});
