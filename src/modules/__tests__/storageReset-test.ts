jest.mock('fs');

import * as path from 'path';
import { vol } from 'memfs';
import { STATE_KEY_STORAGE_VERSION, STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED } from '../../constants';
import { discardStorageOnVersionChange, extensionVersionOf } from '../storageReset';

/**
 * The generated files (sync indexes, activity log) are discarded once per
 * upgrade and only then; anything else under the storage path is not ours.
 */

// absolute on both platforms; "c:/..." is a relative folder on linux
const storage = path.resolve(path.sep, 'storage', 'ws-1');
const indexDir = path.join(storage, 'sync-index');

function memento(initial: { [key: string]: any } = {}) {
  const state: { [key: string]: any } = { ...initial };
  return {
    state,
    get: jest.fn((key: string) => state[key]),
    update: jest.fn((key: string, value: any) => {
      if (value === undefined) {
        delete state[key];
      } else {
        state[key] = value;
      }
      return Promise.resolve();
    }),
  };
}

function seedStorage() {
  vol.fromJSON({
    [path.join(indexDir, 'abc.json')]: '{}',
    [path.join(indexDir, 'def.json.corrupt-1')]: '{',
    [path.join(storage, 'activity-log.json')]: '[]',
    [path.join(storage, 'activity-log.json.tmp')]: '[]',
    [path.join(storage, 'other.txt')]: 'not ours',
  });
}

const files = () => Object.keys(vol.toJSON()).filter(name => vol.statSync(name).isFile());

describe('discardStorageOnVersionChange', () => {
  beforeEach(() => {
    vol.reset();
  });

  test('a new version removes the sync indexes and the activity log, nothing else, and records itself', async () => {
    seedStorage();
    const state = memento({
      [STATE_KEY_STORAGE_VERSION]: '1.26.0',
      [STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED]: ['k1'],
    });

    const result = await discardStorageOnVersionChange({
      storagePath: storage,
      version: '1.27.0',
      state,
    });

    expect(result).toMatchObject({ discarded: true, previousVersion: '1.26.0', version: '1.27.0' });
    expect(result.removed.length).toBe(4);
    expect(files().length).toBe(1);
    expect(files()[0]).toMatch(/other\.txt$/);
    expect(vol.existsSync(indexDir)).toBe(false);
    expect(state.state[STATE_KEY_STORAGE_VERSION]).toBe('1.27.0');
    // the reason the notice was dismissed is gone with the index
    expect(state.state[STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED]).toBeUndefined();
  });

  test('storage written before the version was recorded is discarded by the first version that records it', async () => {
    seedStorage();
    const state = memento();

    const result = await discardStorageOnVersionChange({
      storagePath: storage,
      version: '1.27.0',
      state,
    });

    expect(result.discarded).toBe(true);
    expect(result.previousVersion).toBeUndefined();
    expect(files().length).toBe(1);
    expect(state.state[STATE_KEY_STORAGE_VERSION]).toBe('1.27.0');
  });

  test('the same version keeps everything and writes nothing', async () => {
    seedStorage();
    const state = memento({ [STATE_KEY_STORAGE_VERSION]: '1.27.0' });

    const result = await discardStorageOnVersionChange({
      storagePath: storage,
      version: '1.27.0',
      state,
    });

    expect(result).toMatchObject({ discarded: false, previousVersion: '1.27.0', removed: [] });
    expect(files().length).toBe(5);
    expect(state.update).not.toHaveBeenCalled();
  });

  test('a fresh workspace records the version and removes nothing', async () => {
    const state = memento();

    const result = await discardStorageOnVersionChange({
      storagePath: storage,
      version: '1.27.0',
      state,
    });

    expect(result).toMatchObject({ discarded: false, removed: [] });
    expect(state.state[STATE_KEY_STORAGE_VERSION]).toBe('1.27.0');
    expect(state.update).toHaveBeenCalledTimes(1);
  });

  test('an unknown version touches nothing, not even the state', async () => {
    seedStorage();
    const state = memento({ [STATE_KEY_STORAGE_VERSION]: '1.26.0' });

    const result = await discardStorageOnVersionChange({
      storagePath: storage,
      version: undefined,
      state,
    });

    expect(result).toMatchObject({ discarded: false, removed: [] });
    expect(files().length).toBe(5);
    expect(state.update).not.toHaveBeenCalled();
  });

  test('without a storage path only the version is recorded', async () => {
    const state = memento({ [STATE_KEY_STORAGE_VERSION]: '1.26.0' });

    const result = await discardStorageOnVersionChange({
      storagePath: undefined,
      version: '1.27.0',
      state,
    });

    expect(result).toMatchObject({ discarded: false, previousVersion: '1.26.0', removed: [] });
    expect(state.state[STATE_KEY_STORAGE_VERSION]).toBe('1.27.0');
  });

  test('a subdirectory inside sync-index is left alone, and keeps the folder', async () => {
    vol.fromJSON({
      [path.join(indexDir, 'abc.json')]: '{}',
      [path.join(indexDir, 'nested', 'x.json')]: '{}',
    });
    const state = memento({ [STATE_KEY_STORAGE_VERSION]: '1.26.0' });

    const result = await discardStorageOnVersionChange({
      storagePath: storage,
      version: '1.27.0',
      state,
    });

    expect(result.discarded).toBe(true);
    expect(result.removed.length).toBe(1);
    expect(vol.existsSync(path.join(indexDir, 'nested', 'x.json'))).toBe(true);
    expect(vol.existsSync(indexDir)).toBe(true);
  });

  test('a missing storage folder is the first run, not a failure', async () => {
    const state = memento({ [STATE_KEY_STORAGE_VERSION]: '1.26.0' });

    const result = await discardStorageOnVersionChange({
      storagePath: path.join(storage, 'never-created'),
      version: '1.27.0',
      state,
    });

    expect(result).toMatchObject({ discarded: false, removed: [] });
    expect(state.state[STATE_KEY_STORAGE_VERSION]).toBe('1.27.0');
  });
});

describe('extensionVersionOf', () => {
  test("reads the host's package.json and tolerates its absence", () => {
    expect(extensionVersionOf({ extension: { packageJSON: { version: '1.27.0' } } })).toBe('1.27.0');
    expect(extensionVersionOf({})).toBeUndefined();
    expect(extensionVersionOf(undefined)).toBeUndefined();
    expect(extensionVersionOf({ extension: { packageJSON: { version: 3 } } })).toBeUndefined();
    expect(extensionVersionOf({ extension: { packageJSON: { version: '' } } })).toBeUndefined();
  });
});
