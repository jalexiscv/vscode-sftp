import * as path from 'path';
import * as vscode from 'vscode';
import app from '../app';
import logger from '../logger';
import fsPromises from '../helper/fsPromises';
import { FileService } from '../core';
import upath from '../core/upath';
import { CONFIG_PATH } from '../constants';
import { setContextValue } from '../host';
import { getAllFileService, getBasePath } from './serviceManager';

/**
 * The `uploadExclude` list of `sftp.json`, edited from the UI.
 *
 * `uploadExclude` (gitignore patterns that never travel local → remote, see
 * core/fileService) used to be hand-edited only. This module is what lets a
 * folder be excluded with a right-click, the list be reviewed and trimmed
 * from a QuickPick, and the explorer show "Include in Upload Again" on a
 * folder that is excluded: it turns a local path into the anchored pattern
 * for it ({@link patternForPath}) and back ({@link pathForPattern}), reads and
 * rewrites the list in the config file ({@link addExclusions},
 * {@link removeExclusion}), and publishes the excluded paths as the
 * `sftp.uploadExcludedPaths` context key so the menus can test
 * `resourcePath in sftp.uploadExcludedPaths`.
 *
 * Edits always go to the **base** list of the service's entry in `sftp.json`
 * (the one every profile inherits), never to a profile's own list; a
 * profile's patterns are listed as inherited and left to the editor. The file
 * is rewritten with its own indentation; the config watcher reloads the
 * services from it, so nothing here touches a live service.
 *
 * Key lifecycle methods:
 * - {@link listExclusions} / {@link addExclusions} / {@link removeExclusion}
 *   read and change the list of one service.
 * - {@link refreshContext} recomputes the context key from every service;
 *   called by the composition root after the services (re)load and by the
 *   edits above.
 */

/** `sftp.<CONTEXT_KEY>`: absolute local paths whose exact pattern is in a list */
export const CONTEXT_KEY = 'uploadExcludedPaths';

export interface ExclusionEntry {
  pattern: string;
  /** `base`: editable here; `profile`: inherited from the named profile's own list */
  source: 'base' | 'profile';
  profile?: string;
  /** the local path the pattern stands for, when it is a plain anchored one */
  localPath?: string;
}

export type AddOutcome = 'added' | 'exists' | 'outside';

export interface AddResult {
  pattern: string;
  outcome: AddOutcome;
}

// a plain anchored pattern: "/dir/sub" — no wildcards, no negation, no ".."
const PLAIN_ANCHORED = /^\/[^*?[\]!]+$/;

function normalizeRel(relPath: string): string {
  return upath
    .toUnix(relPath)
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function isInsideBase(relPath: string): boolean {
  if (relPath === '' || relPath === '..' || relPath.indexOf('../') === 0) {
    return false;
  }
  return relPath.charAt(0) !== '/' && !/^[a-zA-Z]:\//.test(relPath);
}

/**
 * The anchored gitignore pattern that excludes exactly `fsPath` (a file or a
 * directory with everything under it): `/relative/path` from the service base
 * dir, unix separators. Null for the base dir itself or a path outside it.
 */
export function patternForPath(service: FileService, fsPath: string): string | null {
  const rel = normalizeRel(upath.relative(upath.toUnix(service.baseDir), upath.toUnix(fsPath)));
  return isInsideBase(rel) ? '/' + rel : null;
}

/**
 * The local path a plain anchored pattern (`/dir`, `/dir/sub/`) stands for,
 * or null when the pattern has wildcards, negation or is not anchored — those
 * describe many paths, none of which the explorer can point at.
 */
export function pathForPattern(service: FileService, pattern: string): string | null {
  if (!PLAIN_ANCHORED.test(pattern)) {
    return null;
  }
  const rel = normalizeRel(pattern);
  if (!rel || rel.split('/').some(segment => segment === '..' || segment === '.')) {
    return null;
  }
  return path.join(service.baseDir, ...rel.split('/'));
}

interface ConfigFile {
  configPath: string;
  /** the parsed file: an object or an array of them */
  raw: any;
  /** the entry that produced `service`, inside `raw` */
  entry: any;
  /** what the file was indented with, kept on rewrite */
  indent: string;
  trailingNewline: boolean;
}

/**
 * The entry of `sftp.json` behind `service`: the one whose `context` resolves
 * to the service base dir — the same resolution createFileService used to
 * build it. Throws when the file is missing, unparsable or has no such entry.
 */
async function readConfigFile(service: FileService): Promise<ConfigFile> {
  const configPath = path.join(service.workspace, CONFIG_PATH);
  const text = await fsPromises.readFile(configPath, 'utf8');
  const raw = JSON.parse(text);
  const entries: any[] = Array.isArray(raw) ? raw : [raw];
  const entry = entries.find(
    candidate =>
      candidate &&
      typeof candidate === 'object' &&
      getBasePath(candidate.context, service.workspace) === service.baseDir
  );
  if (!entry) {
    throw new Error(`no entry of ${configPath} matches ${service.baseDir}`);
  }
  const indentMatch = /^([ \t]+)"/m.exec(text);
  return {
    configPath,
    raw,
    entry,
    indent: indentMatch ? indentMatch[1] : '    ',
    trailingNewline: /\n$/.test(text),
  };
}

async function writeConfigFile(file: ConfigFile): Promise<void> {
  const text = JSON.stringify(file.raw, null, file.indent) + (file.trailingNewline ? '\n' : '');
  await fsPromises.writeFile(file.configPath, text, 'utf8');
}

function patternsOf(list: any): string[] {
  return Array.isArray(list) ? list.filter(item => typeof item === 'string') : [];
}

function entriesOf(service: FileService, entry: any, profile: string | null): ExclusionEntry[] {
  const withPath = (item: ExclusionEntry): ExclusionEntry => {
    const localPath = pathForPattern(service, item.pattern);
    return localPath ? { ...item, localPath } : item;
  };
  const base = patternsOf(entry.uploadExclude).map(pattern =>
    withPath({ pattern, source: 'base' as const })
  );
  const own =
    profile && entry.profiles && entry.profiles[profile]
      ? patternsOf(entry.profiles[profile].uploadExclude).map(pattern =>
          withPath({ pattern, source: 'profile' as const, profile })
        )
      : [];
  return base.concat(own);
}

/**
 * The patterns in force for `service`: its base list, then the active
 * profile's own list (which the service concatenates to the base one).
 */
export async function listExclusions(service: FileService): Promise<ExclusionEntry[]> {
  const file = await readConfigFile(service);
  return entriesOf(service, file.entry, app.state.profile);
}

/**
 * Appends `patterns` to the base list of the service's entry, skipping the
 * ones already there (in the base or in the active profile), and rewrites
 * the file once. Every pattern gets an outcome; the file is left alone when
 * nothing was added.
 */
export async function addExclusions(service: FileService, patterns: string[]): Promise<AddResult[]> {
  const file = await readConfigFile(service);
  const inForce = new Set(entriesOf(service, file.entry, app.state.profile).map(item => item.pattern));
  const results: AddResult[] = [];
  let added = 0;

  patterns.forEach(pattern => {
    const trimmed = pattern.trim();
    if (!trimmed) {
      return;
    }
    if (inForce.has(trimmed)) {
      results.push({ pattern: trimmed, outcome: 'exists' });
      return;
    }
    if (!Array.isArray(file.entry.uploadExclude)) {
      file.entry.uploadExclude = [];
    }
    file.entry.uploadExclude.push(trimmed);
    inForce.add(trimmed);
    results.push({ pattern: trimmed, outcome: 'added' });
    added++;
  });

  if (added > 0) {
    await writeConfigFile(file);
    logger.info(
      `[upload-exclude] ${service.name || service.baseDir}: ${added} pattern(s) added to ${file.configPath}`
    );
    await refreshContext();
  }
  return results;
}

/**
 * Removes `pattern` from the base list of the service's entry. False when it
 * was not there — a pattern inherited from a profile is not removed here.
 */
export async function removeExclusion(service: FileService, pattern: string): Promise<boolean> {
  const file = await readConfigFile(service);
  const list = patternsOf(file.entry.uploadExclude);
  const index = list.indexOf(pattern);
  if (index === -1) {
    return false;
  }
  list.splice(index, 1);
  if (list.length === 0) {
    delete file.entry.uploadExclude;
  } else {
    file.entry.uploadExclude = list;
  }
  await writeConfigFile(file);
  logger.info(
    `[upload-exclude] ${service.name || service.baseDir}: "${pattern}" removed from ${file.configPath}`
  );
  await refreshContext();
  return true;
}

/**
 * Adds the exclusion for a local path (file or folder) of the service that
 * owns it. `outside` when the path is the base dir itself or not under it.
 */
export async function excludePath(service: FileService, fsPath: string): Promise<AddResult> {
  const pattern = patternForPath(service, fsPath);
  if (!pattern) {
    return { pattern: fsPath, outcome: 'outside' };
  }
  const [result] = await addExclusions(service, [pattern]);
  return result;
}

/**
 * The absolute local paths that the plain anchored patterns of every service
 * stand for, in the form `resourcePath` takes in a `when` clause (a Uri's
 * fsPath). A service whose config cannot be read contributes nothing.
 */
export async function excludedPaths(services: FileService[] = getAllFileService()): Promise<string[]> {
  const paths = new Set<string>();
  for (const service of services) {
    let entries: ExclusionEntry[];
    try {
      entries = await listExclusions(service);
    } catch (error) {
      logger.debug(`[upload-exclude] cannot read the list of ${service.baseDir}: ${error.message}`);
      continue;
    }
    entries.forEach(entry => {
      if (entry.localPath) {
        paths.add(vscode.Uri.file(entry.localPath).fsPath);
      }
    });
  }
  return Array.from(paths);
}

/** Publishes the context key the explorer menus test. Never throws. */
export async function refreshContext(): Promise<void> {
  try {
    setContextValue(CONTEXT_KEY, await excludedPaths());
  } catch (error) {
    logger.debug(`[upload-exclude] cannot refresh the context key: ${error.message}`);
  }
}
