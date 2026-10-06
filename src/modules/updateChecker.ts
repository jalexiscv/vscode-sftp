import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as path from 'path';
import {
  STATE_KEY_UPDATE_LAST_CHECK,
  STATE_KEY_UPDATE_SKIPPED_VERSION,
  COMMAND_CHECK_FOR_UPDATES,
} from '../constants';
import { getJson, getText, downloadToFile, DownloadOptions } from '../core/httpClient';
import { reportError } from '../helper';
import {
  installExtensionFromVsix,
  openExternal,
  reloadWindow,
  showChoiceMessage,
  showInformationMessage,
  withProgress,
} from '../host';
import logger from '../logger';
import { getExtensionSetting } from './ext';
import { extensionVersionOf } from './storageReset';

/**
 * Keeps the installed extension in step with the releases of the fork on
 * GitHub. VS Code only updates extensions on its own from the Marketplace;
 * one installed from a vsix stays as it is for ever, so this module does the
 * part VS Code does not: it asks the GitHub releases API for the latest
 * release, compares its tag with the installed version and, when there is a
 * newer one, offers it. Nothing is installed without the user saying so, and
 * the install always ends in a window reload the user triggers.
 *
 * - `sftp.updates.check` decides when the check runs on its own: `daily`
 *   (once every 24 h, on activation), `startup` (every activation) or
 *   `off`. The check waits {@link STARTUP_DELAY_MS} after activation so the
 *   extension is usable first, and never blocks anything: a failure only
 *   reaches the output channel.
 * - `SFTP: Check for Updates` runs it by hand, whatever the setting, and
 *   says so when there is nothing new or the check failed.
 * - `Skip this version` silences the automatic notice for that version only;
 *   the manual check still offers it.
 *
 * Installing downloads the vsix asset of the release into the extension's
 * global storage, verifies it against the `<vsix>.sha256` asset when the
 * release carries one (the workflow publishes it since 1.30.0; older
 * releases have none and are installed unverified), and hands the file to
 * VS Code's own `workbench.extensions.installExtension`, the command behind
 * `Install from VSIX…`. The vsix is accepted only from the releases of
 * {@link REPOSITORY}; a redirect to GitHub's asset store is followed by the
 * HTTP client.
 *
 * Key lifecycle methods:
 * - {@link init} schedules the automatic check; {@link destroy} cancels it.
 * - {@link checkForUpdates} runs one check (silent or interactive).
 * - {@link fetchLatestRelease} / {@link parseRelease} / {@link compareVersions}
 *   are the pure pieces, exported for the tests.
 */

export type UpdateCheckMode = 'daily' | 'startup' | 'off';

export const REPOSITORY = 'jalexiscv/vscode-sftp';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
// what a vsix asset's download URL must start with to be trusted
export const ASSET_URL_PREFIX = `https://github.com/${REPOSITORY}/releases/download/`;

// `daily` checks again this long after the last completed check
export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
// the automatic check waits this long after activation
export const STARTUP_DELAY_MS = 15 * 1000;
// where downloaded vsix files go, under the extension's global storage
export const UPDATES_DIR = 'updates';

const BUTTON_INSTALL = 'Install';
const BUTTON_NOTES = 'Release notes';
const BUTTON_SKIP = 'Skip this version';
const BUTTON_RELOAD = 'Reload Window';

export interface ReleaseInfo {
  /** the version the tag names, without the `v` */
  version: string;
  tag: string;
  /** the release page */
  url: string;
  notes: string;
  vsix: { name: string; url: string; size: number };
  /** the `<vsix>.sha256` asset, when the release has one */
  sha256Url?: string;
}

export type UpdateCheckOutcome =
  | 'up-to-date'
  | 'available'
  | 'skipped'
  | 'installed'
  | 'failed'
  | 'no-release'
  | 'unknown-version';

export interface UpdateCheckOptions {
  /**
   * true for the automatic check: nothing is said when there is nothing
   * new, a skipped version is not offered again, and a failure is only
   * logged. false for the command: every outcome gets a message.
   */
  silent: boolean;
}

/** The two `Memento` methods used, so tests can pass a plain object. */
export interface UpdateMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: any): Thenable<void>;
}

export interface UpdateContext {
  /** the installed version; undefined when the host does not say */
  version: string | undefined;
  globalState: UpdateMemento;
  /** `context.globalStorageUri.fsPath` (or `globalStoragePath`) */
  globalStoragePath: string | undefined;
}

// test seams: the network and the clock
interface Deps {
  getJson: typeof getJson;
  getText: typeof getText;
  downloadToFile: (url: string, destination: string, options?: DownloadOptions) => Promise<void>;
  now: () => number;
}

const defaultDeps: Deps = { getJson, getText, downloadToFile, now: Date.now };
let deps: Deps = defaultDeps;

export function __setDepsForTest(partial?: Partial<Deps>): void {
  deps = partial ? { ...defaultDeps, ...partial } : defaultDeps;
}

let context: UpdateContext | null = null;
let timer: NodeJS.Timer | undefined;
// one automatic check per activation, however long the window stays open
let checkedThisSession = false;

/**
 * Compares two dotted versions numerically (`1.30.0` > `1.29.2`), ignoring a
 * leading `v` and anything after a `-` or `+`. Missing parts count as 0.
 * Returns a negative number, 0 or a positive number; NaN when either side
 * has no digits at all.
 */
export function compareVersions(a: string, b: string): number {
  const partsOf = (version: string) =>
    String(version)
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map(part => parseInt(part, 10));
  const left = partsOf(a);
  const right = partsOf(b);
  if (left.some(isNaN) || right.some(isNaN) || !left.length || !right.length) {
    return NaN;
  }
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * The release behind a GitHub releases API document, or null when it is a
 * draft or a prerelease, or carries no vsix from {@link REPOSITORY}.
 */
export function parseRelease(json: any): ReleaseInfo | null {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) {
    return null;
  }
  const tag = typeof json.tag_name === 'string' ? json.tag_name.trim() : '';
  const version = tag.replace(/^v/i, '');
  if (!version || isNaN(compareVersions(version, '0'))) {
    return null;
  }
  const assets: any[] = Array.isArray(json.assets) ? json.assets : [];
  const vsix = assets.find(
    asset =>
      asset &&
      typeof asset.name === 'string' &&
      /\.vsix$/i.test(asset.name) &&
      typeof asset.browser_download_url === 'string' &&
      asset.browser_download_url.indexOf(ASSET_URL_PREFIX) === 0
  );
  if (!vsix) {
    return null;
  }
  const sha256 = assets.find(
    asset =>
      asset &&
      asset.name === `${vsix.name}.sha256` &&
      typeof asset.browser_download_url === 'string' &&
      asset.browser_download_url.indexOf(ASSET_URL_PREFIX) === 0
  );
  return {
    version,
    tag,
    url: typeof json.html_url === 'string' ? json.html_url : `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
    notes: typeof json.body === 'string' ? json.body : '',
    vsix: {
      name: vsix.name,
      url: vsix.browser_download_url,
      size: typeof vsix.size === 'number' ? vsix.size : 0,
    },
    sha256Url: sha256 ? sha256.browser_download_url : undefined,
  };
}

/** The latest release of the fork, or null when it has no installable vsix. */
export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const json = await deps.getJson(LATEST_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  return parseRelease(json);
}

function readMode(): UpdateCheckMode {
  const value = getExtensionSetting().get<string>('updates.check', 'daily');
  return value === 'off' || value === 'startup' ? value : 'daily';
}

function isDue(mode: UpdateCheckMode, state: UpdateMemento): boolean {
  if (mode === 'off') {
    return false;
  }
  if (mode === 'startup') {
    return true;
  }
  const last = state.get<number>(STATE_KEY_UPDATE_LAST_CHECK);
  return typeof last !== 'number' || deps.now() - last >= DAILY_INTERVAL_MS;
}

/**
 * Remembers the host and schedules the automatic check when the setting and
 * the last check call for one.
 */
export function init(extensionContext: any): void {
  const globalStorageUri: { fsPath: string } | undefined = extensionContext.globalStorageUri;
  context = {
    version: extensionVersionOf(extensionContext),
    globalState: extensionContext.globalState,
    globalStoragePath: globalStorageUri ? globalStorageUri.fsPath : extensionContext.globalStoragePath,
  };
  checkedThisSession = false;
  scheduleAutomaticCheck();
}

export function destroy(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  context = null;
}

function scheduleAutomaticCheck(): void {
  if (!context || checkedThisSession || timer) {
    return;
  }
  const mode = readMode();
  if (!isDue(mode, context.globalState)) {
    logger.debug(`[updates] automatic check skipped (${mode})`);
    return;
  }
  timer = setTimeout(() => {
    timer = undefined;
    checkedThisSession = true;
    checkForUpdates({ silent: true }).catch(error => logger.debug(`[updates] ${error.message}`));
  }, STARTUP_DELAY_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

/**
 * One check against the latest release. Resolves with what happened; only
 * an interactive check that fails to reach GitHub rejects... never: every
 * failure is reported or logged here and returned as `failed`.
 */
export async function checkForUpdates(options: UpdateCheckOptions): Promise<UpdateCheckOutcome> {
  const { silent } = options;
  if (!context) {
    return 'failed';
  }
  const installed = context.version;
  if (!installed) {
    if (!silent) {
      showInformationMessage('SFTP: the installed version is unknown, so updates cannot be checked.');
    }
    return 'unknown-version';
  }

  let release: ReleaseInfo | null;
  try {
    logger.debug(`[updates] checking ${LATEST_RELEASE_URL} (installed ${installed})`);
    release = await fetchLatestRelease();
  } catch (error) {
    if (silent) {
      logger.debug(`[updates] check failed: ${error.message}`);
    } else {
      logger.warn(`[updates] check failed: ${error.message}`);
      showInformationMessage(`SFTP: could not check for updates (${error.message}).`);
    }
    return 'failed';
  }
  await context.globalState.update(STATE_KEY_UPDATE_LAST_CHECK, deps.now());

  if (!release) {
    logger.info('[updates] the latest release carries no installable vsix');
    if (!silent) {
      showInformationMessage(`SFTP ${installed}: no newer release with a vsix was found.`);
    }
    return 'no-release';
  }
  const comparison = compareVersions(release.version, installed);
  if (isNaN(comparison) || comparison <= 0) {
    logger.info(`[updates] ${installed} is up to date (latest release ${release.tag})`);
    if (!silent) {
      showInformationMessage(`SFTP ${installed} is up to date.`);
    }
    return 'up-to-date';
  }
  const skipped = context.globalState.get<string>(STATE_KEY_UPDATE_SKIPPED_VERSION);
  if (silent && skipped === release.version) {
    logger.info(`[updates] ${release.version} is available but was skipped; "${COMMAND_CHECK_FOR_UPDATES}" still offers it`);
    return 'skipped';
  }

  logger.info(`[updates] ${release.version} is available (installed ${installed}): ${release.url}`);
  const choice = await showChoiceMessage(
    `SFTP ${release.version} is available (installed: ${installed}). Install it from GitHub?`,
    [BUTTON_INSTALL, BUTTON_NOTES, BUTTON_SKIP]
  );
  if (choice === BUTTON_INSTALL) {
    try {
      await installRelease(release);
      return 'installed';
    } catch (error) {
      reportError(error, `install SFTP ${release.version}`);
      return 'failed';
    }
  }
  if (choice === BUTTON_NOTES) {
    openExternal(release.url);
    return 'available';
  }
  if (choice === BUTTON_SKIP) {
    await context.globalState.update(STATE_KEY_UPDATE_SKIPPED_VERSION, release.version);
    logger.info(`[updates] ${release.version} skipped until the next release`);
    return 'skipped';
  }
  return 'available';
}

function sha256Of(fsPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(fsPath)).digest('hex');
}

/**
 * Downloads the vsix of `release`, verifies it when the release publishes a
 * checksum, installs it through VS Code and offers the reload.
 */
async function installRelease(release: ReleaseInfo): Promise<void> {
  if (!context || !context.globalStoragePath) {
    throw new Error('no global storage to download the update into');
  }
  const dir = path.join(context.globalStoragePath, UPDATES_DIR);
  await fse.ensureDir(dir);
  const destination = path.join(dir, release.vsix.name);

  await withProgress({ title: `SFTP: downloading ${release.vsix.name}`, cancellable: false }, async progress => {
    let reported = 0;
    await deps.downloadToFile(release.vsix.url, destination, {
      onProgress: (received, total) => {
        const size = total || release.vsix.size;
        if (!size) {
          return;
        }
        const percent = Math.min(100, Math.floor((received / size) * 100));
        if (percent > reported) {
          progress.report({ increment: percent - reported, message: `${percent}%` });
          reported = percent;
        }
      },
    });
  });
  logger.info(`[updates] downloaded ${release.vsix.url} to ${destination}`);

  if (release.sha256Url) {
    const expected = (await deps.getText(release.sha256Url)).trim().match(/^[0-9a-f]{64}/i);
    const actual = sha256Of(destination);
    if (!expected || expected[0].toLowerCase() !== actual) {
      await fse.remove(destination);
      throw new Error(
        `the downloaded ${release.vsix.name} does not match the published checksum; it was removed and not installed`
      );
    }
    logger.info(`[updates] checksum of ${release.vsix.name} verified`);
  } else {
    logger.warn(`[updates] release ${release.tag} publishes no checksum; ${release.vsix.name} installed unverified`);
  }

  await installExtensionFromVsix(destination);
  logger.info(`[updates] ${release.version} installed; a window reload is needed`);
  // the previous downloads are of no use any more
  await removeOtherDownloads(dir, release.vsix.name);

  const choice = await showChoiceMessage(
    `SFTP ${release.version} is installed. Reload the window to start using it.`,
    [BUTTON_RELOAD]
  );
  if (choice === BUTTON_RELOAD) {
    reloadWindow();
  }
}

async function removeOtherDownloads(dir: string, keep: string): Promise<void> {
  try {
    const names = await fse.readdir(dir);
    await Promise.all(
      names
        .filter(name => name !== keep && /\.vsix(\.part)?$/i.test(name))
        .map(name => fse.remove(path.join(dir, name)))
    );
  } catch (error) {
    logger.debug(`[updates] cleanup of ${dir} skipped: ${error.message}`);
  }
}

// test seam
export function __resetForTest(): void {
  destroy();
  checkedThisSession = false;
  deps = defaultDeps;
}
