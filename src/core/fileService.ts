import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as sshConfig from 'ssh-config';
import app from '../app';
import logger from '../logger';
import { getUserSetting } from '../host';
import { replaceHomePath, resolvePath } from '../helper';
import { SETTING_KEY_REMOTE, CONFIG_PATH } from '../constants';
import upath from './upath';
import Ignore from './ignore';
import { resolveTempFilePatterns } from './tempFiles';
import { FileSystem } from './fs';
import Scheduler from './scheduler';
import {
  createRemoteIfNoneExist,
  removeRemoteFs,
  connectionGateOf,
  isSameRemote,
} from './remoteFs';
import { ConnectionGate, isConnectionLostError } from './connectionHealth';
import TransferTask, { VerifyUploadLevel } from './transferTask';
import { TransferFailure } from './customError';
import localFs from './localFs';

type Omit<T, U> = Pick<T, Exclude<keyof T, U>>;

interface Root {
  name: string;
  context: string;
  watcher: WatcherConfig;
  defaultProfile: string;
}

interface Host {
  host: string;
  port: number;
  username: string;
  password: string;
  remotePath: string;
  connectTimeout: number;
}

interface ServiceOption {
  protocol: string;
  remote?: string;
  uploadOnSave: boolean;
  useTempFile: boolean;
  openSsh: boolean;
  downloadOnOpen: boolean | 'confirm';
  verifyUpload: VerifyUploadLevel;
  uploadRetries: number;
  filePerm?: number;
  dirPerm?: number;
  syncOption: {
    delete: boolean;
    skipCreate: boolean;
    ignoreExisting: boolean;
    update: boolean;
  };
  ignore: string[];
  ignoreFile: string;
  ignoreTempFiles: boolean;
  tempFilePatterns: string[];
  /**
   * gitignore patterns — typically directories — that never travel local →
   * remote: not uploaded by any command, save, watcher, scan or sync, and
   * whose remote copy is left alone when the local one is deleted or renamed.
   * Unlike `ignore` they can still be downloaded, listed and diffed.
   */
  uploadExclude: string[];
  deleteRemoteOnLocalDelete: boolean;
  deleteRemoteConfirmThreshold: number;
  renameRemoteOnLocalRename: boolean;
  remoteTrash: RemoteTrashConfig;
  remoteExplorer: {
    filesExclude?: string[];
    order: number;
  };
  remoteTimeOffsetInHours: number;
  limitOpenFilesOnRemote: number | true;
  externalChanges: ExternalChangesConfig;
}

export interface ExternalChangesConfig {
  /** reconcile the local tree against the sync index when the extension activates */
  scanOnStartup: boolean;
  /** ...and when automatic sync is resumed or the window regains focus */
  scanOnResume: boolean;
  /** batches above this many files ask before uploading; 0 always asks */
  confirmThreshold: number;
  /**
   * a scan or a watcher burst that finds more changed files than this is not
   * turned into a plan: the count is reported with a way out instead, so a
   * tree of tens of thousands of files never saturates the view, the index or
   * the extension host; 0 removes the limit
   */
  maxPlanItems: number;
  /**
   * a file whose size matches its index entry but whose mtime moved is read
   * and compared with the fingerprint the entry carries before it is called
   * modified (a checkout, a copy, a formatter that changed nothing); off,
   * size and mtime decide alone and no file is read
   */
  compareContent: boolean;
}

export interface RemoteTrashConfig {
  enabled: boolean;
  /** relative to remotePath, or absolute when it starts with "/" */
  path: string;
  retentionDays: number;
}

interface WatcherConfig {
  files: false | string;
  autoUpload: boolean;
  autoDelete: boolean;
  /** ms between scans of the local tree; 0 (default) disables polling */
  pollInterval?: number;
}

interface SftpOption {
  // sftp
  agent?: string;
  privateKeyPath?: string;
  passphrase: string | true;
  interactiveAuth: boolean | string[];
  algorithms: any;
  sshConfigPath?: string;
  concurrency: number;
  sshCustomParams?: string;
  hop: (Host & SftpOption)[] | (Host & SftpOption);
}

interface FtpOption {
  secure: boolean | 'control' | 'implicit';
  secureOptions: any;
}

export interface FileServiceConfig
  extends Root,
    Host,
    ServiceOption,
    SftpOption,
    FtpOption {
  profiles?: {
    [x: string]: FileServiceConfig;
  };
}

/**
 * Whether `fsPath` (local or remote, absolute) matches a pattern list of the
 * config. Pass `isDirectory` when the caller knows it holds a directory:
 * gitignore patterns with a trailing slash (`node_modules/`) only match a
 * directory, and only when it is tested as one.
 */
export type PathMatcher = (fsPath: string, isDirectory?: boolean) => boolean;

export interface ServiceConfig
  extends Root,
    Host,
    Omit<ServiceOption, 'ignore' | 'uploadExclude'>,
    SftpOption,
    FtpOption {
  /** `ignore` (plus the built-in exclusions) as a matcher; null when empty */
  ignore?: PathMatcher | null;
  /**
   * `uploadExclude` as a matcher; null when empty. Only the paths that go
   * local → remote consult it — see {@link uploadIgnoreOf} for the combined
   * check those paths use.
   */
  uploadExclude?: PathMatcher | null;
}

/**
 * The matcher every local → remote path consults: `ignore` (either direction)
 * plus `uploadExclude` (this direction only). Null when neither is configured,
 * so it can be handed straight to whatever expects an ignore function.
 */
export function uploadIgnoreOf(config: ServiceConfig): PathMatcher | null {
  const ignore = config.ignore || null;
  const excluded = config.uploadExclude || null;
  if (!ignore) {
    return excluded;
  }
  if (!excluded) {
    return ignore;
  }
  return (fsPath, isDirectory) => ignore(fsPath, isDirectory) || excluded(fsPath, isDirectory);
}

/**
 * Whether the deletion or rename of a local path must *not* be mirrored to the
 * server. The path is gone by the time this is asked, so it cannot be stat'ed:
 * it is tested both as a file and as a directory, and a `dir/` pattern that
 * matches either way keeps the remote copy. Erring this way costs at most a
 * deletion the user has to repeat by hand; erring the other way removes a
 * directory the config said to leave alone.
 */
export function isExcludedFromMirroring(config: ServiceConfig, fsPath: string): boolean {
  const matcher = uploadIgnoreOf(config);
  return matcher !== null && (matcher(fsPath) || matcher(fsPath, true));
}

export interface WatcherService {
  create(watcherBase: string, watcherConfig: WatcherConfig): any;
  dispose(watcherBase: string): void;
}

/**
 * Outcome of one scheduler run. A task lands in exactly one of the three lists.
 */
export interface TransferResult {
  /** tasks whose run() completed */
  succeeded: TransferTask[];
  /** tasks whose run() threw; a cancelled task never counts as failed */
  failed: TransferFailure[];
  /** tasks aborted through cancelTransferTasks() */
  cancelled: TransferTask[];
  /**
   * Set when a task failed because the connection was lost: the tasks still
   * queued at that moment were dropped without running (they appear in none
   * of the lists), since every one of them would have failed the same way.
   * The tasks already in flight still finish and are listed as usual.
   */
  connectionLost?: Error;
}

export interface TransferScheduler {
  // readonly _scheduler: Scheduler;
  size: number;
  add(x: TransferTask): void;
  /**
   * Starts the queued tasks and resolves once all of them have finished.
   * Never rejects because of a task: failures are reported in the result, so
   * the caller decides what a partially failed batch means.
   */
  run(): Promise<TransferResult>;
  stop(): void;
}

type ConfigValidator = (x: any) => { message: string };

const DEFAULT_SSHCONFIG_FILE = '~/.ssh/config';

// root-anchored gitignore pattern for the extension config file
const CONFIG_IGNORE_PATTERN = '/' + CONFIG_PATH.split(path.sep).join('/');

/**
 * Keeps the remote trash out of every traversal.
 *
 * Without this, a `Sync Remote -> Local` would download every file the user
 * ever deleted, and a `Sync Local -> Remote --delete` would wipe the trash —
 * defeating the point of having one.
 *
 * Only a trash relative to `remotePath` needs a pattern; an absolute one is
 * outside the synced tree already.
 */
function trashIgnorePatterns(config: FileServiceConfig): string[] {
  const trash = resolveRemoteTrashConfig(config);
  if (!trash.enabled || trash.path.charAt(0) === '/') {
    return [];
  }

  const normalized = trash.path.replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized ? ['/' + normalized] : [];
}

/**
 * Version-control metadata directories, ignored by default in both
 * directions. Nobody deploys `.git` to a web server, and its contents change
 * every time the editor's git integration runs `status` or `fetch`
 * (`.git/index`, `.git/FETCH_HEAD`, `.git/logs/…`): with a broad watcher
 * those writes were planned as uploads of files nobody edited. A user who
 * really wants them across can negate the pattern in `ignore` (`"!.git"`).
 */
export const VCS_METADATA_IGNORE_PATTERNS = ['.git', '.svn', '.hg'];

function filesIgnoredFromConfig(config: FileServiceConfig): string[] {
  const cache = app.fsCache;
  // the config file holds credentials; never let a sync/upload ship it.
  // editor/OS/tool scratch files must never reach the remote either — see
  // core/tempFiles for the list and how to opt out of it.
  const ignore: string[] = [CONFIG_IGNORE_PATTERN]
    .concat(VCS_METADATA_IGNORE_PATTERNS)
    .concat(trashIgnorePatterns(config))
    .concat(resolveTempFilePatterns(config))
    .concat(config.ignore && config.ignore.length ? config.ignore : []);

  const ignoreFile = config.ignoreFile;
  if (!ignoreFile) {
    return ignore;
  }

  let ignoreFromFile;
  if (cache.has(ignoreFile)) {
    ignoreFromFile = cache.get(ignoreFile);
  } else if (fs.existsSync(ignoreFile)) {
    ignoreFromFile = fs.readFileSync(ignoreFile).toString();
    cache.set(ignoreFile, ignoreFromFile);
  } else {
    throw new Error(
      `File ${ignoreFile} not found. Check your config of "ignoreFile"`
    );
  }

  return ignore.concat(ignoreFromFile.split(/\r?\n/g));
}

function getHostInfo(config) {
  const ignoreOptions = [
    'name',
    'remotePath',
    'uploadOnSave',
    'useTempFile',
    'openSsh',
    'downloadOnOpen',
    'verifyUpload',
    'uploadRetries',
    'ignore',
    'ignoreFile',
    'ignoreTempFiles',
    'tempFilePatterns',
    'uploadExclude',
    'watcher',
    'concurrency',
    'syncOption',
    'sshConfigPath',
    'deleteRemoteOnLocalDelete',
    'deleteRemoteConfirmThreshold',
    'renameRemoteOnLocalRename',
    'remoteTrash',
    'externalChanges',
  ];

  return Object.keys(config).reduce((obj, key) => {
    if (ignoreOptions.indexOf(key) === -1) {
      obj[key] = config[key];
    }
    return obj;
  }, {});
}

function chooseDefaultPort(protocol) {
  return protocol === 'ftp' ? 21 : 22;
}

function setConfigValue(config, key, value) {
  if (config[key] === undefined) {
    if (key === 'port') {
      config[key] = parseInt(value, 10);
    } else {
      config[key] = value;
    }
  }
}

function mergeConfigWithExternalRefer(
  config: FileServiceConfig
): FileServiceConfig {
  const copyed = Object.assign({}, config);

  if (config.remote) {
    const remoteMap = getUserSetting(SETTING_KEY_REMOTE);
    const remote = remoteMap.get<Record<string, any>>(config.remote);
    if (!remote) {
      throw new Error(`Can\'t not find remote "${config.remote}"`);
    }
    const remoteKeyMapping = new Map([['scheme', 'protocol']]);

    const remoteKeyIgnored = new Map([['rootPath', 1]]);

    Object.keys(remote).forEach(key => {
      if (remoteKeyIgnored.has(key)) {
        return;
      }

      const targetKey = remoteKeyMapping.has(key)
        ? remoteKeyMapping.get(key)
        : key;
      setConfigValue(copyed, targetKey, remote[key]);
    });
  }

  if (config.protocol !== 'sftp') {
    return copyed;
  }

  const sshConfigPath = replaceHomePath(
    config.sshConfigPath || DEFAULT_SSHCONFIG_FILE
  );

  const cache = app.fsCache;
  let sshConfigContent;
  if (cache.has(sshConfigPath)) {
    sshConfigContent = cache.get(sshConfigPath);
  } else {
    try {
      sshConfigContent = fs.readFileSync(sshConfigPath, 'utf8');
    } catch (error) {
      logger.warn(error.message, `load ${sshConfigPath} failed`);
      sshConfigContent = '';
    }
    cache.set(sshConfigPath, sshConfigContent);
  }

  if (!sshConfigContent) {
    return copyed;
  }

  const parsedSSHConfig = sshConfig.parse(sshConfigContent);
  const section = parsedSSHConfig.find({
    Host: copyed.host,
  });

  if (section === null) {
    return copyed;
  }

  const mapping = new Map([
    ['hostname', 'host'],
    ['port', 'port'],
    ['user', 'username'],
    ['identityfile', 'privateKeyPath'],
    ['serveraliveinterval', 'keepalive'],
    ['connecttimeout', 'connTimeout'],
  ]);

  section.config.forEach(line => {
    if (!line.param) {
      return;
    }

    const key = mapping.get(line.param.toLowerCase());

    if (key !== undefined) {
      if (key === 'host') {
        copyed[key] = line.value;
      } else {
        setConfigValue(copyed, key, line.value);
      }
    }
  });

  // Bug introduced in pull request #69 : Fix ssh config resolution
  /* const parsedSSHConfig = sshConfig.parse(sshConfigContent);
  const computed = parsedSSHConfig.compute(copyed.host);

  const mapping = new Map([
    ['hostname', 'host'],
    ['port', 'port'],
    ['user', 'username'],
    ['serveraliveinterval', 'keepalive'],
    ['connecttimeout', 'connTimeout'],
  ]);

  Object.entries<any>(computed).forEach(([param, value]) => {
    if (param.toLowerCase() === 'identityfile') {
      setConfigValue(copyed, 'privateKeyPath', value[0]);
      return;
    }

    const key = mapping.get(param.toLowerCase());

    if (key !== undefined) {
      // don't need consider config priority, always set to the resolve host.
      if (key === 'host') {
        copyed[key] = value;
      } else {
        setConfigValue(copyed, key, value);
      }
    }
  }); */

  return copyed;
}

function getCompleteConfig(
  config: FileServiceConfig,
  workspace: string
): FileServiceConfig {
  const mergedConfig = mergeConfigWithExternalRefer(config);

  if (mergedConfig.agent && mergedConfig.privateKeyPath) {
    logger.warn(
      'Config Option Conflicted. You are specifing "agent" and "privateKey" at the same time, ' +
        'the later will be ignored.'
    );
  }

  // remove the './' part from a relative path
  mergedConfig.remotePath = upath.normalize(mergedConfig.remotePath);
  if (mergedConfig.privateKeyPath) {
    mergedConfig.privateKeyPath = resolvePath(
      workspace,
      mergedConfig.privateKeyPath
    );
  }

  if (mergedConfig.ignoreFile) {
    mergedConfig.ignoreFile = resolvePath(workspace, mergedConfig.ignoreFile);
  }

  // convert ingore config to ignore function
  if (mergedConfig.agent && mergedConfig.agent.startsWith('$')) {
    const evnVarName = mergedConfig.agent.slice(1);
    const val = process.env[evnVarName];
    if (!val) {
      throw new Error(`Environment variable "${evnVarName}" not found`);
    }
    mergedConfig.agent = val;
  }

  return mergedConfig;
}

// pattern lists accumulate base + profile instead of the profile replacing the
// base, so a profile can narrow what gets uploaded without restating the
// project-wide excludes
const CONCATENATED_KEYS = ['ignore', 'tempFilePatterns', 'uploadExclude'];

// nested option objects merge key by key, so `{"remoteTrash": {"enabled": false}}`
// in a profile keeps the inherited path and retention
const DEEP_MERGED_KEYS = ['remoteTrash', 'syncOption', 'remoteExplorer', 'externalChanges'];

function mergeProfile(
  target: FileServiceConfig,
  source: FileServiceConfig
): FileServiceConfig {
  const res = Object.assign({}, target);
  delete res.profiles;

  const keys = Object.keys(source);
  for (const key of keys) {
    if (CONCATENATED_KEYS.indexOf(key) !== -1) {
      const base = Array.isArray(res[key]) ? res[key] : [];
      const added = Array.isArray(source[key]) ? source[key] : [];
      res[key] = base.concat(added);
    } else if (
      DEEP_MERGED_KEYS.indexOf(key) !== -1 &&
      isPlainObject(res[key]) &&
      isPlainObject(source[key])
    ) {
      res[key] = Object.assign({}, res[key], source[key]);
    } else {
      res[key] = source[key];
    }
  }

  return res;
}

function isPlainObject(value: any): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const DEFAULT_REMOTE_TRASH: RemoteTrashConfig = {
  enabled: true,
  path: '.sftp-trash',
  retentionDays: 7,
};

/**
 * Fills in the trash options the user left out.
 *
 * `mergedDefault` is a shallow spread, so a config that sets only
 * `{"remoteTrash": {"enabled": false}}` replaces the whole default object and
 * would otherwise leave `path` undefined — which would then resolve to the
 * remote root and rename deleted files on top of it.
 */
export function resolveRemoteTrashConfig(config: {
  remoteTrash?: Partial<RemoteTrashConfig>;
}): RemoteTrashConfig {
  const trash = config.remoteTrash;
  if (!isPlainObject(trash)) {
    return { ...DEFAULT_REMOTE_TRASH };
  }

  return {
    enabled: trash!.enabled !== undefined ? Boolean(trash!.enabled) : DEFAULT_REMOTE_TRASH.enabled,
    path: trash!.path || DEFAULT_REMOTE_TRASH.path,
    retentionDays:
      typeof trash!.retentionDays === 'number'
        ? trash!.retentionDays
        : DEFAULT_REMOTE_TRASH.retentionDays,
  };
}

const DEFAULT_EXTERNAL_CHANGES: ExternalChangesConfig = {
  scanOnStartup: true,
  scanOnResume: true,
  confirmThreshold: 20,
  maxPlanItems: 2000,
  compareContent: true,
};

/**
 * Fills in the external-change options the user left out.
 *
 * Same reason as {@link resolveRemoteTrashConfig}: `mergedDefault` is a shallow
 * spread, so `{"externalChanges": {"confirmThreshold": 5}}` replaces the whole
 * default object and would otherwise leave the scan flags undefined.
 */
export function resolveExternalChangesConfig(config: {
  externalChanges?: Partial<ExternalChangesConfig>;
}): ExternalChangesConfig {
  const external = config.externalChanges;
  if (!isPlainObject(external)) {
    return { ...DEFAULT_EXTERNAL_CHANGES };
  }

  return {
    scanOnStartup:
      external!.scanOnStartup !== undefined
        ? Boolean(external!.scanOnStartup)
        : DEFAULT_EXTERNAL_CHANGES.scanOnStartup,
    scanOnResume:
      external!.scanOnResume !== undefined
        ? Boolean(external!.scanOnResume)
        : DEFAULT_EXTERNAL_CHANGES.scanOnResume,
    confirmThreshold:
      typeof external!.confirmThreshold === 'number' && external!.confirmThreshold >= 0
        ? external!.confirmThreshold
        : DEFAULT_EXTERNAL_CHANGES.confirmThreshold,
    maxPlanItems:
      typeof external!.maxPlanItems === 'number' && external!.maxPlanItems >= 0
        ? Math.floor(external!.maxPlanItems)
        : DEFAULT_EXTERNAL_CHANGES.maxPlanItems,
    compareContent:
      external!.compareContent !== undefined
        ? Boolean(external!.compareContent)
        : DEFAULT_EXTERNAL_CHANGES.compareContent,
  };
}

/** `watcher.pollInterval` in ms, 0 when polling is off or the watcher block is absent. */
export function resolvePollInterval(config: { watcher?: { pollInterval?: number } }): number {
  const watcher = config.watcher;
  if (!isPlainObject(watcher)) {
    return 0;
  }
  const interval = watcher!.pollInterval;
  return typeof interval === 'number' && interval > 0 ? Math.floor(interval) : 0;
}

enum Event {
  BEFORE_TRANSFER = 'BEFORE_TRANSFER',
  AFTER_TRANSFER = 'AFTER_TRANSFER',
}

let id = 0;

/**
 * The unit that binds one sftp.json config entry to a local base directory.
 *
 * Owns everything derived from that config: profile resolution, the ignore
 * matcher (which always excludes the config file itself), the file watcher,
 * transfer schedulers and the lazily-created remote filesystem. Created by
 * serviceManager, which indexes instances by base path to answer "which
 * service handles this file?".
 *
 * Key lifecycle methods:
 * - {@link getConfig} resolves the active profile into a ServiceConfig.
 * - {@link beforeTransfer}/{@link afterTransfer} expose transfer hooks.
 * - {@link dispose} tears down watcher, schedulers and remote fs.
 */
export default class FileService {
  private _eventEmitter: EventEmitter = new EventEmitter();
  private _name!: string;
  private _watcherConfig: WatcherConfig;
  private _profiles!: string[];
  private _pendingTransferTasks: Set<TransferTask> = new Set();
  private _transferSchedulers: TransferScheduler[] = [];
  private _config: FileServiceConfig;
  private _configValidator!: ConfigValidator;
  private _watcherService: WatcherService = {
    create() {
      /* do nothing  */
    },
    dispose() {
      /* do nothing  */
    },
  };
  id: number;
  baseDir: string;
  workspace: string;

  constructor(baseDir: string, workspace: string, config: FileServiceConfig) {
    this.id = ++id;
    this.workspace = workspace;
    this.baseDir = baseDir;
    this._watcherConfig = config.watcher;
    this._config = config;
    if (config.profiles) {
      this._profiles = Object.keys(config.profiles);
    }
  }

  get name(): string {
    return this._name ? this._name : '';
  }

  set name(name: string) {
    this._name = name;
  }

  setConfigValidator(configValidator: ConfigValidator) {
    this._configValidator = configValidator;
  }

  setWatcherService(watcherService: WatcherService) {
    if (this._watcherService) {
      this._disposeWatcher();
    }

    this._watcherService = watcherService;
    this._createWatcher();
  }

  getAvailableProfiles(): string[] {
    return this._profiles || [];
  }

  /**
   * The root-level `watcher` block as configured, without resolving the
   * profile: it is not profile-specific, and callers that poll it (the
   * external-change scanner) must not pay a validation per tick.
   */
  getWatcherConfig(): WatcherConfig | undefined {
    return this._watcherConfig;
  }

  getPendingTransferTasks(): TransferTask[] {
    return Array.from(this._pendingTransferTasks);
  }

  isTransferring() {
    return this._transferSchedulers.length > 0;
  }

  cancelTransferTasks() {
    // keep the order
    // 1, remove tasks not start
    this._transferSchedulers.forEach(transfer => transfer.stop());
    this._transferSchedulers.length = 0;

    // 2. cancel running task
    this._pendingTransferTasks.forEach(t => t.cancel());
    this._pendingTransferTasks.clear();
  }

  beforeTransfer(listener: (task: TransferTask) => void) {
    this._eventEmitter.on(Event.BEFORE_TRANSFER, listener);
  }

  afterTransfer(listener: (err: Error | null, task: TransferTask) => void) {
    this._eventEmitter.on(Event.AFTER_TRANSFER, listener);
  }

  createTransferScheduler(concurrency): TransferScheduler {
    const fileService = this;
    const scheduler = new Scheduler({
      autoStart: false,
      concurrency,
    });
    // Collected per scheduler and handed back by run(). The underlying
    // Scheduler swallows task errors (it only emits them through onTaskDone)
    // and goes idle either way, so without this a batch with a failed put
    // was indistinguishable from a clean one.
    const result: TransferResult = { succeeded: [], failed: [], cancelled: [] };
    scheduler.onTaskStart(task => {
      this._pendingTransferTasks.add(task as TransferTask);
      this._eventEmitter.emit(Event.BEFORE_TRANSFER, task);
    });
    scheduler.onTaskDone((err, task) => {
      const transferTask = task as TransferTask;
      this._pendingTransferTasks.delete(transferTask);
      if (transferTask.isCancelled()) {
        // aborting the stream makes run() throw too; that is the user's
        // choice, not a failure
        result.cancelled.push(transferTask);
      } else if (err) {
        result.failed.push({ task: transferTask, error: err });
        // the connection is gone: what is still queued would only fail the
        // same way, one file at a time, so it is dropped here and the caller
        // decides (a plan puts the items on hold, a command reports it once)
        if (!result.connectionLost && isConnectionLostError(err)) {
          result.connectionLost = err;
          scheduler.empty();
        }
      } else {
        result.succeeded.push(transferTask);
      }
      this._eventEmitter.emit(Event.AFTER_TRANSFER, err, task);
    });

    let runningPromise: Promise<TransferResult> | null = null;
    let isStopped: boolean = false;
    const transferScheduler: TransferScheduler = {
      get size() {
        return scheduler.size;
      },
      stop() {
        isStopped = true;
        scheduler.empty();
      },
      add(task: TransferTask) {
        if (isStopped) {
          return;
        }

        scheduler.add(task);
      },
      run() {
        if (isStopped) {
          return Promise.resolve(result);
        }

        if (scheduler.size <= 0) {
          fileService._removeScheduler(transferScheduler);
          return Promise.resolve(result);
        }

        if (!runningPromise) {
          runningPromise = new Promise(resolve => {
            scheduler.onIdle(() => {
              runningPromise = null;
              fileService._removeScheduler(transferScheduler);
              resolve(result);
            });
            scheduler.start();
          });
        }
        return runningPromise;
      },
    };
    fileService._storeScheduler(transferScheduler);

    return transferScheduler;
  }

  getLocalFileSystem(): FileSystem {
    return localFs;
  }

  getRemoteFileSystem(config: ServiceConfig): Promise<FileSystem> {
    return createRemoteIfNoneExist(getHostInfo(config));
  }

  /** The attempt policy of the connection `config` resolves to. */
  getConnectionGate(config: ServiceConfig): ConnectionGate {
    return connectionGateOf(getHostInfo(config));
  }

  /**
   * Closes the connection the service used under `previousProfile`, unless
   * the active profile resolves to the same connection (same host, port and
   * credentials: only the remote path differs). Called when the active
   * profile changes, so the connection of the profile just left does not
   * stay alive — with keepalives — for the rest of the session next to the
   * new one.
   */
  closeRemoteConnectionOfProfile(previousProfile: string | null): void {
    if (this.getAvailableProfiles().length === 0) {
      return;
    }
    let previous: ServiceConfig;
    try {
      previous = this.getConfig(previousProfile);
    } catch (_error) {
      // an unknown profile has no connection to close
      return;
    }
    try {
      const current = this.getConfig();
      if (isSameRemote(getHostInfo(previous), getHostInfo(current))) {
        return;
      }
    } catch (_error) {
      // no active profile yet: nothing shares the connection
    }
    removeRemoteFs(getHostInfo(previous));
  }

  getConfig(useProfile = app.state.profile): ServiceConfig {
    let config = this._config;
    const hasProfile =
      config.profiles && Object.keys(config.profiles).length > 0;
    if (hasProfile && useProfile) {
      logger.info(`Using profile: ${useProfile}`);
      const profile = config.profiles![useProfile];
      if (!profile) {
        throw new Error(
          `Unkown Profile "${useProfile}".` +
            ' Please check your profile setting.' +
            ' You can set a profile by running command `SFTP: Set Profile`.'
        );
      }
      config = mergeProfile(config, profile);
    }

    const completeConfig = getCompleteConfig(config, this.workspace);
    const error =
      this._configValidator && this._configValidator(completeConfig);
    if (error) {
      let errorMsg = `Config validation fail: ${error.message}.`;
      // tslint:disable-next-line triple-equals
      if (hasProfile && app.state.profile == null) {
        errorMsg += ' You might want to set a profile first.';
      }
      throw new Error(errorMsg);
    }

    return this._resolveServiceConfig(completeConfig);
  }

  getAllConfig(): Array<ServiceConfig> {
    const profiles = this._config.profiles;
    return profiles ? Object.keys(profiles).map(p => this.getConfig(p)) : [];
  }

  dispose() {
    this._disposeWatcher();
    this._disposeFileSystem();
  }

  private _resolveServiceConfig(
    fileServiceConfig: FileServiceConfig
  ): ServiceConfig {
    const serviceConfig: ServiceConfig = fileServiceConfig as any;

    if (serviceConfig.port === undefined) {
      serviceConfig.port = chooseDefaultPort(serviceConfig.protocol);
    }
    if (serviceConfig.protocol === 'ftp') {
      serviceConfig.concurrency = 1;
    }
    serviceConfig.ignore = this._createMatcher(
      filesIgnoredFromConfig(fileServiceConfig),
      fileServiceConfig.remotePath
    );
    serviceConfig.uploadExclude = this._createMatcher(
      Array.isArray(fileServiceConfig.uploadExclude) ? fileServiceConfig.uploadExclude : [],
      fileServiceConfig.remotePath
    );

    return serviceConfig;
  }

  private _storeScheduler(scheduler: TransferScheduler) {
    this._transferSchedulers.push(scheduler);
  }

  private _removeScheduler(scheduler: TransferScheduler) {
    const index = this._transferSchedulers.findIndex(s => s === scheduler);
    if (index !== -1) {
      this._transferSchedulers.splice(index, 1);
    }
  }

  /**
   * Turns a gitignore pattern list into a {@link PathMatcher} that accepts
   * both local paths (under the base dir) and remote ones (under
   * `remoteContext`), so one matcher serves either side of a transfer.
   */
  private _createMatcher(patterns: string[], remoteContext: string): PathMatcher | null {
    const localContext = this.baseDir;

    if (patterns.length <= 0) {
      return null;
    }

    const ignore = Ignore.from(patterns);
    const isWindows = process.platform === 'win32';
    const ignoreFunc = (fsPath: string, isDirectory?: boolean) => {
      // vscode will always return path with / as separator
      const normalizedPath = path.normalize(fsPath);
      // windows paths are case-insensitive
      const isLocal = isWindows
        ? normalizedPath.toLowerCase().indexOf(localContext.toLowerCase()) === 0
        : normalizedPath.indexOf(localContext) === 0;
      let relativePath;
      if (isLocal) {
        relativePath = path.relative(localContext, fsPath);
      } else {
        // remote path
        relativePath = upath.relative(remoteContext, fsPath);
      }

      // gitignore matching expects unix separators
      relativePath = relativePath.split(path.sep).join('/');

      // skip root
      if (relativePath === '') {
        return false;
      }
      if (ignore.ignores(relativePath)) {
        return true;
      }

      // `dir/` patterns — the usual spelling in an ignoreFile — match only a
      // path that ends in a slash. Without this, a scan or a folder transfer
      // walks into node_modules and rejects its files one by one.
      return Boolean(isDirectory) && ignore.ignores(relativePath + '/');
    };

    return ignoreFunc;
  }

  private _createWatcher() {
    this._watcherService.create(this.baseDir, this._watcherConfig);
  }

  private _disposeWatcher() {
    this._watcherService.dispose(this.baseDir);
  }

  // fixme: remote all profiles
  private _disposeFileSystem() {
    return removeRemoteFs(getHostInfo(this.getConfig()));
  }
}
