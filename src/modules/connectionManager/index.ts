import * as path from 'path';
import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import app from '../../app';
import logger from '../../logger';
import { CONFIG_PATH } from '../../constants';
import { getWorkspaceFolders, showTextDocument } from '../../host';
import { testRemoteConnection } from '../../core/remoteFs';
import { mergedDefault, validateConfig, newConfig } from '../config';
import getConnectionManagerHtml from './webviewHtml';

interface ManagerState {
  exists: boolean;
  isArray: boolean;
  base: any;
  profiles: { [x: string]: any };
  activeProfile: string | null;
}

// opciones que no intervienen en la conexión (mismo criterio que getHostInfo
// de fileService, más los campos de organización del propio sftp.json)
const NON_CONNECT_OPTIONS = [
  'name',
  'remotePath',
  'uploadOnSave',
  'useTempFile',
  'openSsh',
  'downloadOnOpen',
  'ignore',
  'ignoreFile',
  'watcher',
  'concurrency',
  'syncOption',
  'sshConfigPath',
  'sshCustomParams',
  'context',
  'remoteExplorer',
  'profiles',
  'defaultProfile',
];

let panel: vscode.WebviewPanel | undefined;

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function post(message: any) {
  if (panel) {
    panel.webview.postMessage(message);
  }
}

function getConfigFilePath(workspace: string): string {
  return path.join(workspace, CONFIG_PATH);
}

function stripMeta(config: any): any {
  const copy = Object.assign({}, config);
  delete copy.profiles;
  delete copy.defaultProfile;
  return copy;
}

// réplica de la fusión base+perfil de fileService.mergeProfile
function mergeForProfile(base: any, profile: any): any {
  const merged = Object.assign(stripMeta(base), profile);
  if (Array.isArray(base.ignore) && Array.isArray(profile.ignore)) {
    merged.ignore = base.ignore.concat(profile.ignore);
  }
  return merged;
}

function toConnectOption(config: any): any {
  const option: any = {};
  Object.keys(config).forEach(key => {
    if (NON_CONNECT_OPTIONS.indexOf(key) === -1) {
      option[key] = config[key];
    }
  });
  if (option.port === undefined) {
    option.port = option.protocol === 'ftp' ? 21 : 22;
  }
  return option;
}

function validateAll(config: any, profiles: { [x: string]: any }): string | undefined {
  const names = Object.keys(profiles || {});
  if (names.length === 0) {
    const error = validateConfig(mergedDefault(stripMeta(config)));
    return error ? `Configuración base: ${error.message}` : undefined;
  }

  for (const name of names) {
    const error = validateConfig(mergedDefault(mergeForProfile(config, profiles[name])));
    if (error) {
      return `Conexión "${name}": ${error.message}`;
    }
  }
  return undefined;
}

async function buildState(workspace: string): Promise<ManagerState> {
  const configPath = getConfigFilePath(workspace);
  const exists = await fse.pathExists(configPath);
  let isArray = false;
  let base: any;
  let profiles: { [x: string]: any } = {};

  if (exists) {
    const raw = await fse.readJson(configPath);
    let config = raw;
    if (Array.isArray(raw)) {
      isArray = true;
      config = raw[0] || {};
    }
    base = Object.assign({}, config);
    profiles = base.profiles ? Object.assign({}, base.profiles) : {};
    delete base.profiles;
  } else {
    base = {
      name: 'My Server',
      protocol: 'sftp',
      host: 'localhost',
      port: 22,
      username: 'username',
      remotePath: '/',
      uploadOnSave: false,
    };
  }

  return { exists, isArray, base, profiles, activeProfile: app.state.profile };
}

async function sendState(workspace: string) {
  try {
    post({ type: 'state', workspace, state: await buildState(workspace) });
  } catch (error) {
    post({ type: 'stateError', error: error.message || String(error) });
  }
}

async function handleReady() {
  const folders = getWorkspaceFolders();
  if (!folders || folders.length <= 0) {
    post({ type: 'stateError', error: 'No hay ninguna carpeta abierta en VSCode.' });
    return;
  }

  const workspaces = folders.map(folder => ({
    name: folder.name,
    fsPath: folder.uri.fsPath,
  }));
  const workspace = workspaces[0].fsPath;
  try {
    post({ type: 'init', workspaces, workspace, state: await buildState(workspace) });
  } catch (error) {
    post({ type: 'stateError', error: error.message || String(error) });
  }
}

async function handleSave(workspace: string, base: any, profiles: { [x: string]: any }) {
  const config = Object.assign({}, base);
  const profileNames = Object.keys(profiles || {});
  if (profileNames.length > 0) {
    config.profiles = profiles;
    if (config.defaultProfile && !profiles[config.defaultProfile]) {
      delete config.defaultProfile;
    }
  } else {
    delete config.profiles;
    delete config.defaultProfile;
  }

  const validationError = validateAll(config, profiles || {});
  if (validationError) {
    post({ type: 'saveResult', ok: false, error: validationError });
    return;
  }

  const configPath = getConfigFilePath(workspace);
  let output: any = config;
  if (await fse.pathExists(configPath)) {
    try {
      const raw = await fse.readJson(configPath);
      if (Array.isArray(raw)) {
        raw[0] = config;
        output = raw;
      }
    } catch (error) {
      // el archivo estaba corrupto: se sobrescribe con la nueva configuración
    }
  }
  await fse.outputJson(configPath, output, { spaces: 4 });
  logger.info(`[connection-manager] saved ${configPath}`);

  // si el perfil activo dejó de existir, caer al perfil por defecto
  if (app.state.profile && !(config.profiles && config.profiles[app.state.profile])) {
    app.state.profile = config.defaultProfile || null;
  }

  post({ type: 'saveResult', ok: true });
  await sendState(workspace);
}

async function handleTest(
  workspace: string,
  base: any,
  profiles: { [x: string]: any },
  profileName: string | null
) {
  const raw = profileName
    ? mergeForProfile(base, (profiles || {})[profileName] || {})
    : stripMeta(base);
  const merged = mergedDefault(raw);

  const error = validateConfig(merged);
  if (error) {
    post({ type: 'testResult', target: profileName, ok: false, error: error.message });
    return;
  }

  try {
    await testRemoteConnection(toConnectOption(merged));
    post({ type: 'testResult', target: profileName, ok: true });
  } catch (err) {
    post({
      type: 'testResult',
      target: profileName,
      ok: false,
      error: err.message || String(err),
    });
  }
}

async function handleOpenJson(workspace: string) {
  const configPath = getConfigFilePath(workspace);
  if (await fse.pathExists(configPath)) {
    await showTextDocument(vscode.Uri.file(configPath));
  } else {
    await newConfig(workspace);
  }
}

async function handleMessage(message: any) {
  switch (message.type) {
    case 'ready':
      await handleReady();
      break;
    case 'load':
      await sendState(message.workspace);
      break;
    case 'save':
      await handleSave(message.workspace, message.base, message.profiles);
      break;
    case 'test':
      await handleTest(message.workspace, message.base, message.profiles, message.profile);
      break;
    case 'activate': {
      const profile = message.profile || null;
      if (profile) {
        // un perfil sin guardar no existe para los servicios: activarlo
        // rompería cualquier operación posterior
        const saved = await buildState(message.workspace);
        if (saved.profiles[profile] === undefined) {
          post({
            type: 'errorMsg',
            error: `La conexión "${profile}" aún no está guardada. Guarda los cambios antes de activarla.`,
          });
          break;
        }
      }
      app.state.profile = profile;
      post({ type: 'activeProfile', profile: app.state.profile });
      break;
    }
    case 'openJson':
      await handleOpenJson(message.workspace);
      break;
    default:
      logger.warn(`[connection-manager] unknown message "${message.type}"`);
  }
}

export function openConnectionManager() {
  if (panel) {
    panel.reveal();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'sftp.connectionManager',
    'SFTP: Administrador de Conexiones',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );
  panel.webview.html = getConnectionManagerHtml(getNonce());
  panel.onDidDispose(() => {
    panel = undefined;
  });
  panel.webview.onDidReceiveMessage(message => {
    handleMessage(message).catch(error => {
      logger.error(error, 'connection manager');
      post({
        type: 'stateError',
        error: (error && error.message) || String(error),
      });
    });
  });
}
