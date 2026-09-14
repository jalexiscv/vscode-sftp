import { Uri, window } from 'vscode';
import { COMMAND_UPLOAD_EXCLUDE_MANAGE } from '../constants';
import { reportError, simplifyPath } from '../helper';
import {
  showChoiceMessage,
  showInformationMessage,
  showOpenDialog,
  showQuickPick,
  showWarningMessage,
} from '../host';
import { FileService } from '../core';
import {
  ExclusionEntry,
  addExclusions,
  listExclusions,
  patternForPath,
  removeExclusion,
} from '../modules/uploadExclusions';
import { checkCommand } from './abstract/createCommand';
import { pickService } from './shared';

/**
 * "Manage Upload Exclusions": a QuickPick over the `uploadExclude` list of a
 * server, with two entries to add (a folder picked in a dialog, or a pattern
 * typed in) and one row per pattern; picking a row offers to remove it. The
 * pick comes back after every action, so several changes are one sitting.
 */

const ADD_FOLDER = 'add-folder';
const ADD_PATTERN = 'add-pattern';

interface PickItem {
  label: string;
  description?: string;
  detail?: string;
  action?: typeof ADD_FOLDER | typeof ADD_PATTERN;
  entry?: ExclusionEntry;
}

function buildItems(entries: ExclusionEntry[]): PickItem[] {
  const items: PickItem[] = [
    { label: '$(folder-opened) Add a folder…', action: ADD_FOLDER },
    { label: '$(edit) Add a pattern…', action: ADD_PATTERN },
  ];
  entries.forEach(entry => {
    items.push({
      label: `$(circle-slash) ${entry.pattern}`,
      description:
        entry.source === 'profile'
          ? `from profile "${entry.profile}" — edit in sftp.json`
          : entry.localPath
          ? simplifyPath(entry.localPath)
          : 'pattern',
      entry,
    });
  });
  return items;
}

async function addFolders(service: FileService): Promise<void> {
  const picked = await showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    defaultUri: Uri.file(service.baseDir),
    openLabel: 'Exclude from upload',
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const patterns: string[] = [];
  const outside: string[] = [];
  picked.forEach(uri => {
    const pattern = patternForPath(service, uri.fsPath);
    if (pattern) {
      patterns.push(pattern);
    } else {
      outside.push(simplifyPath(uri.fsPath) || uri.fsPath);
    }
  });
  if (outside.length > 0) {
    showWarningMessage(
      `SFTP: ${outside.join(', ')} is not inside ${service.name || service.baseDir}; skipped.`
    );
  }
  if (patterns.length > 0) {
    await addExclusions(service, patterns);
  }
}

async function addPattern(service: FileService): Promise<void> {
  const value = await window.showInputBox({
    prompt: `gitignore pattern to add to uploadExclude of ${service.name || service.baseDir}`,
    placeHolder: '/storage, /public/uploads, *.env, cache/',
    validateInput: text => (text.trim() ? undefined : 'Type a pattern'),
  });
  if (value && value.trim()) {
    const [result] = await addExclusions(service, [value.trim()]);
    if (result && result.outcome === 'exists') {
      showInformationMessage(`SFTP: ${result.pattern} is already excluded.`);
    }
  }
}

async function offerRemoval(service: FileService, entry: ExclusionEntry): Promise<void> {
  if (entry.source === 'profile') {
    showInformationMessage(
      `SFTP: ${entry.pattern} comes from profile "${entry.profile}"; remove it in sftp.json.`
    );
    return;
  }
  const removeLabel = 'Remove';
  const choice = await showChoiceMessage(
    `SFTP: remove ${entry.pattern} from the upload exclusions of ${service.name || service.baseDir}? ` +
      'It will be uploaded again like any other path.',
    [removeLabel],
    { modal: true }
  );
  if (choice === removeLabel) {
    await removeExclusion(service, entry.pattern);
  }
}

export default checkCommand({
  id: COMMAND_UPLOAD_EXCLUDE_MANAGE,

  async handleCommand() {
    const service = await pickService('Select the connection whose upload exclusions to manage');
    if (!service) {
      return;
    }

    try {
      // the pick comes back after every action until it is dismissed
      while (true) {
        const entries = await listExclusions(service);
        const picked = await showQuickPick(buildItems(entries), {
          placeHolder:
            entries.length === 0
              ? `${service.name || service.baseDir}: nothing is excluded from upload yet`
              : `${service.name || service.baseDir}: ${entries.length} upload exclusion(s) — pick one to remove it`,
          matchOnDescription: true,
        });
        if (!picked) {
          return;
        }
        if (picked.action === ADD_FOLDER) {
          await addFolders(service);
        } else if (picked.action === ADD_PATTERN) {
          await addPattern(service);
        } else if (picked.entry) {
          await offerRemoval(service, picked.entry);
        }
      }
    } catch (error) {
      reportError(error, 'manage upload exclusions');
    }
  },
});
