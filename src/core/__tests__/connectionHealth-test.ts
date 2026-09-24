import {
  isConnectionLostError,
  markConnectionLost,
  ConnectionGate,
  ConnectionOnHoldError,
  ERROR_CODE_CONNECTION_ON_HOLD,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  SERVICE_UNAVAILABLE_BACKOFF_MS,
  getConnectionGate,
  onConnectionRecovered,
  onConnectionAttemptFailed,
  __resetConnectionGatesForTest,
} from '../connectionHealth';

/**
 * The one classification of "the connection is gone" every layer shares, and
 * the attempt policy that keeps a dead server from being hammered.
 */

const withCode = (code: string | number, message = 'boom') => Object.assign(new Error(message), { code });

describe('isConnectionLostError', () => {
  test.each([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
  ])('errno %s is a lost connection', code => {
    expect(isConnectionLostError(withCode(code))).toBe(true);
  });

  test.each(['EACCES', 'EPERM', 'ENOENT', 'EISDIR', 'EROFS', 'EVERIFY'])(
    'errno %s is about the file, not the connection',
    code => {
      expect(isConnectionLostError(withCode(code))).toBe(false);
    }
  );

  test('FTP 421 and the SFTP connection statuses are; other protocol replies are judged by number only', () => {
    expect(isConnectionLostError(withCode(421, '421 Too many connections (8) from this IP'))).toBe(true);
    expect(isConnectionLostError(withCode(6, 'No connection'))).toBe(true);
    expect(isConnectionLostError(withCode(7, 'Connection lost'))).toBe(true);
    // a data-connection abort: the control connection is fine, the file is retried
    expect(isConnectionLostError(withCode(426, '426 Connection closed; transfer aborted.'))).toBe(false);
    expect(isConnectionLostError(withCode(4, 'Failure'))).toBe(false);
    expect(isConnectionLostError(withCode(550, 'Not found'))).toBe(false);
  });

  test.each([
    'Not connected',
    'Client is closed',
    'Client is closed because User closed client during task',
    'No SFTP connection available',
    'Channel closed',
    '[example.test]: read ECONNRESET',
    '[example.test]: connect ETIMEDOUT 10.0.0.1:22',
    '[example.test]: getaddrinfo ENOTFOUND example.test',
    'Timed out while waiting for handshake',
    'Keepalive timeout',
    'socket hang up',
    'Client is closed because Timeout (control socket)',
  ])('the message "%s" is recognised when the code was lost on the way', message => {
    expect(isConnectionLostError(new Error(message))).toBe(true);
    expect(isConnectionLostError(message)).toBe(true);
  });

  test.each([
    'Permission denied',
    'size mismatch (local 1024, remote 0)',
    'All configured authentication methods failed',
    '530 Login incorrect.',
  ])('the message "%s" is not', message => {
    expect(isConnectionLostError(new Error(message))).toBe(false);
  });

  test('a marked error is, whatever it says; nothing is not', () => {
    const error = markConnectionLost(new Error('anything'));
    expect(isConnectionLostError(error)).toBe(true);
    expect(Object.keys(error)).not.toContain('connectionLost');
    expect(isConnectionLostError(null)).toBe(false);
    expect(isConnectionLostError(undefined)).toBe(false);
  });

  test('the hold error is one too, and carries the wait', () => {
    const error = new ConnectionOnHoldError('example.test', 4000, 'connect ECONNREFUSED');
    expect(isConnectionLostError(error)).toBe(true);
    expect(error.code).toBe(ERROR_CODE_CONNECTION_ON_HOLD);
    expect(error.retryAfterMs).toBe(4000);
    expect(error.message).toBe(
      '[example.test]: connection is down (connect ECONNREFUSED); next attempt in 4 s'
    );
  });
});

describe('ConnectionGate', () => {
  let now = 1_000_000;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  test('lets the first attempt through and holds after a failure, doubling up to the ceiling', () => {
    const gate = new ConnectionGate('example.test', clock);
    expect(gate.isOnHold()).toBe(false);
    expect(() => gate.assertMayAttempt()).not.toThrow();

    const expected = [1, 2, 4, 8, 16, 32, 60, 60].map(s => s * 1000);
    expected.forEach((delay, index) => {
      gate.recordFailure(withCode('ECONNREFUSED', 'connect ECONNREFUSED'));
      expect(gate.consecutiveFailures).toBe(index + 1);
      expect(gate.retryAfter()).toBe(delay);
      expect(gate.isOnHold()).toBe(true);
      expect(() => gate.assertMayAttempt()).toThrow(ConnectionOnHoldError);
      now += delay;
      expect(gate.retryAfter()).toBe(0);
      expect(() => gate.assertMayAttempt()).not.toThrow();
    });
    expect(BASE_BACKOFF_MS).toBe(1000);
    expect(MAX_BACKOFF_MS).toBe(60_000);
  });

  test('the hold error names the host, the wait and the last reason', () => {
    const gate = new ConnectionGate('example.test', clock);
    gate.recordFailure(withCode('ETIMEDOUT', '[example.test]: connect ETIMEDOUT'));
    now += 250;

    let error: any;
    try {
      gate.assertMayAttempt();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConnectionOnHoldError);
    expect(error.retryAfterMs).toBe(750);
    expect(error.message).toBe(
      '[example.test]: connection is down ([example.test]: connect ETIMEDOUT); next attempt in 1 s'
    );
    expect(gate.reason).toBe('[example.test]: connect ETIMEDOUT');
  });

  test('a 421 holds for a minute at least, whatever the attempt count', () => {
    const gate = new ConnectionGate('example.test', clock);
    gate.recordFailure(withCode(421, '421 Too many connections'));
    expect(gate.retryAfter()).toBe(SERVICE_UNAVAILABLE_BACKOFF_MS);
  });

  test('a wrong password or a cancelled prompt is not a failure of the connection', () => {
    const gate = new ConnectionGate('example.test', clock);
    gate.recordFailure(new Error('All configured authentication methods failed'));
    gate.recordFailure(withCode(530, '530 Login incorrect.'));
    gate.recordFailure(Object.assign(new Error('cancelled'), { code: 0 }));
    expect(gate.consecutiveFailures).toBe(0);
    expect(gate.isOnHold()).toBe(false);
  });

  test('a success clears the hold and reports the recovery only after a failure or a drop', () => {
    const gate = new ConnectionGate('example.test', clock);
    const recovered = jest.fn();
    gate.on('recovered', recovered);

    gate.recordSuccess();
    expect(recovered).not.toHaveBeenCalled();

    gate.recordFailure(withCode('ECONNRESET'));
    gate.recordFailure(withCode('ECONNRESET'));
    gate.recordSuccess();
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(gate.consecutiveFailures).toBe(0);
    expect(gate.isOnHold()).toBe(false);
    expect(gate.reason).toBe('');

    gate.recordDrop('close');
    // a drop lets the next attempt go at once: one reconnection is cheap
    expect(gate.isOnHold()).toBe(false);
    gate.recordSuccess();
    expect(recovered).toHaveBeenCalledTimes(2);
  });

  test('the reason keeps the code when the message lost it', () => {
    const gate = new ConnectionGate('example.test', clock);
    gate.recordFailure(withCode('ECONNRESET', 'read failed'));
    expect(gate.reason).toBe('read failed (ECONNRESET)');
    gate.recordFailure(withCode('ECONNRESET', 'read ECONNRESET'));
    expect(gate.reason).toBe('read ECONNRESET');
  });
});

describe('the registry', () => {
  afterEach(() => __resetConnectionGatesForTest());

  test('one gate per identity, shared by every caller', () => {
    const a = getConnectionGate('id-1', 'a.test');
    expect(getConnectionGate('id-1', 'a.test')).toBe(a);
    expect(getConnectionGate('id-2', 'b.test')).not.toBe(a);
    expect(a.label).toBe('a.test');
  });

  test('recoveries and failed attempts of any gate reach the global listeners, until unsubscribed', () => {
    const recovered = jest.fn();
    const failed = jest.fn();
    const stopRecovered = onConnectionRecovered(recovered);
    onConnectionAttemptFailed(failed);
    const gate = getConnectionGate('id-1', 'a.test');

    gate.recordFailure(withCode('ECONNREFUSED'));
    gate.recordSuccess();
    expect(failed).toHaveBeenCalledWith(gate);
    expect(recovered).toHaveBeenCalledWith(gate);

    stopRecovered();
    gate.recordFailure(withCode('ECONNREFUSED'));
    gate.recordSuccess();
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(2);
  });
});
