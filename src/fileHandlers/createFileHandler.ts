import { Uri } from 'vscode';
import app from '../app';
import { UResource, FileService, ServiceConfig, TransferFailedError } from '../core';
import logger from '../logger';
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
    // caller. Errors raised while collecting the tasks propagate as before.
    let partialFailure: TransferFailedError | undefined;
    try {
      await handlerOption.handle.call(handleCtx, invokeOption);
    } catch (error) {
      if (!(error instanceof TransferFailedError)) {
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
