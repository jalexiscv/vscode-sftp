import * as path from 'path';
import { Uri, window } from 'vscode';
import logger from '../../logger';
import { reportError, markReported } from '../../helper';
import { handleCtxFromUri, allHandleCtxFromUri, FileHandlerContext } from '../../fileHandlers';
import {
  COMMAND_UPLOAD_FILE_TO_ALL_PROFILES,
  COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES,
} from '../../constants';
import Command from './command';

interface BaseCommandOption {
  id: string;
  name?: string;
}

interface CommandOption extends BaseCommandOption {
  handleCommand: (this: Command, ...args: any[]) => unknown | Promise<unknown>;
}

interface FileCommandOption extends BaseCommandOption {
  handleFile: (ctx: FileHandlerContext) => Promise<unknown>;
  getFileTarget: (...args: any[]) => undefined | Uri | Uri[] | Promise<undefined | Uri | Uri[]>;
}

function checkType<T>() {
  return (a: T) => a;
}

export const checkCommand = checkType<CommandOption>();
export const checkFileCommand = checkType<FileCommandOption>();

// windows paths are case-insensitive
const CASE_INSENSITIVE_PATHS = process.platform === 'win32';

function pathKey(fsPath: string): string {
  const normalized = path.normalize(fsPath).replace(/[\\/]+$/, '');
  return CASE_INSENSITIVE_PATHS ? normalized.toLowerCase() : normalized;
}

function isInside(parent: string, child: string): boolean {
  const parentKey = pathKey(parent);
  const childKey = pathKey(child);
  return (
    childKey.length > parentKey.length &&
    childKey.indexOf(parentKey) === 0 &&
    (childKey[parentKey.length] === path.sep || childKey[parentKey.length] === '/')
  );
}

/**
 * The targets a file command runs on: `targets` without the ones that lie
 * inside another of them. A folder selected together with one of its
 * subfolders, or with a file in it, would be walked twice at the same time,
 * and every file under both transferred twice; the outer selection covers
 * the inner one. The same target twice is kept once.
 */
export function withoutNestedTargets(targets: Uri[]): Uri[] {
  if (targets.length < 2) {
    return targets;
  }
  const seen = new Set<string>();
  return targets.filter(uri => {
    const key = `${uri.scheme}:${uri.authority || ''}:${pathKey(uri.fsPath)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return !targets.some(
      other =>
        other !== uri &&
        other.scheme === uri.scheme &&
        (other.authority || '') === (uri.authority || '') &&
        isInside(other.fsPath, uri.fsPath)
    );
  });
}

/**
 * Reports what the selections of one command run failed with. A lost
 * connection fails every selection the same way, so it is shown once; the
 * others only reach the log, and errors of any other kind are reported as
 * before, one each. Only the aggregate flagged by the handler counts as a
 * loss here: a per-file summary that merely quotes an errno is not one.
 */
function reportCommandErrors(errors: unknown[]) {
  let connectionLostShown = false;
  errors.forEach(error => {
    if (error instanceof Error && (error as any).connectionLost === true) {
      if (connectionLostShown) {
        reportError(markReported(error));
        return;
      }
      connectionLostShown = true;
    }
    reportError(error as Error);
  });
}

async function runOnTargets(
  name: string,
  target: undefined | Uri | Uri[],
  handle: (uri: Uri) => Promise<unknown>
) {
  if (!target) {
    logger.warn(`The "${name}" command get canceled because of missing targets.`);
    return;
  }

  const selected: Uri[] = Array.isArray(target) ? target : [target];
  const targetList = withoutNestedTargets(selected);
  if (targetList.length < selected.length) {
    logger.info(
      `"${name}": ${selected.length - targetList.length} selection(s) inside another ` +
        'selected folder skipped, the folder covers them'
    );
  }

  const errors: unknown[] = [];
  await Promise.all(
    targetList.map(async uri => {
      try {
        await handle(uri);
      } catch (error) {
        errors.push(error);
      }
    })
  );
  reportCommandErrors(errors);
}

export function createCommand(commandOption: CommandOption & { name: string }) {
  return class NormalCommand extends Command {
    constructor() {
      super();
      this.id = commandOption.id;
      this.name = commandOption.name;
    }

    doCommandRun(...args) {
      commandOption.handleCommand.apply(this, args);
    }
  };
}

export function createFileCommand(commandOption: FileCommandOption & { name: string }) {
  return class FileCommand extends Command {
    constructor() {
      super();
      this.id = commandOption.id;
      this.name = commandOption.name;
    }

    protected async doCommandRun(...args) {
      if ((this.id === COMMAND_UPLOAD_FILE_TO_ALL_PROFILES || this.id === COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES)
        && await window.showInformationMessage('Are you sure you want to upload to all profiles?', 'Yes', 'No').then(answer => answer !== 'Yes')) {
        return;
      }

      const target = await commandOption.getFileTarget(...args);
      await runOnTargets(this.name, target, uri => commandOption.handleFile(handleCtxFromUri(uri)));
    }
  };
}

export function createFileMultiCommand(commandOption: FileCommandOption & { name: string }) {
  return class FileCommand extends Command {
    constructor() {
      super();
      this.id = commandOption.id;
      this.name = commandOption.name;
    }

    protected async doCommandRun(...args) {
      if ((this.id === COMMAND_UPLOAD_FILE_TO_ALL_PROFILES || this.id === COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES)
        && await window.showInformationMessage('Are you sure you want to upload to all profiles?', 'Yes', 'No').then(answer => answer !== 'Yes')) {
        return;
      }

      const target = await commandOption.getFileTarget(...args);
      await runOnTargets(this.name, target, uri =>
        Promise.all(allHandleCtxFromUri(uri).map(commandOption.handleFile))
      );
    }
  };
}
