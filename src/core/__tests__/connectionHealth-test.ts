import {
  isConnectionLostError,
  isCertificateError,
  describeCertificateError,
  connectionFailureReason,
  markConnectionLost,
  ConnectionGate,
  ConnectionOnHoldError,
  CertificateRejectedError,
  CERTIFICATE_HINT,
  ERROR_CODE_CONNECTION_ON_HOLD,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  SERVICE_UNAVAILABLE_BACKOFF_MS,
  CERTIFICATE_BACKOFF_MS,
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

  test.each([
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'self signed certificate in certificate chain'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate'],
    ['CERT_HAS_EXPIRED', 'certificate has expired'],
    [
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'Hostname/IP does not match certificate\'s altnames: Host: ftp.example.test. is not in the cert\'s altnames: DNS:server.example.net',
    ],
  ])('a refused certificate (%s) is a failure of the connection too', (code, message) => {
    const error = withCode(code, message);
    expect(isCertificateError(error)).toBe(true);
    expect(isConnectionLostError(error)).toBe(true);
  });

  test('a refused certificate is told apart by message when the code was dropped; nothing else is one', () => {
    expect(isCertificateError(new Error('unable to verify the first certificate'))).toBe(true);
    expect(isCertificateError(new Error('certificate has expired'))).toBe(true);
    expect(isCertificateError('self-signed certificate')).toBe(true);
    expect(isCertificateError(withCode('ECONNRESET', 'read ECONNRESET'))).toBe(false);
    expect(isCertificateError(withCode(530, '530 Login incorrect.'))).toBe(false);
    expect(isCertificateError(new Error('All configured authentication methods failed'))).toBe(false);
    expect(isCertificateError(null)).toBe(false);
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

describe('a refused certificate', () => {
  // what node says for a server that sends its leaf certificate without the
  // intermediate that issued it; the hint is about a flag of the node binary
  const nodeError = withCode(
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca'
  );
  const reason =
    'certificate rejected: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)';

  test('is described in one line, without node\'s hint, with the code when the message lost it', () => {
    expect(describeCertificateError(nodeError)).toBe(reason);
    expect(describeCertificateError(withCode('CERT_HAS_EXPIRED', 'certificate has expired'))).toBe(
      'certificate rejected: certificate has expired (CERT_HAS_EXPIRED)'
    );
    expect(describeCertificateError(new Error('certificate has expired'))).toBe(
      'certificate rejected: certificate has expired'
    );
  });

  test('CertificateRejectedError names the host, keeps the code and says the way out', () => {
    const error = new CertificateRejectedError(nodeError, 'ftp.example.test');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(error.host).toBe('ftp.example.test');
    expect(error.cause).toBe(nodeError);
    expect(error.reason).toBe(reason);
    expect(error.message).toBe(`[ftp.example.test]: ${reason}. ${CERTIFICATE_HINT}`);
    expect(error.message).not.toContain('--use-system-ca');
    expect(CERTIFICATE_HINT).toContain('"secureOptions": { "rejectUnauthorized": false }');
    expect(isCertificateError(error)).toBe(true);
    expect(isConnectionLostError(error)).toBe(true);
  });

  test('the gate holds for a minute at least: nothing a retry fixes', () => {
    let now = 1_000_000;
    const gate = new ConnectionGate('ftp.example.test', () => now);
    gate.recordFailure(new CertificateRejectedError(nodeError, 'ftp.example.test'));
    expect(gate.consecutiveFailures).toBe(1);
    expect(gate.retryAfter()).toBe(CERTIFICATE_BACKOFF_MS);
    expect(gate.reason).toBe(reason);

    // the bare node error, before the connection layer wrapped it, is held the same
    const bare = new ConnectionGate('ftp.example.test', () => now);
    bare.recordFailure(nodeError);
    expect(bare.retryAfter()).toBe(CERTIFICATE_BACKOFF_MS);
    expect(bare.reason).toBe(reason);

    now += CERTIFICATE_BACKOFF_MS;
    expect(gate.retryAfter()).toBe(0);
    expect(() => gate.assertMayAttempt()).not.toThrow();
  });

  test('connectionFailureReason: the short form of a certificate, the hold error as it is, the code otherwise', () => {
    expect(connectionFailureReason(new CertificateRejectedError(nodeError, 'h'))).toBe(reason);
    expect(connectionFailureReason(nodeError)).toBe(reason);
    const hold = new ConnectionOnHoldError('example.test', 4000, 'read ECONNRESET');
    expect(connectionFailureReason(hold)).toBe(hold.message);
    expect(connectionFailureReason(withCode('ECONNRESET', 'boom'))).toBe('boom (ECONNRESET)');
    expect(connectionFailureReason(withCode('ECONNRESET', 'read ECONNRESET'))).toBe('read ECONNRESET');
    expect(connectionFailureReason('plain text')).toBe('plain text');
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
