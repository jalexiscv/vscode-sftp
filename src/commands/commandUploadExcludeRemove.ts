import { Uri } from 'vscode';
import { COMMAND_UPLOAD_EXCLUDE_REMOVE } from '../constants';
import { reportError, simplifyPath } from '../helper';
import { showInformationMessage, showWarningMessage } from '../host';
import { FileService } from '../core';
import { getFileService } from '../modules/serviceManager';
import { patternForPath, removeExclusion } from '../modules/uploadExclusions';
import { checkCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

/**
 * "Include in Upload Again": drops the anchored pattern of the folder (or
 * file) under the cursor from the base `uploadExclude` list of its server.
 * The explorer only offers it on a path whose exact pattern is in the list
 * (`resourcePath in sftp.uploadExcludedPaths`).
 */
export default checkCommand({
  id: COMMAND_UPLOAD_EXCLUDE_REMOVE,

  async handleCommand(arg?: unknown, args?: unknown) {
    const target = uriFromExplorerContextOrEditorContext(arg, args);
    const uris = (!target ? [] : Array.isArray(target) ? target : [target]).filter(
      (uri: Uri) => uri.scheme === 'file'
    );
    if (uris.length === 0) {
      showWarningMessage('SFTP: select an excluded folder in the explorer first.');
      return;
    }

    for (const uri of uris) {
      const service: FileService | undefined = getFileService(uri);
      const pattern = service ? patternForPath(service, uri.fsPath) : null;
      if (!service || !pattern) {
        showWarningMessage(`SFTP: ${simplifyPath(uri.fsPath)} is not inside a configured project.`);
        continue;
      }
      try {
        const removed = await removeExclusion(service, pattern);
        if (removed) {
          showInformationMessage(
            `SFTP: ${pattern} is uploaded again to ${service.name || service.baseDir} (sftp.json updated).`
          );
        } else {
          showWarningMessage(
            `SFTP: ${pattern} is not in the base uploadExclude list of ${service.name || service.baseDir}; ` +
              'a pattern inherited from a profile has to be removed in sftp.json.'
          );
        }
      } catch (error) {
        reportError(error, 'include in upload again');
      }
    }
  },
});
