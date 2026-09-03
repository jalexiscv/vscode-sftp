import * as vscode from 'vscode';
import * as path from 'path';
import { COMMAND_UPLOAD_CHANGEDFILES } from '../constants';
import { FileService, ServiceConfig, isExcludedFromMirroring } from '../core';
import { getFileService } from '../modules/serviceManager';
import { uploadFile, renameRemote, removeRemote } from '../fileHandlers';
import { getGitService, GitAPI, Repository, Status, Change } from '../modules/git';
import { checkCommand } from './abstract/createCommand';
import logger from '../logger';
import { simplifyPath } from '../helper';
import { showConfirmMessage } from '../host';

export default checkCommand({
  id: COMMAND_UPLOAD_CHANGEDFILES,

  async handleCommand(hint: any) {
    return handleCommand(hint);

    // resourceGroup.resourceStates.forEach(resourceState => {
    //   resourceState.
    //   console.log(resourceState.decorations);
    // });

    // try {
    //   await uploadFile(ctx, { ignore: null });
    // } catch (error) {
    //   // ignore error when try to upload a deleted file
    //   if (error.code !== 'ENOENT') {
    //     throw error;
    //   }
    // }
  },
});

function isRepository(object: any): object is Repository {
  return 'rootUri' in object;
}

function isSourceControlResourceGroup(object: any): object is vscode.SourceControlResourceGroup {
  return 'id' in object && 'resourceStates' in object;
}

/**
 * Whether the config keeps this change off the server — `ignore` or
 * `uploadExclude` match its path, or either end of a rename. The handlers
 * would refuse each of these on their own, one notification per file; set
 * aside here, they are listed once in the result instead.
 */
function isExcludedChange(fileService: FileService, change: Change): boolean {
  let config: ServiceConfig;
  try {
    config = fileService.getConfig();
  } catch (error) {
    // an unusable config fails in the handler, with its own message
    return false;
  }

  // `uri` is the new path of a rename; the old one is where it came from
  const paths = [change.uri.fsPath];
  if (change.renameUri) {
    paths.push(change.originalUri.fsPath);
  }
  return paths.some(fsPath => isExcludedFromMirroring(config, fsPath));
}

async function handleCommand(hint: any) {
  let repository: Repository | undefined;
  let filterGroupId;
  const git = getGitService();

  if (!hint) {
    repository = await getRepository(git);
  } else if (isSourceControlResourceGroup(hint)) {
    repository = git.repositories.find(repo => repo.ui.selected);
    filterGroupId = hint.id;
  } else if (isRepository(hint)) {
    repository = git.repositories.find(repo => repo.ui.selected);
  }

  if (!repository) {
    return;
  }

  let changes: Change[];
  if (filterGroupId === 'index') {
    changes = repository.state.indexChanges;
  } else if (filterGroupId === 'workingTree') {
    changes = repository.state.workingTreeChanges;
  } else {
    changes = repository.state.indexChanges.concat(repository.state.workingTreeChanges);
  }

  const creates: Change[] = [];
  const uploads: Change[] = [];
  const renames: Change[] = [];
  const deletes: Change[] = [];
  const excluded: Change[] = [];
  for (const change of changes) {
    const fileService = getFileService(change.uri);
    if (!fileService) {
      continue;
    }

    if (isExcludedChange(fileService, change)) {
      excluded.push(change);
      continue;
    }

    switch (change.status) {
      case Status.INDEX_MODIFIED:
      case Status.MODIFIED:
        uploads.push(change);
        break;
      case Status.INDEX_ADDED:
      case Status.UNTRACKED:
        creates.push(change);
        break;
      case Status.INDEX_RENAMED:
        renames.push(change);
        break;
      case Status.INDEX_DELETED:
      case Status.DELETED:
        deletes.push(change);
        break;
      default:
        break;
    }
  }

  // every phase awaits its own promises: the callbacks used to be synchronous,
  // so Promise.all got undefined[], nothing was waited for and the rejections
  // escaped the try/catch as unhandled ones — the failure logs below never ran
  await Promise.all(
    creates.concat(uploads).map(async change => {
      try {
        await uploadFile(change.uri);
      } catch (e) {
        logger.error('Upload failed.', e);
      }
    })
  );
  await Promise.all(
    renames.map(async change => {
      try {
        // the handler targets the new path and translates fromLocalPath itself
        await renameRemote(change.renameUri!, { fromLocalPath: change.originalUri.fsPath });
      } catch (e) {
        logger.error('Rename failed.', e);
      }
    })
  );

  // Deleting on the server is the one irreversible half of this command, and
  // a staged deletion is a git decision, not necessarily a "remove it from
  // production" one. Ask before mirroring it.
  let skippedDeletes = false;
  if (deletes.length > 0) {
    const confirmed = await showConfirmMessage(
      `Delete ${deletes.length} file(s) on ${describeTarget(deletes)}?`,
      'Delete',
      'Skip'
    );
    if (confirmed) {
      await Promise.all(
        deletes.map(async change => {
          try {
            await removeRemote(change.uri);
          } catch (e) {
            logger.error('Deletion failed.', e);
          }
        })
      );
    } else {
      skippedDeletes = true;
    }
  }

  logger.log('');
  logger.log('------ Upload Changed Files Result ------');
  outputGroup('create', creates, c => simplifyPath(c.uri.fsPath));
  outputGroup('upload', uploads, c => simplifyPath(c.uri.fsPath));
  outputGroup(
    'renamed',
    renames,
    c => `${simplifyPath(c.originalUri.fsPath)} ➞ ${simplifyPath(c.renameUri!.fsPath)}`
  );
  outputGroup(
    skippedDeletes ? 'deleted (skipped, not mirrored)' : 'deleted',
    deletes,
    c => simplifyPath(c.uri.fsPath)
  );
  outputGroup('excluded by ignore / uploadExclude (not touched)', excluded, c =>
    simplifyPath(c.uri.fsPath)
  );
}

// Names the servers the deletions would reach, so the prompt says *where*.
function describeTarget(changes: Change[]): string {
  const names = new Set<string>();
  changes.forEach(change => {
    const fileService = getFileService(change.uri);
    if (!fileService) {
      return;
    }

    let host: string | undefined;
    try {
      host = fileService.getConfig().host;
    } catch (e) {
      // an unresolvable config is the transfer's problem, not the prompt's
    }

    const label = [fileService.name, host].filter(part => Boolean(part)).join(' - ');
    if (label) {
      names.add(label);
    }
  });

  const targets = Array.from(names);
  return targets.length > 0 ? targets.join(', ') : 'the remote';
}

function outputGroup<T>(label: string, items: T[], formatItem: (x: T) => string) {
  if (items.length <= 0) {
    return;
  }

  logger.log(`${label.toUpperCase()}:`);
  logger.log(items.map(i => formatItem(i)).join('\n'));
  logger.log('');
}

async function getRepository(git: GitAPI): Promise<Repository | undefined> {
  if (git.repositories.length === 1) {
    return git.repositories[0];
  }

  if (git.repositories.length === 0) {
    throw new Error('There are no available repositories');
  }

  const picks = git.repositories.map(repo => {
    const label = path.basename(repo.rootUri.fsPath);
    const description = repo.state.HEAD ? repo.state.HEAD.name : '';

    return {
      label,
      description,
      repository: repo,
    };
  });

  const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Choose a repository' });

  return pick && pick.repository;
}
