import * as fileOperations from './fileBaseOperations';
import upath from './upath';
import FileService, {
  WatcherService,
  FileServiceConfig,
  ServiceConfig,
  PathMatcher,
  TransferResult,
  TransferScheduler,
  uploadIgnoreOf,
  isExcludedFromMirroring,
} from './fileService';
import UResource, { Resource } from './uResource';
import Scheduler from './scheduler';
import TransferTask from './transferTask';
import CustomError, { TransferFailedError, TransferFailure, ETRANSFER_FAILED } from './customError';
import Ignore from './ignore';
export * from './transferTask';
export * from './fs';

export {
  fileOperations,
  upath,
  TransferTask,
  TransferResult,
  TransferScheduler,
  TransferFailure,
  TransferFailedError,
  ETRANSFER_FAILED,
  CustomError,
  FileService,
  WatcherService,
  FileServiceConfig,
  ServiceConfig,
  PathMatcher,
  uploadIgnoreOf,
  isExcludedFromMirroring,
  UResource,
  Resource,
  Scheduler,
  Ignore,
};
