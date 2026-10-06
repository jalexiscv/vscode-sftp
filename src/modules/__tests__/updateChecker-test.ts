jest.mock('fs');
// everything the module says or does through VS Code goes through host; the
// stand-ins record it
jest.mock('../../host', () => ({
  // the logger reads the settings at import time
  getUserSetting: jest.fn(() => ({ get: (_key: string, fallback: any) => fallback })),
  showInformationMessage: jest.fn(),
  // reportError's dialog
  showErrorMessage: jest.fn(() => Promise.resolve(undefined)),
  showChoiceMessage: jest.fn(),
  withProgress: jest.fn((_options, task) =>
    task({ report: jest.fn() }, { isCancellationRequested: false, onCancellationRequested: jest.fn() })
  ),
  installExtensionFromVsix: jest.fn(() => Promise.resolve()),
  reloadWindow: jest.fn(),
  openExternal: jest.fn(),
}));

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { vol } from 'memfs';
import {
  STATE_KEY_UPDATE_LAST_CHECK,
  STATE_KEY_UPDATE_SKIPPED_VERSION,
} from '../../constants';
import {
  getUserSetting,
  showInformationMessage,
  showChoiceMessage,
  installExtensionFromVsix,
  reloadWindow,
  openExternal,
} from '../../host';
import logger from '../../logger';
import * as updateChecker from '../updateChecker';

const {
  compareVersions,
  parseRelease,
  checkForUpdates,
  init,
  destroy,
  LATEST_RELEASE_URL,
  ASSET_URL_PREFIX,
  DAILY_INTERVAL_MS,
  STARTUP_DELAY_MS,
  UPDATES_DIR,
  __setDepsForTest,
  __resetForTest,
} = updateChecker;

/**
 * VS Code never updates an extension installed from a vsix, so the module
 * asks GitHub for the latest release itself, offers a newer one and, on the
 * user's word, downloads, verifies and installs it. Nothing here opens a
 * socket: the network is a stand-in handed through __setDepsForTest.
 */

const VSIX = Buffer.from('vsix content');
const VSIX_SHA256 = crypto.createHash('sha256').update(VSIX).digest('hex');

function releaseJson(version = '1.30.0', extra: any = {}) {
  const name = `sftp-${version}.vsix`;
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/jalexiscv/vscode-sftp/releases/tag/v${version}`,
    body: 'notes',
    draft: false,
    prerelease: false,
    assets: [
      { name, browser_download_url: `${ASSET_URL_PREFIX}v${version}/${name}`, size: VSIX.length },
      { name: `${name}.sha256`, browser_download_url: `${ASSET_URL_PREFIX}v${version}/${name}.sha256` },
    ],
    ...extra,
  };
}

function memento(initial: { [key: string]: any } = {}) {
  const state: { [key: string]: any } = { ...initial };
  return {
    state,
    get: jest.fn((key: string) => state[key]),
    update: jest.fn((key: string, value: any) => {
      state[key] = value;
      return Promise.resolve();
    }),
  };
}

interface Fake {
  getJson: jest.Mock;
  getText: jest.Mock;
  downloadToFile: jest.Mock;
  now: jest.Mock;
}

function fakeNetwork(json: any = releaseJson(), checksum = `${VSIX_SHA256}  sftp-1.30.0.vsix\n`): Fake {
  const fake: Fake = {
    getJson: jest.fn(() => (json instanceof Error ? Promise.reject(json) : Promise.resolve(json))),
    getText: jest.fn(() => Promise.resolve(checksum)),
    downloadToFile: jest.fn((_url: string, destination: string, options: any) => {
      fs.writeFileSync(destination, VSIX);
      if (options && options.onProgress) {
        options.onProgress(VSIX.length, VSIX.length);
      }
      return Promise.resolve();
    }),
    now: jest.fn(() => 1_000_000),
  };
  __setDepsForTest(fake);
  return fake;
}

function setting(value: string | undefined) {
  (getUserSetting as jest.Mock).mockReturnValue({
    get: (_key: string, fallback: string) => (value === undefined ? fallback : value),
  });
}

function contextFor(version: string | undefined, state = memento()) {
  return {
    extension: { packageJSON: { version } },
    globalState: state,
    globalStorageUri: { fsPath: '/global' },
  };
}

const choose = (title: string | undefined) => (showChoiceMessage as jest.Mock).mockResolvedValue(title);

describe('compareVersions', () => {
  test.each([
    ['1.30.0', '1.29.2', 1],
    ['1.29.2', '1.30.0', -1],
    ['1.29.2', '1.29.2', 0],
    ['v1.29.10', '1.29.9', 1],
    ['1.30', '1.30.0', 0],
    ['2.0.0-beta', '1.99.99', 1],
  ])('%s vs %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  test('a version without digits compares as NaN', () => {
    expect(compareVersions('latest', '1.0.0')).toBeNaN();
  });
});

describe('parseRelease', () => {
  test('reads the version, the page, the vsix and its checksum', () => {
    expect(parseRelease(releaseJson())).toEqual({
      version: '1.30.0',
      tag: 'v1.30.0',
      url: 'https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.30.0',
      notes: 'notes',
      vsix: {
        name: 'sftp-1.30.0.vsix',
        url: `${ASSET_URL_PREFIX}v1.30.0/sftp-1.30.0.vsix`,
        size: VSIX.length,
      },
      sha256Url: `${ASSET_URL_PREFIX}v1.30.0/sftp-1.30.0.vsix.sha256`,
    });
  });

  test('a release without a checksum asset is still installable, unverified', () => {
    const json = releaseJson();
    json.assets = json.assets.slice(0, 1);

    expect(parseRelease(json)!.sha256Url).toBeUndefined();
  });

  test('drafts, prereleases, releases without a vsix and foreign assets are ignored', () => {
    expect(parseRelease(releaseJson('1.30.0', { draft: true }))).toBeNull();
    expect(parseRelease(releaseJson('1.30.0', { prerelease: true }))).toBeNull();
    expect(parseRelease(releaseJson('1.30.0', { assets: [] }))).toBeNull();
    expect(
      parseRelease(
        releaseJson('1.30.0', {
          assets: [
            {
              name: 'sftp-1.30.0.vsix',
              browser_download_url: 'https://github.com/someone-else/vscode-sftp/releases/download/v1.30.0/sftp-1.30.0.vsix',
            },
          ],
        })
      )
    ).toBeNull();
    expect(parseRelease(releaseJson('1.30.0', { tag_name: 'nightly' }))).toBeNull();
    expect(parseRelease(null)).toBeNull();
  });
});

describe('checkForUpdates', () => {
  let info: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useRealTimers();
    __resetForTest();
    vol.reset();
    vol.mkdirSync('/global', { recursive: true });
    jest.clearAllMocks();
    setting(undefined);
    info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    destroy();
    jest.restoreAllMocks();
  });

  test('a newer release is offered, and Install downloads, verifies, installs and offers the reload', async () => {
    const fake = fakeNetwork();
    const state = memento();
    init(contextFor('1.29.2', state));
    (showChoiceMessage as jest.Mock).mockResolvedValueOnce('Install').mockResolvedValueOnce('Reload Window');

    await expect(checkForUpdates({ silent: true })).resolves.toBe('installed');

    expect(fake.getJson).toHaveBeenCalledWith(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    expect(showChoiceMessage).toHaveBeenNthCalledWith(
      1,
      'SFTP 1.30.0 is available (installed: 1.29.2). Install it from GitHub?',
      ['Install', 'Release notes', 'Skip this version']
    );
    const destination = path.join('/global', UPDATES_DIR, 'sftp-1.30.0.vsix');
    expect(fake.downloadToFile).toHaveBeenCalledWith(
      `${ASSET_URL_PREFIX}v1.30.0/sftp-1.30.0.vsix`,
      destination,
      expect.objectContaining({ onProgress: expect.any(Function) })
    );
    expect(fake.getText).toHaveBeenCalledWith(`${ASSET_URL_PREFIX}v1.30.0/sftp-1.30.0.vsix.sha256`);
    expect(installExtensionFromVsix).toHaveBeenCalledWith(destination);
    expect(showChoiceMessage).toHaveBeenNthCalledWith(
      2,
      'SFTP 1.30.0 is installed. Reload the window to start using it.',
      ['Reload Window']
    );
    expect(reloadWindow).toHaveBeenCalledTimes(1);
    expect(state.state[STATE_KEY_UPDATE_LAST_CHECK]).toBe(1_000_000);
    expect(info.mock.calls.map(call => call[0])).toContainEqual('[updates] checksum of sftp-1.30.0.vsix verified');
  });

  test('a vsix that does not match the published checksum is removed and not installed', async () => {
    fakeNetwork(releaseJson(), `${'0'.repeat(64)}  sftp-1.30.0.vsix\n`);
    init(contextFor('1.29.2'));
    choose('Install');

    await expect(checkForUpdates({ silent: false })).resolves.toBe('failed');

    expect(installExtensionFromVsix).not.toHaveBeenCalled();
    expect(fs.existsSync(`/global/${UPDATES_DIR}/sftp-1.30.0.vsix`)).toBe(false);
  });

  test('a release without a checksum is installed with a warning', async () => {
    const json = releaseJson();
    json.assets = json.assets.slice(0, 1);
    const fake = fakeNetwork(json);
    init(contextFor('1.29.2'));
    (showChoiceMessage as jest.Mock).mockResolvedValueOnce('Install').mockResolvedValueOnce(undefined);

    await expect(checkForUpdates({ silent: true })).resolves.toBe('installed');

    expect(fake.getText).not.toHaveBeenCalled();
    expect(installExtensionFromVsix).toHaveBeenCalledTimes(1);
    expect(reloadWindow).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(call => call[0])).toContainEqual(
      '[updates] release v1.30.0 publishes no checksum; sftp-1.30.0.vsix installed unverified'
    );
  });

  test('earlier downloads are removed once the new one is installed', async () => {
    fakeNetwork();
    vol.mkdirSync(`/global/${UPDATES_DIR}`, { recursive: true });
    fs.writeFileSync(`/global/${UPDATES_DIR}/sftp-1.29.0.vsix`, 'old');
    fs.writeFileSync(`/global/${UPDATES_DIR}/sftp-1.28.0.vsix.part`, 'older');
    fs.writeFileSync(`/global/${UPDATES_DIR}/notes.txt`, 'kept');
    init(contextFor('1.29.2'));
    choose('Install');

    await checkForUpdates({ silent: true });

    expect(fs.readdirSync(`/global/${UPDATES_DIR}`).sort()).toEqual(['notes.txt', 'sftp-1.30.0.vsix']);
  });

  test('Release notes opens the release page; dismissing the offer changes nothing', async () => {
    fakeNetwork();
    const state = memento();
    init(contextFor('1.29.2', state));
    choose('Release notes');

    await expect(checkForUpdates({ silent: true })).resolves.toBe('available');
    expect(openExternal).toHaveBeenCalledWith('https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.30.0');

    choose(undefined);
    await expect(checkForUpdates({ silent: true })).resolves.toBe('available');
    expect(installExtensionFromVsix).not.toHaveBeenCalled();
    expect(state.state[STATE_KEY_UPDATE_SKIPPED_VERSION]).toBeUndefined();
  });

  test('Skip this version silences the automatic check for that version; the command still offers it', async () => {
    fakeNetwork();
    const state = memento();
    init(contextFor('1.29.2', state));
    choose('Skip this version');

    await expect(checkForUpdates({ silent: true })).resolves.toBe('skipped');
    expect(state.state[STATE_KEY_UPDATE_SKIPPED_VERSION]).toBe('1.30.0');

    (showChoiceMessage as jest.Mock).mockClear();
    await expect(checkForUpdates({ silent: true })).resolves.toBe('skipped');
    expect(showChoiceMessage).not.toHaveBeenCalled();

    choose(undefined);
    await expect(checkForUpdates({ silent: false })).resolves.toBe('available');
    expect(showChoiceMessage).toHaveBeenCalledTimes(1);

    // a later release is offered again
    fakeNetwork(releaseJson('1.31.0'));
    choose(undefined);
    await expect(checkForUpdates({ silent: true })).resolves.toBe('available');
  });

  test('an installed version that is current says so only when asked', async () => {
    fakeNetwork(releaseJson('1.29.2'));
    init(contextFor('1.29.2'));

    await expect(checkForUpdates({ silent: true })).resolves.toBe('up-to-date');
    expect(showInformationMessage).not.toHaveBeenCalled();

    await expect(checkForUpdates({ silent: false })).resolves.toBe('up-to-date');
    expect(showInformationMessage).toHaveBeenCalledWith('SFTP 1.29.2 is up to date.');
    expect(showChoiceMessage).not.toHaveBeenCalled();
  });

  test('a newer installed version (a local build) is not downgraded', async () => {
    fakeNetwork(releaseJson('1.29.2'));
    init(contextFor('1.30.0'));

    await expect(checkForUpdates({ silent: true })).resolves.toBe('up-to-date');
    expect(showChoiceMessage).not.toHaveBeenCalled();
  });

  test('a network failure is logged when silent and said when asked; the last check is not recorded', async () => {
    fakeNetwork(Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }));
    const state = memento();
    init(contextFor('1.29.2', state));

    await expect(checkForUpdates({ silent: true })).resolves.toBe('failed');
    expect(showInformationMessage).not.toHaveBeenCalled();

    await expect(checkForUpdates({ silent: false })).resolves.toBe('failed');
    expect(showInformationMessage).toHaveBeenCalledWith(
      'SFTP: could not check for updates (getaddrinfo ENOTFOUND api.github.com).'
    );
    expect(state.state[STATE_KEY_UPDATE_LAST_CHECK]).toBeUndefined();
  });

  test('a latest release without a vsix is reported only when asked', async () => {
    fakeNetwork(releaseJson('1.30.0', { assets: [] }));
    init(contextFor('1.29.2'));

    await expect(checkForUpdates({ silent: true })).resolves.toBe('no-release');
    expect(showInformationMessage).not.toHaveBeenCalled();

    await expect(checkForUpdates({ silent: false })).resolves.toBe('no-release');
    expect(showInformationMessage).toHaveBeenCalledWith('SFTP 1.29.2: no newer release with a vsix was found.');
  });

  test('a host that does not report the installed version cannot be checked', async () => {
    const fake = fakeNetwork();
    init(contextFor(undefined));

    await expect(checkForUpdates({ silent: false })).resolves.toBe('unknown-version');
    expect(fake.getJson).not.toHaveBeenCalled();
    expect(showInformationMessage).toHaveBeenCalledWith(
      'SFTP: the installed version is unknown, so updates cannot be checked.'
    );
  });

  test('a failed install is reported and the check says so', async () => {
    fakeNetwork();
    (installExtensionFromVsix as jest.Mock).mockRejectedValueOnce(new Error('Install failed'));
    init(contextFor('1.29.2'));
    choose('Install');

    await expect(checkForUpdates({ silent: false })).resolves.toBe('failed');
    expect(reloadWindow).not.toHaveBeenCalled();
  });
});

describe('the automatic check', () => {
  beforeEach(() => {
    __resetForTest();
    vol.reset();
    jest.clearAllMocks();
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    jest.useFakeTimers({ legacyFakeTimers: true });
  });

  afterEach(() => {
    destroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const flush = () => new Promise(resolve => jest.requireActual('timers').setImmediate(resolve));

  test('daily: runs after the startup delay when the last check is older than a day', async () => {
    const fake = fakeNetwork(releaseJson('1.29.2'));
    fake.now.mockReturnValue(DAILY_INTERVAL_MS * 10);
    setting('daily');
    init(contextFor('1.29.2', memento({ [STATE_KEY_UPDATE_LAST_CHECK]: DAILY_INTERVAL_MS * 10 - DAILY_INTERVAL_MS })));

    expect(fake.getJson).not.toHaveBeenCalled();
    jest.advanceTimersByTime(STARTUP_DELAY_MS);
    await flush();

    expect(fake.getJson).toHaveBeenCalledTimes(1);
  });

  test('daily: a check made less than a day ago is not repeated', async () => {
    const fake = fakeNetwork(releaseJson('1.29.2'));
    fake.now.mockReturnValue(DAILY_INTERVAL_MS * 10);
    setting('daily');
    init(contextFor('1.29.2', memento({ [STATE_KEY_UPDATE_LAST_CHECK]: DAILY_INTERVAL_MS * 10 - 1000 })));

    jest.advanceTimersByTime(STARTUP_DELAY_MS);
    await flush();

    expect(fake.getJson).not.toHaveBeenCalled();
  });

  test('startup: runs on every activation; off: never', async () => {
    const fake = fakeNetwork(releaseJson('1.29.2'));
    setting('startup');
    init(contextFor('1.29.2', memento({ [STATE_KEY_UPDATE_LAST_CHECK]: 999_999 })));
    jest.advanceTimersByTime(STARTUP_DELAY_MS);
    await flush();
    expect(fake.getJson).toHaveBeenCalledTimes(1);

    destroy();
    __resetForTest();
    const offline = fakeNetwork(releaseJson('1.29.2'));
    setting('off');
    init(contextFor('1.29.2'));
    jest.advanceTimersByTime(STARTUP_DELAY_MS);
    await flush();
    expect(offline.getJson).not.toHaveBeenCalled();
  });

  test('destroy before the delay cancels the check', async () => {
    const fake = fakeNetwork(releaseJson('1.29.2'));
    setting('startup');
    init(contextFor('1.29.2'));

    destroy();
    jest.advanceTimersByTime(STARTUP_DELAY_MS);
    await flush();

    expect(fake.getJson).not.toHaveBeenCalled();
  });
});
