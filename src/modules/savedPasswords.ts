import * as vscode from 'vscode';
import logger from '../logger';
import { getExtensionSetting } from './ext';

/**
 * Optional password persistence backed by vscode SecretStorage (the OS
 * keychain). Passwords are stored only when the user accepts the prompt
 * shown after a successful connection, and can be wiped with the
 * "SFTP: Forget Saved Passwords" command.
 *
 * SecretStorage can't enumerate its keys, so an index of stored keys is
 * kept in globalState to support "forget all".
 */

const INDEX_KEY = 'sftp.savedPasswordKeys';

// vscode.SecretStorage is missing from our old @types/vscode; keep it untyped
let secrets: any;
let memento: vscode.Memento | undefined;

export function initSavedPasswords(context: vscode.ExtensionContext) {
  secrets = (context as any).secrets;
  memento = context.globalState;
}

export function isSavedPasswordsAvailable(): boolean {
  return Boolean(secrets && memento);
}

export function passwordKey(option: { host: string; port?: number; username?: string }): string {
  return `sftp:password:${option.username || ''}@${option.host}:${option.port || ''}`;
}

export async function getSavedPassword(key: string): Promise<string | undefined> {
  if (!isSavedPasswordsAvailable()) {
    return undefined;
  }

  try {
    return await secrets.get(key);
  } catch (error) {
    logger.warn(`can't read saved password: ${error.message}`);
    return undefined;
  }
}

export async function savePassword(key: string, password: string): Promise<void> {
  if (!isSavedPasswordsAvailable()) {
    return;
  }

  await secrets.store(key, password);
  const index = memento!.get<string[]>(INDEX_KEY, []);
  if (index.indexOf(key) === -1) {
    await memento!.update(INDEX_KEY, index.concat(key));
  }
}

export async function removeSavedPassword(key: string): Promise<void> {
  if (!isSavedPasswordsAvailable()) {
    return;
  }

  try {
    await secrets.delete(key);
  } catch (error) {
    logger.warn(`can't delete saved password: ${error.message}`);
  }
  const index = memento!.get<string[]>(INDEX_KEY, []);
  await memento!.update(INDEX_KEY, index.filter(k => k !== key));
}

export async function clearSavedPasswords(): Promise<number> {
  if (!isSavedPasswordsAvailable()) {
    return 0;
  }

  const index = memento!.get<string[]>(INDEX_KEY, []);
  for (const key of index) {
    try {
      await secrets.delete(key);
    } catch (error) {
      logger.warn(`can't delete saved password: ${error.message}`);
    }
  }
  await memento!.update(INDEX_KEY, []);
  return index.length;
}

// fire-and-forget: ask the user whether to remember a password that just
// worked. Gated by the sftp.promptToSavePassword setting.
export async function offerToSavePassword(key: string, password: string, label: string) {
  if (!isSavedPasswordsAvailable()) {
    return;
  }
  if (getExtensionSetting().get('promptToSavePassword', true) !== true) {
    return;
  }

  try {
    const choice = await vscode.window.showInformationMessage(
      `SFTP: Save the password for ${label}? It will be stored securely by VS Code.`,
      'Save',
      'Not now'
    );
    if (choice === 'Save') {
      await savePassword(key, password);
      logger.info(`password saved for ${label}`);
    }
  } catch (error) {
    logger.warn(`can't save password: ${error.message}`);
  }
}
