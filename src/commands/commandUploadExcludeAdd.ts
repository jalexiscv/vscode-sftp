import { Uri } from 'vscode';
import { COMMAND_UPLOAD_EXCLUDE_ADD } from '../constants';
import { reportError, simplifyPath } from '../helper';
import { showInformationMessage, showOpenDialog, showWarningMessage } from '../host';
import { FileService } from '../core';
import { getFileService } from '../modules/serviceManager';
import { AddResult, excludePath } from '../modules/uploadExclusions';
import { checkCommand } from './abstract/createCommand';
import { pickService } from './shared';
import { uriFromExplorerContextOrEditorContext } from './shared';

/**
 * "Exclude from Upload": the folder (or file) under the cursor — or, from
 * the palette, folders picked in a dialog — is added to the `uploadExclude`
 * list of the server that owns it, as an anchored pattern. Several selected
 * folders are one write per server.
 */

function localUris(arg: unknown, args: unknown): Uri[] {
  const target = uriFromExplorerContextOrEditorContext(arg, args);
  const list = !target ? [] : Array.isArray(target) ? target : [target];
  return list.filter(uri => uri.scheme === 'file');
}

async function pickFolders(): Promise<Uri[]> {
  const service = await pickService('Select the connection whose upload exclusions to edit');
  if (!service) {
    return [];
  }
  const picked = await showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    defaultUri: Uri.file(service.baseDir),
    openLabel: 'Exclude from upload',
  });
  return picked || [];
}

export function describeResults(serviceName: string, results: AddResult[]): string {
  const added = results.filter(result => result.outcome === 'added').map(result => result.pattern);
  const existing = results.filter(result => result.outcome === 'exists').map(result => result.pattern);
  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`${added.join(', ')} excluded from upload to ${serviceName} (saved in sftp.json)`);
  }
  if (existing.length > 0) {
    parts.push(`${existing.join(', ')} already excluded`);
  }
  return `SFTP: ${parts.join('; ')}.`;
}

export default checkCommand({
  id: COMMAND_UPLOAD_EXCLUDE_ADD,

  async handleCommand(arg?: unknown, args?: unknown) {
    let uris = localUris(arg, args);
    if (uris.length === 0) {
      uris = await pickFolders();
    }
    if (uris.length === 0) {
      return;
    }

    const byService = new Map<FileService, Uri[]>();
    const orphans: string[] = [];
    uris.forEach(uri => {
      const service: FileService | undefined = getFileService(uri);
      if (!service) {
        orphans.push(uri.fsPath);
        return;
      }
      const list = byService.get(service) || [];
      list.push(uri);
      byService.set(service, list);
    });
    if (orphans.length > 0) {
      showWarningMessage(
        `SFTP: no sftp.json covers ${orphans.map(simplifyPath).join(', ')}; nothing to exclude it from.`
      );
    }

    for (const [service, list] of Array.from(byService.entries())) {
      try {
        const results: AddResult[] = [];
        for (const uri of list) {
          results.push(await excludePath(service, uri.fsPath));
        }
        const outside = results.filter(result => result.outcome === 'outside');
        if (outside.length > 0) {
          showWarningMessage(
            `SFTP: ${outside.map(result => simplifyPath(result.pattern)).join(', ')} is the root of ` +
              `${service.name || service.baseDir}; the whole tree cannot be excluded.`
          );
        }
        const rest = results.filter(result => result.outcome !== 'outside');
        if (rest.length > 0) {
          showInformationMessage(describeResults(service.name || service.baseDir, rest));
        }
      } catch (error) {
        reportError(error, 'exclude from upload');
      }
    }
  },
});
