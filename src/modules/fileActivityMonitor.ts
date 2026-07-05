import * as vscode from 'vscode';
import * as path from 'path';
import * as debounce from 'lodash.debounce';
import logger from '../logger';
import { realpathSync } from 'fs';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import { onDidOpenTextDocument, onDidSaveTextDocument, showConfirmMessage } from '../host';
import { tryLoadConfigs } from './config';
import { CONFIG_PATH } from '../constants';
import {
  createFileService,
  getFileService,
  findAllFileService,
  disposeFileService,
} from './serviceManager';
import { reportError, isValidFile, isConfigFile, isInWorkspace } from '../helper';
import { downloadFile, uploadFile } from '../fileHandlers';

// vscode glob patterns always use forward slashes
const CONFIG_GLOB = '**/' + CONFIG_PATH.split(path.sep).join('/');
const CONFIG_RELOAD_DELAY = 500;

let workspaceWatcher: vscode.Disposable;
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
  }
}

async function handleFileSave(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  if (config.uploadOnSave) {
    let fspath = uri.fsPath;
    try {
      // resolve the on-disk casing so the remote path matches it
      fspath = realpathSync.native(uri.fsPath);
      uri = vscode.Uri.file(fspath);
      logger.info(`[file-save] ${fspath}`);
      await uploadFile(uri);
    } catch (error) {
      logger.error(error, `upload ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  }
}

async function downloadOnOpen(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  if (config.downloadOnOpen) {
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
  if (configFileWatcher) {
    configFileWatcher.dispose();
  }

  workspaceWatcher = onDidSaveTextDocument((doc: vscode.TextDocument) => {
    const uri = doc.uri;
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
  });

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
  if (configFileWatcher) {
    configFileWatcher.dispose();
  }
}

export default {
  init,
  destory,
};
