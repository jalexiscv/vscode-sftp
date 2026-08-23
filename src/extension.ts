'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import app from './app';
import initCommands from './initCommands';
import { STATE_KEY_ACTIVE_PROFILE } from './constants';
import { reportError } from './helper';
import logger from './logger';
import fileActivityMonitor from './modules/fileActivityMonitor';
import localDeleteMonitor from './modules/localDeleteMonitor';
import changeCollector from './modules/changeCollector';
import { tryLoadConfigs } from './modules/config';
import { initSavedPasswords } from './modules/savedPasswords';
import { initSyncControl, isPaused, onDidChangePauseState } from './modules/syncControl';
import { initRemoteTrash, purgeExpired } from './modules/remoteTrash';
import { getAllFileService, createFileService, disposeFileService } from './modules/serviceManager';
import { getWorkspaceFolders, setContextValue } from './host';
import RemoteExplorer from './modules/remoteExplorer';
import ActivityView from './modules/activityView';

// kept module-local rather than on `app`: nothing outside activation needs to
// reach the view, and `app` is built at import time, before the context exists
let activityView: ActivityView | undefined;

async function setupWorkspaceFolder(dir) {
  const configs = await tryLoadConfigs(dir);
  configs.forEach(config => {
    createFileService(config, dir);
  });
}

function setup(workspaceFolders: vscode.WorkspaceFolder[]) {
  fileActivityMonitor.init();
  localDeleteMonitor.init();
  const pendingInits = workspaceFolders.map(folder => setupWorkspaceFolder(folder.uri.fsPath));

  return Promise.all(pendingInits);
}

/**
 * Drops expired trash in the background.
 *
 * Deliberately not awaited by `activate`: it needs a live connection, and a
 * server that is slow or unreachable must not delay the extension becoming
 * usable. Failures are logged, never surfaced — nothing the user asked for
 * failed.
 */
function schedulePurgeExpiredTrash() {
  getAllFileService().forEach(service => {
    purgeExpired(service).catch(error =>
      logger.debug(`trash purge skipped for ${service.baseDir}: ${error.message}`)
    );
  });
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  initSavedPasswords(context);
  initSyncControl(context);
  initRemoteTrash(context);

  try {
    initCommands(context);
  } catch (error) {
    reportError(error, 'initCommands');
  }

  const workspaceFolders = getWorkspaceFolders();
  if (!workspaceFolders) {
    return;
  }

  setContextValue('enabled', true);
  setContextValue('autoSyncPaused', isPaused());

  // the status bar is told about the pause from here: ui/ must not import
  // modules/, or app.ts's import-time construction closes a cycle
  const reflectPauseState = () => {
    app.sftpBarItem.setPausedState(isPaused());
    setContextValue('autoSyncPaused', isPaused());
  };
  reflectPauseState();
  context.subscriptions.push(onDidChangePauseState(reflectPauseState));
  app.sftpBarItem.show();
  app.state.subscribe(_ => {
    // persistir la selección para que sobreviva a reinicios de la ventana
    context.workspaceState.update(STATE_KEY_ACTIVE_PROFILE, app.state.profile);
    const currentText = app.sftpBarItem.getText();
    // current is showing profile
    if (currentText.startsWith('SFTP')) {
      app.sftpBarItem.reset();
    }
    if (app.remoteExplorer) {
      app.remoteExplorer.refresh();
    }
  });

  // restaurar el perfil de la sesión anterior antes de crear los servicios,
  // para que createFileService respete la selección en lugar del defaultProfile
  const savedProfile = context.workspaceState.get<string | null>(STATE_KEY_ACTIVE_PROFILE, null);
  if (savedProfile) {
    app.state.profile = savedProfile;
  }

  // Built before setup(): it registers its own commands, and a config error in
  // setup() would otherwise leave them unregistered while `sftp.enabled` is
  // already true — the palette would offer commands that don't exist.
  try {
    activityView = new ActivityView(context);
  } catch (error) {
    reportError(error, 'activity view');
  }

  try {
    await setup(workspaceFolders);
    app.remoteExplorer = new RemoteExplorer(context);
  } catch (error) {
    reportError(error);
  }

  // outside the try above: a failure to load one config must not skip the
  // retention purge for the services that did load
  schedulePurgeExpiredTrash();
}

export function deactivate() {
  fileActivityMonitor.destory();
  localDeleteMonitor.destroy();
  changeCollector.destroy();
  if (activityView) {
    activityView.dispose();
    activityView = undefined;
  }
  getAllFileService().forEach(disposeFileService);
}
