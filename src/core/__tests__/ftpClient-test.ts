import FTPClient, { FTP_IDLE_TIMEOUT } from '../remote-client/ftpClient';

/**
 * The FTP client's own housekeeping: a command that dies with the socket
 * reports the drop at once (not on the next keepalive tick), and a connection
 * nobody has used for a while is closed rather than kept alive for ever with
 * NOOPs — shared hosts count those sessions against a per-IP cap.
 */

const KEEPALIVE_INTERVAL = 10 * 1000;

// the shape of basic-ftp's Client the FTPClient touches
function fakeBasicFtp() {
  return {
    closed: false,
    ftp: { verbose: false, log: undefined, socket: { setTimeout: jest.fn() } },
    send: jest.fn(() => Promise.resolve({ code: 200, message: '200 NOOP ok' })),
    close: jest.fn(),
    access: jest.fn(() => Promise.resolve()),
  };
}

// _initClient runs from the base constructor, before a subclass field would
// be initialised, so the fake is handed over through the module scope
let lastFake: ReturnType<typeof fakeBasicFtp>;

class TestFTPClient extends FTPClient {
  _initClient() {
    lastFake = fakeBasicFtp();
    return lastFake;
  }

  // what _doConnect leaves behind on success, without a socket
  pretendConnected() {
    (this as any).connected = true;
    (this as any).lastActivityAt = Date.now();
    (this as any)._startKeepAlive();
  }
}

function createClient() {
  const client = new TestFTPClient({ host: 'example.test', port: 21 } as any);
  const disconnected = jest.fn();
  client.onDisconnected(disconnected);
  return { client, disconnected, fake: lastFake };
}

// the legacy fake timers drive setInterval but leave Date.now alone; the idle
// clock reads Date.now, so both move together here. Ticks are advanced one at
// a time with the microtasks drained in between: the keepalive's NOOP settles
// through the queue's promises, and a tick that still sees it pending skips.
let nowMs = 1_700_000_000_000;
async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}
async function advance(ms: number) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(left, KEEPALIVE_INTERVAL);
    nowMs += step;
    jest.advanceTimersByTime(step);
    await settle();
    left -= step;
  }
}

describe('FTPClient', () => {
  let dateNow: jest.SpyInstance;

  beforeAll(() => {
    jest.useFakeTimers({ legacyFakeTimers: true } as any);
    dateNow = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });
  afterAll(() => {
    dateNow.mockRestore();
    jest.useRealTimers();
  });

  test('a command that fails because the connection is gone reports the drop at once, once', async () => {
    const { client, disconnected, fake } = createClient();
    client.pretendConnected();

    await expect(
      client.run(() => Promise.reject(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })))
    ).rejects.toThrow('read ECONNRESET');
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledWith('error');

    // the tasks queued behind it fail the same way but do not report again
    await expect(client.run(() => Promise.reject(new Error('Client is closed')))).rejects.toThrow();
    expect(disconnected).toHaveBeenCalledTimes(1);
    // and the keepalive is off, so nothing is sent on a dead socket
    await advance(KEEPALIVE_INTERVAL * 3);
    expect(fake.send).not.toHaveBeenCalled();
  });

  test('a command that fails on a live connection is not a drop', async () => {
    const { client, disconnected } = createClient();
    client.pretendConnected();

    await expect(
      client.run(() => Promise.reject(Object.assign(new Error('550 Permission denied'), { code: 550 })))
    ).rejects.toThrow();
    expect(disconnected).not.toHaveBeenCalled();
  });

  test('a socket found closed by a command is reported even without a network code', async () => {
    const { client, disconnected, fake } = createClient();
    client.pretendConnected();
    fake.closed = true;

    await expect(client.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(disconnected).toHaveBeenCalledWith('error');
  });

  test('keepalive NOOPs go out while the connection is in use, and do not count as use', async () => {
    const { client, fake, disconnected } = createClient();
    client.pretendConnected();

    await advance(KEEPALIVE_INTERVAL);
    expect(fake.send).toHaveBeenCalledWith('NOOP');
    expect(fake.close).not.toHaveBeenCalled();

    // a NOOP every tick while idle, and none of them counts as use: after the
    // whole timeout the connection is closed and reported as idle
    await advance(FTP_IDLE_TIMEOUT);
    expect(fake.send.mock.calls.length).toBeGreaterThan(FTP_IDLE_TIMEOUT / KEEPALIVE_INTERVAL - 2);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledWith('idle');

    // and nothing more goes out on the closed connection
    const sendsAfterClose = fake.send.mock.calls.length;
    await advance(KEEPALIVE_INTERVAL * 3);
    expect(fake.send.mock.calls.length).toBe(sendsAfterClose);
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  test('a command resets the idle clock', async () => {
    const { client, fake, disconnected } = createClient();
    client.pretendConnected();

    await advance(FTP_IDLE_TIMEOUT - KEEPALIVE_INTERVAL);
    await client.run(() => Promise.resolve('LIST'));
    await advance(FTP_IDLE_TIMEOUT - KEEPALIVE_INTERVAL);
    expect(fake.close).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();

    await advance(KEEPALIVE_INTERVAL * 2);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledWith('idle');
  });

  test('the idle timeout is five minutes and can be shortened for a test', async () => {
    expect(FTP_IDLE_TIMEOUT).toBe(5 * 60 * 1000);
    const { client, fake, disconnected } = createClient();
    client.setIdleTimeoutForTest(KEEPALIVE_INTERVAL);
    client.pretendConnected();

    await advance(KEEPALIVE_INTERVAL);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledWith('idle');
  });

  test('end() closes the socket and stops the keepalive without reporting a drop', async () => {
    const { client, fake, disconnected } = createClient();
    client.pretendConnected();

    client.end();
    await advance(KEEPALIVE_INTERVAL * 2);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.send).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
  });
});
