import * as vscode from 'vscode';
import * as path from 'path';
import * as debounce from 'lodash.debounce';
import logger from '../logger';
import { realpathSync } from 'fs';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import {
  onDidOpenTextDocument,
  onDidSaveTextDocument,
  onDidSaveNotebookDocument,
  showConfirmMessage,
} from '../host';
import { tryLoadConfigs } from './config';
import { CONFIG_PATH } from '../constants';
import {
  createFileService,
  getFileService,
  findAllFileService,
  disposeFileService,
} from './serviceManager';
import { reportError, isValidFile, isConfigFile, isInWorkspace } from '../helper';
import { downloadFile } from '../fileHandlers';
import { isPaused, isSuppressed } from './syncControl';
import { enqueueChange } from './changeCollector';
import { runScan } from './externalChangeScanner';
import { refreshContext as refreshUploadExclusions } from './uploadExclusions';

/**
 * Reacts to what happens inside the editor: a saved document, an opened one,
 * and a saved or externally rewritten sftp.json.
 *
 * Saves are not uploaded from here. They go through the change collector,
 * which is also fed by the filesystem watcher, so that an in-editor save with
 * the watcher on produces one upload and not two. Opens still download
 * directly, and a config change rebuilds the services of its workspace.
 *
 * Key lifecycle methods:
 * - {@link init} subscribes to the editor events.
 * - {@link destory} drops the subscriptions on deactivate.
 */

// vscode glob patterns always use forward slashes
const CONFIG_GLOB = '**/' + CONFIG_PATH.split(path.sep).join('/');
const CONFIG_RELOAD_DELAY = 500;

let workspaceWatcher: vscode.Disposable;
let notebookWatcher: vscode.Disposable;
let configFileWatcher: vscode.FileSystemWatcher;

// an in-editor save and the filesystem watcher can fire for the same change;
// debounce per config file so the reload runs only once
const debouncedConfigReloads = new Map<string, (uri: vscode.Uri) => void>();

function requestConfigReload(uri: vscode.Uri, handler: (uri: vscode.Uri) => void) {
  const key = uri.fsPath;
  const existing = debouncedConfigReloads.get(key);
  if (existing) {
    existing(uri);
    return;
  }

  const reload = debounce(handler, CONFIG_RELOAD_DELAY);
  debouncedConfigReloads.set(key, reload);
  reload(uri);
}

async function handleConfigSave(uri: vscode.Uri) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return;
  }

  const workspacePath = workspaceFolder.uri.fsPath;

  // dispose old service
  findAllFileService(service => service.workspace === workspacePath).forEach(disposeFileService);

  // create new service. tryLoadConfigs resolves to [] when the config file
  // was removed (e.g. a git branch switch), leaving no stale services behind.
  try {
    const configs = await tryLoadConfigs(workspacePath);
    configs.forEach(config => createFileService(config, workspacePath));
  } catch (error) {
    reportError(error);
  } finally {
    app.remoteExplorer.refresh();
    // the uploadExclude lists may have changed with the file
    refreshUploadExclusions();
  }

  // a reloaded config may point at another destination (another index), and
  // a freshly created one has never been reconciled; the scan is gated by
  // externalChanges.scanOnStartup and runs in the background
  findAllFileService(service => service.workspace === workspacePath).forEach(service => {
    runScan(service, 'config').catch(error => logger.error(error, `[scan] ${service.name}`));
  });
}

function handleFileSave(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  if (config.uploadOnSave) {
    // an explicit command is the user overriding the pause; this path is not.
    // The collector checks again when the batch runs; this keeps the log line.
    if (isPaused() || isSuppressed()) {
      logger.info('[file-save] skipped (auto sync paused)');
      return;
    }

    let fspath = uri.fsPath;
    try {
      // resolve the on-disk casing so the remote path matches it
      fspath = realpathSync.native(uri.fsPath);
      uri = vscode.Uri.file(fspath);
    } catch (error) {
      logger.error(error, `upload ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
      return;
    }

    logger.info(`[file-save] ${fspath}`);
    // the upload itself, and its activity entry, happen downstream: the
    // collector dedupes this against the watcher's event for the same write
    enqueueChange(uri, 'save');
  }
}

async function downloadOnOpen(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  if (config.downloadOnOpen) {
    // bail out before the prompt: asking and then doing nothing is worse
    if (isPaused()) {
      logger.info('[file-open] skipped (auto sync paused)');
      return;
    }

    if (config.downloadOnOpen === 'confirm') {
      const isConfirm = await showConfirmMessage('Do you want SFTP to download this file?');
      if (!isConfirm) return;
    }

    const fspath = uri.fsPath;
    logger.info(`[file-open] ${fspath}`);
    try {
      await downloadFile(uri);
    } catch (error) {
      logger.error(error, `download ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  }
}

function watchWorkspace({
  onDidSaveFile,
  onDidSaveSftpConfig,
}: {
  onDidSaveFile: (uri: vscode.Uri) => void;
  onDidSaveSftpConfig: (uri: vscode.Uri) => void;
}) {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }
  if (notebookWatcher) {
    notebookWatcher.dispose();
  }
  if (configFileWatcher) {
    configFileWatcher.dispose();
  }

  const handleSavedUri = (uri: vscode.Uri) => {
    if (!isValidFile(uri) || !isInWorkspace(uri.fsPath)) {
      return;
    }

    // remove staled cache
    if (app.fsCache.has(uri.fsPath)) {
      app.fsCache.del(uri.fsPath);
    }

    if (isConfigFile(uri)) {
      requestConfigReload(uri, onDidSaveSftpConfig);
      return;
    }

    onDidSaveFile(uri);
  };

  workspaceWatcher = onDidSaveTextDocument((doc: vscode.TextDocument) => handleSavedUri(doc.uri));
  // notebooks (e.g. .ipynb) save through the notebook api, not
  // onDidSaveTextDocument
  notebookWatcher = onDidSaveNotebookDocument(handleSavedUri);

  // reload the config when sftp.json changes outside the editor too
  // (e.g. a git branch switch or an external tool rewriting it)
  configFileWatcher = vscode.workspace.createFileSystemWatcher(CONFIG_GLOB);
  const onConfigFileEvent = (uri: vscode.Uri) => {
    logger.info(`[config-watcher] ${uri.fsPath}`);
    requestConfigReload(uri, onDidSaveSftpConfig);
  };
  configFileWatcher.onDidCreate(onConfigFileEvent);
  configFileWatcher.onDidChange(onConfigFileEvent);
  configFileWatcher.onDidDelete(onConfigFileEvent);
}

function init() {
  onDidOpenTextDocument((doc: vscode.TextDocument) => {
    if (!isValidFile(doc.uri) || !isInWorkspace(doc.uri.fsPath)) {
      return;
    }

    downloadOnOpen(doc.uri);
  });

  watchWorkspace({
    onDidSaveFile: handleFileSave,
    onDidSaveSftpConfig: handleConfigSave,
  });
}

function destory() {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }
  if (notebookWatcher) {
    notebookWatcher.dispose();
  }
  if (configFileWatcher) {
    configFileWatcher.dispose();
  }
}

export default {
  init,
  destory,
};
