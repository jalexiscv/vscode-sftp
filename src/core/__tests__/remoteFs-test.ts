jest.mock('vscode', () => require('../../../test/helper/vscodeMock').createVscodeMock());
// the saved-password flow needs VS Code's SecretStorage; here nothing is saved
jest.mock('../../modules/savedPasswords', () => ({
  passwordKey: () => 'key',
  getSavedPassword: () => Promise.resolve(undefined),
  removeSavedPassword: () => Promise.resolve(),
  offerToSavePassword: () => undefined,
  isSavedPasswordsAvailable: () => false,
}));
// the remote file systems are replaced by a fake whose connect() the test
// scripts; the shape KeepAliveRemoteFs relies on is connect/onDisconnected/end
jest.mock('../fs', () => {
  class FakeRemoteFs {
    static instances: FakeRemoteFs[] = [];
    static connectImpl: () => Promise<void> = () => Promise.resolve();
    disconnectListeners: Array<(reason: string) => void> = [];
    ended = 0;
    constructor(public pathResolver: any, public option: any) {
      FakeRemoteFs.instances.push(this);
    }
    connect() {
      return FakeRemoteFs.connectImpl();
    }
    onDisconnected(cb: (reason: string) => void) {
      this.disconnectListeners.push(cb);
    }
    end() {
      this.ended += 1;
    }
    emitDisconnected(reason: string) {
      this.disconnectListeners.forEach(cb => cb(reason));
    }
  }
  return {
    FileSystem: class {},
    // localFs.ts builds one at import time
    LocalFileSystem: class {},
    RemoteFileSystem: FakeRemoteFs,
    SFTPFileSystem: FakeRemoteFs,
    FTPFileSystem: FakeRemoteFs,
    __FakeRemoteFs: FakeRemoteFs,
  };
});

import { createRemoteIfNoneExist, removeRemoteFs, connectionGateOf } from '../remoteFs';
import {
  ERROR_CODE_CONNECTION_ON_HOLD,
  onConnectionRecovered,
  __resetConnectionGatesForTest,
} from '../connectionHealth';

const { __FakeRemoteFs: FakeRemoteFs } = require('../fs');

/**
 * The shared connection of one server, under a network that fails: attempts
 * are held instead of stacked, a late event of a dead client does not tear
 * down its replacement, and a recovery is reported.
 */

const option = {
  protocol: 'sftp',
  host: 'example.test',
  port: 22,
  username: 'me',
  password: 'secret',
  remoteTimeOffsetInHours: 0,
  connectTimeout: 1000,
};

const networkError = (code: string, message: string) => Object.assign(new Error(message), { code });

async function rejectionOf(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

let nowMs = 1_700_000_000_000;
let dateNow: jest.SpyInstance;

beforeAll(() => {
  dateNow = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
});
afterAll(() => dateNow.mockRestore());

beforeEach(() => {
  removeRemoteFs(option);
  __resetConnectionGatesForTest();
  FakeRemoteFs.instances.length = 0;
  FakeRemoteFs.connectImpl = () => Promise.resolve();
  nowMs = 1_700_000_000_000;
});

describe('createRemoteIfNoneExist under a failing network', () => {
  test('a failed attempt holds the next ones: they are rejected at once, without a socket', async () => {
    FakeRemoteFs.connectImpl = () =>
      Promise.reject(networkError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:22'));

    const first = await rejectionOf(createRemoteIfNoneExist(option));
    expect(first.code).toBe('ECONNREFUSED');
    expect(FakeRemoteFs.instances).toHaveLength(1);
    expect(FakeRemoteFs.instances[0].ended).toBe(1);

    const held = await rejectionOf(createRemoteIfNoneExist(option));
    expect(held.code).toBe(ERROR_CODE_CONNECTION_ON_HOLD);
    expect(held.message).toBe(
      '[example.test]: connection is down (connect ECONNREFUSED 10.0.0.1:22); next attempt in 1 s'
    );
    // no second client was built for the held call
    expect(FakeRemoteFs.instances).toHaveLength(1);
    expect(connectionGateOf(option).consecutiveFailures).toBe(1);
  });

  test('once the hold is over a new attempt goes out, and a success reports the recovery', async () => {
    FakeRemoteFs.connectImpl = () => Promise.reject(networkError('ETIMEDOUT', 'connect ETIMEDOUT'));
    await rejectionOf(createRemoteIfNoneExist(option));
    const recovered = jest.fn();
    onConnectionRecovered(recovered);

    nowMs += 1000;
    FakeRemoteFs.connectImpl = () => Promise.resolve();
    const fs = await createRemoteIfNoneExist(option);

    expect(fs).toBe(FakeRemoteFs.instances[1]);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(connectionGateOf(option).isOnHold()).toBe(false);
    // and the live connection is shared from then on
    expect(await createRemoteIfNoneExist(option)).toBe(fs);
    expect(FakeRemoteFs.instances).toHaveLength(2);
  });

  test('a wrong password does not start a hold: the corrected attempt goes out at once', async () => {
    FakeRemoteFs.connectImpl = () =>
      Promise.reject(new Error('All configured authentication methods failed'));
    await rejectionOf(createRemoteIfNoneExist(option));

    FakeRemoteFs.connectImpl = () => Promise.resolve();
    await expect(createRemoteIfNoneExist(option)).resolves.toBe(FakeRemoteFs.instances[1]);
  });
});

describe('a dropped connection', () => {
  test('is replaced on the next call, and the late close of the dead client leaves the replacement alone', async () => {
    const first = await createRemoteIfNoneExist(option);

    // ssh2: `error`, then the client is replaced, then the `close` of the old one
    first.emitDisconnected('error');
    expect(first.ended).toBe(1);
    const second = await createRemoteIfNoneExist(option);
    expect(second).not.toBe(first);

    first.emitDisconnected('close');
    expect(second.ended).toBe(0);
    expect(await createRemoteIfNoneExist(option)).toBe(second);
    expect(FakeRemoteFs.instances).toHaveLength(2);
  });

  test('a second event for the same drop is ignored; the next attempt is not held', async () => {
    const first = await createRemoteIfNoneExist(option);
    first.emitDisconnected('error');
    first.emitDisconnected('close');
    expect(first.ended).toBe(1);
    expect(connectionGateOf(option).isOnHold()).toBe(false);

    await expect(createRemoteIfNoneExist(option)).resolves.toBe(FakeRemoteFs.instances[1]);
  });

  test('an idle close is not a drop for the gate', async () => {
    const first = await createRemoteIfNoneExist(option);
    const recovered = jest.fn();
    onConnectionRecovered(recovered);

    first.emitDisconnected('idle');
    await createRemoteIfNoneExist(option);

    expect(recovered).not.toHaveBeenCalled();
  });
});

describe('removeRemoteFs', () => {
  test('closes a live connection and tolerates one that was never built', async () => {
    const fs = await createRemoteIfNoneExist(option);
    removeRemoteFs(option);
    expect(fs.ended).toBe(1);

    // held before any client existed: nothing to end
    FakeRemoteFs.connectImpl = () => Promise.reject(networkError('ECONNRESET', 'read ECONNRESET'));
    await rejectionOf(createRemoteIfNoneExist(option));
    removeRemoteFs(option);
    await rejectionOf(createRemoteIfNoneExist(option));
    expect(() => removeRemoteFs(option)).not.toThrow();
  });
});
