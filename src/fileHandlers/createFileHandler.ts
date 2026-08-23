import { Uri } from 'vscode';
import app from '../app';
import { UResource, FileService, ServiceConfig, TransferFailedError } from '../core';
import { isReported } from '../helper';
import logger from '../logger';
// activityLog only imports vscode and the logger, so it is safe to reach from
// here; serviceManager (below) is the side of the cycle that must stay lazy
import { ActivityKind, ActivityStatus, log as logActivity } from '../modules/activityLog';
import { getFileService } from '../modules/serviceManager';

interface FileHandlerConfig {
  _?: boolean;
}

export interface FileHandlerContext {
  target: UResource;
  fileService: FileService;
  config: ServiceConfig;
}

type FileHandlerContextMethod<R = void> = (this: FileHandlerContext) => R;
type FileHandlerContextMethodArg1<A, R = void> = (this: FileHandlerContext, a: A) => R;

interface FileHandlerOption<T> {
  name: string;
  handle: FileHandlerContextMethodArg1<T, Promise<any>>;
  afterHandle?: FileHandlerContextMethod;
  config?: FileHandlerConfig;
  transformOption?: FileHandlerContextMethod<T>;
}

/**
 * Activity kind under which a *transfer* handler's early failures are recorded,
 * by handler name.
 *
 * The per-task entries of the Activity view are opened by the service's
 * `beforeTransfer` hook, i.e. only once a task starts. A handler that rejects
 * before that — dead connection, bad password, lstat of the source, ensureDir
 * of the target — would otherwise leave no trace and nothing to retry. Only
 * transfers are listed: remove/rename/diff/create either record their own
 * entries or are not transfers at all. A new transfer handler must be added
 * here to get the same treatment.
 */
const TRANSFER_ACTIVITY_KINDS: { [handlerName: string]: ActivityKind } = {
  'upload': ActivityKind.Upload,
  'upload file': ActivityKind.Upload,
  'upload folder': ActivityKind.Upload,
  'download': ActivityKind.Download,
  'download file': ActivityKind.Download,
  'download folder': ActivityKind.Download,
  'sync local ➞ remote': ActivityKind.Sync,
  'sync remote ➞ local': ActivityKind.Sync,
};

export function handleCtxFromUri(uri: Uri): FileHandlerContext {
  const fileService = getFileService(uri);
  if (!fileService) {
    if (uri.toString(true) === 'file:///${command:sftp.sync.remoteToLocal}') {
      throw new Error('');
    } else {
      throw new Error(`Config Not Found. (${uri.toString(true)})`);
    }
  }
  const config = fileService.getConfig();
  const target = UResource.from(uri, {
    localBasePath: fileService.baseDir,
    remoteBasePath: config.remotePath,
    remoteId: fileService.id,
    remote: {
      host: config.host,
      port: config.port,
    },
  });

  return {
    fileService,
    config,
    target,
  };
}

export function allHandleCtxFromUri(uri: Uri): Array<FileHandlerContext> {
  const fileService = getFileService(uri);
  if (!fileService) {
    if (uri.toString(true) === 'file:///${command:sftp.sync.remoteToLocal}') {
      throw new Error('');
    } else {
      throw new Error(`Config Not Found. (${uri.toString(true)})`);
    }
  }

  const configArr = fileService.getAllConfig();

  return configArr.map(config => {
    const target = UResource.from(uri, {
      localBasePath: fileService.baseDir,
      remoteBasePath: config.remotePath,
      remoteId: fileService.id,
      remote: {
        host: config.host,
        port: config.port,
      },
    });

    return {
      fileService,
      config,
      target,
    };
  });
}

/**
 * Records a failure that happened before any task of a transfer handler ran.
 *
 * Skipped for errors already reported (the aggregate of a partially failed
 * batch arrives flagged, and its tasks have their own entries) and for handlers
 * that are not transfers.
 */
function recordEarlyFailure(
  handlerName: string,
  handleCtx: FileHandlerContext,
  error: any,
  retry: () => Promise<void>
) {
  const kind = TRANSFER_ACTIVITY_KINDS[handlerName];
  if (!kind || isReported(error)) {
    return;
  }

  const { target, fileService } = handleCtx;
  logActivity({
    kind,
    status: ActivityStatus.Failed,
    localPath: target.localFsPath,
    remotePath: target.remoteFsPath,
    serviceName: fileService.name,
    profile: app.state.profile,
    error: error && error.message ? error.message : String(error),
    retry,
  });
}

export default function createFileHandler<T>(
  handlerOption: FileHandlerOption<T>
): (ctx: FileHandlerContext | Uri, option?: Partial<T>) => Promise<void> {
  async function fileHandle(ctx: Uri | FileHandlerContext, option?: Partial<T>) {
    const handleCtx = ctx instanceof Uri ? handleCtxFromUri(ctx) : ctx;
    const { target } = handleCtx;

    const invokeOption = (handlerOption.transformOption
      ? handlerOption.transformOption.call(handleCtx)
      : {}) as T & { ignore?: (fsPath: string) => boolean };
    if (option) {
      Object.assign(invokeOption, option);
    }

    if (invokeOption.ignore && invokeOption.ignore(target.localFsPath)) {
      return;
    }

    logger.trace(`handle ${handlerOption.name} for`, target.localFsPath);

    app.sftpBarItem.startSpinner();
    // A batch that failed half-way still changed the remote; afterHandle
    // (the explorer refresh) has to see that before the failure reaches the
    // caller. Errors raised while collecting the tasks propagate as before,
    // but leave an Activity entry first: no task started, so no hook saw them.
    let partialFailure: TransferFailedError | undefined;
    try {
      await handlerOption.handle.call(handleCtx, invokeOption);
    } catch (error) {
      if (!(error instanceof TransferFailedError)) {
        // the original `ctx` rather than the resolved context, so a retry from
        // a Uri re-resolves the service and its config at retry time
        recordEarlyFailure(handlerOption.name, handleCtx, error, () => fileHandle(ctx, option));
        throw error;
      }
      partialFailure = error;
    } finally {
      app.sftpBarItem.stopSpinner();
    }
    if (handlerOption.afterHandle) {
      handlerOption.afterHandle.call(handleCtx);
    }
    if (partialFailure) {
      throw partialFailure;
    }
  }

  return fileHandle;
}
