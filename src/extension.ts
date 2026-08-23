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
import { initSyncIndex, flushSyncIndex } from './modules/syncIndex';
import { getAllFileService, createFileService, disposeFileService } from './modules/serviceManager';
import { getWorkspaceFolders, setContextValue } from './host';
import RemoteExplorer from './modules/remoteExplorer';
import ActivityView from './modules/activityView';
import {
  ActivityKind,
  initActivityLog,
  flushActivityLog,
  setRetryResolver,
} from './modules/activityLog';
import { uploadFile, downloadFile } from './fileHandlers';
import syncIndexFeeder from './modules/syncIndexFeeder';
import uploadStatus from './modules/uploadStatus';
import externalChangeScanner from './modules/externalChangeScanner';
import { flushNow as flushPendingChanges } from './modules/changeCollector';
import { whenIdle as whenNoPlanRuns } from './modules/planRunner';

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
  // `storageUri` (vscode 1.49+) is the supported per-workspace storage; the
  // installed @types/vscode (1.40) only knows the deprecated `storagePath`,
  // which points at the same folder and is the fallback on older hosts
  const storageUri: { fsPath: string } | undefined = (context as any).storageUri;
  initSyncIndex({ storagePath: storageUri ? storageUri.fsPath : context.storagePath });
  // before the view and the services exist: the loaded entries must be there
  // when the tree first renders, and nothing may be recorded before the load
  // the log can't import the handlers itself (they import it back), so the
  // composition root hands it the way to rebuild a persisted retry
  setRetryResolver(entry => {
    const localPath = entry.localPath;
    if (!localPath) {
      return undefined;
    }
    if (entry.kind === ActivityKind.Upload) {
      return () => uploadFile(vscode.Uri.file(localPath));
    }
    if (entry.kind === ActivityKind.Download) {
      return () => downloadFile(vscode.Uri.file(localPath));
    }
    return undefined;
  });
  await initActivityLog({ storagePath: storageUri ? storageUri.fsPath : context.storagePath });

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

  // before the services exist: every transfer outcome must reach the sync
  // index, and the status bar counters follow the collector and the plans
  syncIndexFeeder.init();
  uploadStatus.init();

  try {
    await setup(workspaceFolders);
    app.remoteExplorer = new RemoteExplorer(context);
  } catch (error) {
    reportError(error);
  }

  // outside the try above: a failure to load one config must not skip the
  // retention purge for the services that did load
  schedulePurgeExpiredTrash();

  // the startup scan, the resume/focus triggers and the poll timer; runs in
  // the background and needs the services, hence after setup()
  externalChangeScanner.init(context);
}

// how long deactivate waits for a save made just before "Reload Window" to be
// uploaded; the extension host has its own, longer, patience
const DEACTIVATE_DRAIN_MS = 5000;

function settleWithin(work: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      error => {
        clearTimeout(timer);
        logger.error(error, 'drain pending uploads');
        resolve();
      }
    );
  });
}

export async function deactivate(): Promise<void> {
  fileActivityMonitor.destory();
  localDeleteMonitor.destroy();
  externalChangeScanner.destroy();
  if (activityView) {
    activityView.dispose();
    activityView = undefined;
  }
  // A save followed by "Reload Window" within the batching window would
  // otherwise be dropped with the queue: push what is pending through, wait
  // (bounded) for the plans it started, and only then tear the services down.
  await settleWithin(flushPendingChanges().then(whenNoPlanRuns), DEACTIVATE_DRAIN_MS);
  changeCollector.destroy();
  uploadStatus.destroy();
  syncIndexFeeder.destroy();
  getAllFileService().forEach(disposeFileService);

  // The returned promise is what makes the host wait for the last debounced
  // write instead of killing the process mid-save; the debounced saves mean
  // there is normally nothing left, so it costs nothing. The index is flushed
  // after the drain above, so those uploads are in it. One slot per module
  // with something to flush, each logging its own failure so one broken flush
  // never hides another.
  const flushes: Array<Promise<void>> = [
    flushSyncIndex().catch(error => logger.error(error, 'flush sync index')),
    flushActivityLog().catch(error => logger.error(error, 'flush activity log')),
  ];
  try {
    await Promise.all(flushes);
  } catch (error) {
    logger.error(error, 'deactivate');
  }
}
