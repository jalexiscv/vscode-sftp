import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import * as path from 'path';
import * as Joi from 'joi';
import { CONFIG_PATH } from '../constants';
import { reportError } from '../helper';
import { showTextDocument } from '../host';

const nullable = schema => schema.optional().allow(null);

const configScheme = {
  name: Joi.string(),

  context: Joi.string(),
  protocol: Joi.any().valid('sftp', 'ftp', 'local'),

  host: Joi.string().required(),
  port: Joi.number().integer(),
  connectTimeout: Joi.number().integer(),
  username: Joi.string().required(),
  password: nullable(Joi.string()),

  agent: nullable(Joi.string()),
  privateKeyPath: nullable(Joi.string()),
  passphrase: nullable(Joi.string().allow(true)),
  interactiveAuth: Joi.alternatives([
    Joi.boolean(),
    Joi.array()
      .items(Joi.string()),
  ]).optional(),
  algorithms: Joi.any(),
  sshConfigPath: Joi.string(),
  sshCustomParams: Joi.string(),

  secure: Joi.any().valid(true, false, 'control', 'implicit'),
  secureOptions: nullable(Joi.object()),
  passive: Joi.boolean(),

  remotePath: Joi.string().required(),
  // octal digits carried in a number, e.g. 644 — parsed with parseInt(x, 8).
  // Validated so a string or boolean can't reach that parse as NaN.
  filePerm: Joi.number().integer(),
  dirPerm: Joi.number().integer(),
  uploadOnSave: Joi.boolean(),
  useTempFile: Joi.boolean(),
  openSsh: Joi.boolean(),
  downloadOnOpen: Joi.boolean().allow('confirm'),
  // post-upload check and retries; see core/transferTask
  verifyUpload: Joi.string().valid('none', 'stat'),
  uploadRetries: Joi.number().integer().min(0),

  ignore: Joi.array()
    .min(0)
    .items(Joi.string()),
  ignoreFile: Joi.string(),
  ignoreTempFiles: Joi.boolean(),
  tempFilePatterns: Joi.array()
    .min(0)
    .items(Joi.string()),
  watcher: {
    files: Joi.string().allow(false, null),
    autoUpload: Joi.boolean(),
    autoDelete: Joi.boolean(),
    // ms between scans of the local tree against the sync index; 0 disables
    pollInterval: Joi.number().integer().min(0),
  },
  concurrency: Joi.number().integer(),

  deleteRemoteOnLocalDelete: Joi.boolean(),
  deleteRemoteConfirmThreshold: Joi.number().integer().min(0),
  renameRemoteOnLocalRename: Joi.boolean(),
  remoteTrash: {
    enabled: Joi.boolean(),
    path: Joi.string(),
    retentionDays: Joi.number().min(0),
  },

  syncOption: {
    delete: Joi.boolean(),
    skipCreate: Joi.boolean(),
    ignoreExisting: Joi.boolean(),
    update: Joi.boolean(),
  },
  remoteTimeOffsetInHours: Joi.number(),

  remoteExplorer: {
    filesExclude: Joi.array()
      .min(0)
      .items(Joi.string()),
    order: Joi.number(),
  },

  // reconciliation of the local tree against the sync index; see
  // modules/externalChangeScanner
  externalChanges: {
    scanOnStartup: Joi.boolean(),
    scanOnResume: Joi.boolean(),
    confirmThreshold: Joi.number().integer().min(0),
  },
};

const defaultConfig = {
  // common
  // name: undefined,
  remotePath: './',
  uploadOnSave: false,
  useTempFile: false,
  openSsh: false,
  downloadOnOpen: false,
  // every upload is checked against the server and retried before it is
  // reported as failed; 'none' keeps only the protocol ack and the byte count
  verifyUpload: 'stat',
  uploadRetries: 2,
  ignore: [],
  // ignoreFile: undefined,
  ignoreTempFiles: true,
  tempFilePatterns: [],
  // watcher: {
  //   files: false,
  //   autoUpload: false,
  //   autoDelete: false,
  // },
  concurrency: 4,
  // limitOpenFilesOnRemote: false

  // mirror local deletions to the server. On by default because the opposite
  // silently drifts the two sides apart; the confirm threshold below is what
  // keeps a bulk deletion (a git checkout, a `rm -rf`) from going through
  // unnoticed.
  deleteRemoteOnLocalDelete: true,
  deleteRemoteConfirmThreshold: 10,
  renameRemoteOnLocalRename: true,
  remoteTrash: {
    enabled: true,
    path: '.sftp-trash',
    retentionDays: 7,
  },

  protocol: 'sftp',

  // server common
  // host,
  // port,
  // username,
  // password,
  connectTimeout: 10 * 1000,

  // sftp
  // agent,
  // privateKeyPath,
  // passphrase,
  interactiveAuth: false,
  // algorithms,

  // ftp
  secure: false,
  // secureOptions,
  // passive: false,
  remoteTimeOffsetInHours: 0,

  remoteExplorer: {
    order: 0,
  },

  // edits made while VS Code was closed are picked up by a scan at activation
  // and on resume; a batch above the threshold asks before uploading
  externalChanges: {
    scanOnStartup: true,
    scanOnResume: true,
    confirmThreshold: 20,
  },
};

export function mergedDefault(config) {
  return {
    ...defaultConfig,
    ...config,
  };
}

function getConfigPath(basePath) {
  return path.join(basePath, CONFIG_PATH);
}

export function validateConfig(config) {
  const { error } = Joi.validate(config, configScheme, {
    allowUnknown: true,
    convert: false,
    language: {
      object: {
        child: '!!prop "{{!child}}" fails because {{reason}}',
      },
    },
  });
  return error;
}

export function readConfigsFromFile(configPath): Promise<any[]> {
  return fse.readJson(configPath).then(config => {
    const configs = Array.isArray(config) ? config : [config];
    return configs.map(mergedDefault);
  });
}

export function tryLoadConfigs(workspace): Promise<any[]> {
  const configPath = getConfigPath(workspace);
  return fse.pathExists(configPath).then(
    exist => {
      if (exist) {
        return readConfigsFromFile(configPath);
      }
      return [];
    },
    _ => []
  );
}

// export function getConfig(activityPath: string) {
//   const config = configTrie.findPrefix(normalizePath(activityPath));
//   if (!config) {
//     throw new Error(`(${activityPath}) config file not found`);
//   }

//   return normalizeConfig(config);
// }

export function newConfig(basePath) {
  const configPath = getConfigPath(basePath);

  return fse
    .pathExists(configPath)
    .then(exist => {
      if (exist) {
        return showTextDocument(vscode.Uri.file(configPath));
      }

      return fse
        .outputJson(
          configPath,
          {
            name: 'My Server',
            host: 'localhost',
            protocol: 'sftp',
            port: 22,
            username: 'username',
            remotePath: '/',
            uploadOnSave: false,
            useTempFile: false,
            openSsh: false,
          },
          { spaces: 4 }
        )
        .then(() => showTextDocument(vscode.Uri.file(configPath)));
    })
    .catch(reportError);
}
