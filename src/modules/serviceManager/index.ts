import { Uri } from 'vscode';
import * as path from 'path';
import app from '../../app';
import logger from '../../logger';
import { simplifyPath, reportError } from '../../helper';
import { UResource, FileService, TransferTask, TransferDirection } from '../../core';
import { validateConfig } from '../config';
import watcherService from '../fileWatcher';
// used at call time only: fileHandlers imports this module back for
// getFileService, and the cycle resolves as long as neither side touches the
// other while loading
import { uploadFile, downloadFile } from '../../fileHandlers';
import { ActivityKind, ActivityStatus, record, update, succeed, fail } from '../activityLog';
import Trie from './trie';

/**
 * Registry of the FileServices of the window, one per sftp.json entry, indexed
 * by local base path so "which service handles this file?" is a prefix lookup.
 *
 * It is also where every service gets its cross-cutting behaviour wired in:
 * the config validator, the file watcher, and the transfer hooks that drive
 * the status bar, the error dialogs and the Activity view. Recording the
 * activity here, per task, is what makes commands, uploadOnSave and the
 * watcher all look the same in that view.
 *
 * Key lifecycle methods:
 * - {@link createFileService} builds and registers a service for a config.
 * - {@link getFileService} resolves the service owning a local or remote uri.
 * - {@link disposeFileService} unregisters it and tears it down.
 */

const WIN_DRIVE_REGEX = /^([a-zA-Z]):/;
const isWindows = process.platform === 'win32';

const serviceManager = new Trie<FileService>(
  {},
  {
    delimiter: path.sep,
  }
);

function maskConfig(config) {
  const copy = {};
  const MASK = '******';
  Object.keys(config).forEach(key => {
    const configValue = config[key];
    switch (key) {
      case 'username':
      case 'password':
      case 'passphrase':
        copy[key] = MASK;
        break;
      case 'interactiveAuth':
        if (Array.isArray(configValue)) {
          copy[key] = configValue.map(phrase => MASK);
        } else {
          copy[key] = configValue;
        }
        break;
      default:
        copy[key] = configValue;
    }
  });
  return copy;
}

function normalizePathForTrie(pathname) {
  if (isWindows) {
    const device = pathname.substr(0, 2);
    if (device.charAt(1) === ':') {
      // lowercase drive letter
      pathname = pathname[0].toLowerCase() + pathname.substr(1);
    }
  }

  return path.normalize(pathname);
}

// windows filesystems are case-insensitive: vscode may report a saved file
// with a casing different from the configured workspace one, so casefold the
// whole trie key there. Other platforms keep case-sensitive keys.
function toTrieKey(pathname) {
  const normalized = normalizePathForTrie(pathname);
  return isWindows ? normalized.toLowerCase() : normalized;
}

export function getBasePath(context: string, workspace: string) {
  let dirpath;
  if (context) {
    if (path.isAbsolute(context)) {
      dirpath = context;
      if (isWindows) {
        const contextBeginWithDrive = context.match(WIN_DRIVE_REGEX);
        // if a windows user omit drive, we complete it with a drive letter same with the workspace one
        if (!contextBeginWithDrive) {
          const workspaceDrive = workspace.match(WIN_DRIVE_REGEX);
          if (workspaceDrive) {
            const drive = workspaceDrive[1];
            dirpath = path.join(`${drive}:`, context);
          }
        }
      }
    } else {
      // Don't use path.resolve bacause it may change the root dir of workspace!
      // Example: On window path.resove('\\a\\b\\c') will result to '<drive>:\\a\\b\\c'
      // We know workspace must be a absolute path and context is a relative path to workspace,
      // so path.join will suit our requirements.
      dirpath = path.join(workspace, context);
    }
  } else {
    dirpath = workspace;
  }

  return normalizePathForTrie(dirpath);
}

/**
 * Opens the Activity entry for a task, and returns its id.
 *
 * The retry is a fresh handler call on the local path rather than the task
 * itself: by the time the user clicks it, the task's connection and option
 * snapshot may be long gone.
 */
function recordTransfer(service: FileService, task: TransferTask): number {
  const isUpload = task.transferType === TransferDirection.LOCAL_TO_REMOTE;
  const localPath = task.localFsPath;
  return record({
    kind: isUpload ? ActivityKind.Upload : ActivityKind.Download,
    localPath,
    remotePath: isUpload ? task.targetFsPath : task.srcFsPath,
    serviceName: service.name,
    profile: app.state.profile,
    retry: isUpload
      ? () => uploadFile(Uri.file(localPath))
      : () => downloadFile(Uri.file(localPath)),
  });
}

export function createFileService(config: any, workspace: string) {
  // defaultProfile es un valor inicial, no una imposición: solo aplica cuando
  // no hay perfil activo o cuando el activo ya no existe en esta configuración,
  // para que una recarga de sftp.json no pise la selección del usuario
  if (config.defaultProfile) {
    const current = app.state.profile;
    const currentIsValid =
      current !== null && config.profiles && config.profiles[current] !== undefined;
    if (!currentIsValid) {
      app.state.profile = config.defaultProfile;
    }
  }

  const normalizedBasePath = getBasePath(config.context, workspace);
  const service = new FileService(normalizedBasePath, workspace, config);

  logger.info(`config at ${normalizedBasePath}`, maskConfig(config));

  serviceManager.add(toTrieKey(normalizedBasePath), service);
  service.name = config.name;
  service.setConfigValidator(validateConfig);
  service.setWatcherService(watcherService);
  // keyed by the task object: the same path can be in flight twice (a retry
  // racing a save), and each run must close its own entry
  const activityIds = new WeakMap<TransferTask, number>();
  service.beforeTransfer(task => {
    const { localFsPath, transferType } = task;
    app.sftpBarItem.setQueueSize(getRunningTransformTasks().length);
    app.sftpBarItem.showMsg(
      `${transferType} ${path.basename(localFsPath)}`,
      simplifyPath(localFsPath)
    );
    activityIds.set(task, recordTransfer(service, task));
  });
  service.afterTransfer((error, task) => {
    const { localFsPath, transferType } = task;
    const filename = path.basename(localFsPath);
    const filepath = simplifyPath(localFsPath);
    // the task is already out of the pending set when this fires
    app.sftpBarItem.setQueueSize(getRunningTransformTasks().length);
    const activityId = activityIds.get(task);
    activityIds.delete(task);
    if (task.isCancelled()) {
      logger.info(`cancel transfer ${localFsPath}`);
      app.sftpBarItem.showMsg(`cancelled ${filename}`, filepath, 2000 * 2);
      if (activityId !== undefined) {
        update(activityId, { status: ActivityStatus.Cancelled });
      }
    } else if (error) {
      // one dialog per failed file; the handler's aggregate arrives later
      // already flagged as reported and only reaches the log
      reportError(error, `when ${transferType} ${localFsPath}`);
      app.sftpBarItem.showMsg(`failed ${filename}`, filepath, 2000 * 2);
      if (activityId !== undefined) {
        fail(activityId, error);
      }
    } else {
      logger.info(`${transferType} ${localFsPath}`);
      app.sftpBarItem.showMsg(`done ${filename}`, filepath, 2000 * 2);
      if (activityId !== undefined) {
        succeed(activityId);
      }
    }
  });

  return service;
}

export function getFileService(uri: Uri): FileService {
  let fileService;
  if (UResource.isRemote(uri)) {
    const remoteRoot = app.remoteExplorer.findRoot(uri);
    if (remoteRoot) {
      fileService = remoteRoot.explorerContext.fileService;
    }
  } else {
    fileService = serviceManager.findPrefix(toTrieKey(uri.fsPath));
  }

  return fileService;
}

export function disposeFileService(fileService: FileService) {
  serviceManager.remove(toTrieKey(fileService.baseDir));
  fileService.dispose();
}

export function findAllFileService(predictor: (x: FileService) => boolean): FileService[] {
  if (serviceManager === undefined) {
    return [];
  }

  return getAllFileService().filter(predictor);
}

export function getAllFileService(): FileService[] {
  if (serviceManager === undefined) {
    return [];
  }

  return serviceManager.getAllValues();
}

export function getRunningTransformTasks(): TransferTask[] {
  return getAllFileService().reduce<TransferTask[]>((acc, fileService) => {
    return acc.concat(fileService.getPendingTransferTasks());
  }, []);
}
