import { EventEmitter } from 'events';

/**
 * What the extension knows about the health of each remote connection, and
 * the one place that decides whether an error means "the connection is gone"
 * rather than "this file failed".
 *
 * Before this module a dropped connection was invisible to everything above
 * the transport: every queued task retried against the dead client, every
 * failure opened its own dialog, the index recorded each file as failed and
 * the next scan planned all of them again, and each new plan or command
 * reconnected at once — which, against a server that keeps the half-dead
 * sessions around for minutes, is how `421 Too many connections` is earned.
 *
 * Two pieces:
 *
 * - {@link isConnectionLostError}: classifies an error as a loss of the
 *   connection (socket errors, timeouts, a closed client, FTP `421`, and the
 *   errors raised here while a connection is on hold). The transfer layer
 *   does not retry these inside the task, the plan runner puts the items on
 *   hold instead of failing them, the index feeder leaves the index alone and
 *   the per-file dialog is skipped. A server certificate the TLS layer
 *   refuses ({@link isCertificateError}) is one of these too: the connection
 *   cannot be established until the server or `secureOptions` changes, and
 *   every file would fail the same way; the connection layer tells it as a
 *   {@link CertificateRejectedError}, with the way out, in place of the bare
 *   OpenSSL error.
 * - {@link ConnectionGate}: one per connection identity, remembers the
 *   failed connection attempts and holds new attempts for a growing delay
 *   (1 s, 2 s, 4 s … {@link MAX_BACKOFF_MS}; at least
 *   {@link SERVICE_UNAVAILABLE_BACKOFF_MS} after a `421`, and
 *   {@link CERTIFICATE_BACKOFF_MS} after a refused certificate). A held attempt is
 *   rejected at once with a {@link ConnectionOnHoldError} rather than opening
 *   a socket. A successful connection clears the hold and fires
 *   {@link onConnectionRecovered}, which is what resumes the plans that were
 *   put on hold.
 *
 * Pure Node: no vscode import, so the policy is unit-testable and usable from
 * `core/` and `modules/` alike.
 */

/** Node errno codes that mean the peer or the network went away. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ENETRESET',
]);

// what OpenSSL (through node's tls) says when the server's certificate is
// refused: an incomplete chain, a self-signed or expired certificate, a name
// it was not issued for. Node never fetches a missing intermediate on its
// own, as a browser would, so a server that sends only its leaf certificate
// fails every attempt with UNABLE_TO_VERIFY_LEAF_SIGNATURE
const TLS_CERTIFICATE_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_CHAIN_TOO_LONG',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// the same, by message, for the layers that wrap the error and drop its code
const CERTIFICATE_ERROR_MESSAGE = new RegExp(
  [
    'unable to verify the first certificate',
    'unable to get (?:local )?issuer certificate',
    'self[- ]signed certificate',
    'certificate has expired',
    'certificate is not yet valid',
    'does not match certificate\'s altnames',
    'certificate verify failed',
  ].join('|'),
  'i'
);

// node appends a hint about `--use-system-ca` that nobody can act on from an
// extension host (and that does not apply to a missing intermediate anyway)
const NODE_SYSTEM_CA_HINT = /;?\s*if the root CA is installed locally.*$/i;

/** What to do about a refused certificate; appended to the messages that report one. */
export const CERTIFICATE_HINT =
  'Have the server send its complete certificate chain, issued for this host name, ' +
  'or accept the certificate unverified with "secureOptions": { "rejectUnauthorized": false } in sftp.json.';

/** FTP "service not available, closing control connection" — also what a server says for "too many connections". */
export const FTP_SERVICE_NOT_AVAILABLE = 421;
// SFTP status codes ssh2 reports as bare numbers: 6 NO_CONNECTION, 7 CONNECTION_LOST
const SFTP_NO_CONNECTION = 6;
const SFTP_CONNECTION_LOST = 7;

/** `code` of the error raised while a connection is on hold. */
export const ERROR_CODE_CONNECTION_ON_HOLD = 'ECONNHOLD';

// what ssh2, basic-ftp and the two clients say when the connection is gone;
// the errno codes are matched as words too, because more than one layer wraps
// them in a message and drops the `code` property on the way
const CONNECTION_LOST_MESSAGE = new RegExp(
  [
    'not connected',
    'client is closed',
    'user closed client',
    'no sftp connection',
    'channel (?:was )?closed',
    'connection (?:closed|lost|reset|ended|refused|timed out)',
    'socket hang up',
    'socket (?:closed|is closed)',
    'no response from server',
    'keepalive timeout',
    'timed out while waiting',
    'timeout \\(control socket\\)',
    'timeout \\(data socket\\)',
    '\\bECONN[A-Z]+\\b',
    '\\bETIMEDOUT\\b',
    '\\bENOTFOUND\\b',
    '\\bEPIPE\\b',
    '\\bEHOSTUNREACH\\b',
    '\\bENETUNREACH\\b',
    '\\bEAI_AGAIN\\b',
  ].join('|'),
  'i'
);

/**
 * Whether `error` says the connection itself is gone (or is being held),
 * as opposed to the operation having failed on a live connection.
 */
export function isConnectionLostError(error: any): boolean {
  if (!error) {
    return false;
  }
  if (error.connectionLost === true) {
    return true;
  }
  if (isCertificateError(error)) {
    return true;
  }
  const code = error.code;
  if (typeof code === 'number') {
    // a protocol reply is judged by its number alone: an FTP `426 Connection
    // closed; transfer aborted` is about the data connection of one
    // transfer, the control connection is fine and the file is retried
    return (
      code === FTP_SERVICE_NOT_AVAILABLE ||
      code === SFTP_NO_CONNECTION ||
      code === SFTP_CONNECTION_LOST
    );
  }
  if (typeof code === 'string') {
    if (code === ERROR_CODE_CONNECTION_ON_HOLD || NETWORK_ERROR_CODES.has(code)) {
      return true;
    }
  }
  const message = typeof error === 'string' ? error : error.message;
  return typeof message === 'string' && CONNECTION_LOST_MESSAGE.test(message);
}

/**
 * Whether `error` is the TLS layer refusing the server's certificate. A
 * failure of the connection too ({@link isConnectionLostError}), but not one
 * a retry fixes: the server or `secureOptions` has to change.
 */
export function isCertificateError(error: any): boolean {
  if (!error) {
    return false;
  }
  const code = error.code;
  if (typeof code === 'string' && TLS_CERTIFICATE_ERROR_CODES.has(code)) {
    return true;
  }
  const message = typeof error === 'string' ? error : error.message;
  return typeof message === 'string' && CERTIFICATE_ERROR_MESSAGE.test(message);
}

/**
 * `certificate rejected: <what OpenSSL said> (<code>)`, the one-line form of
 * a refused certificate for logs and hold reasons; node's `--use-system-ca`
 * hint is dropped.
 */
export function describeCertificateError(error: any): string {
  const message = String(error && error.message ? error.message : error)
    .replace(/\s+/g, ' ')
    .replace(NODE_SYSTEM_CA_HINT, '')
    .trim();
  const code = error && error.code;
  const suffix = typeof code === 'string' && code !== '' && !message.includes(code) ? ` (${code})` : '';
  return `certificate rejected: ${message}${suffix}`;
}

/**
 * Flags `error` as a loss of the connection, whatever its code or message
 * says, so every layer above agrees with the one that saw the socket go.
 */
export function markConnectionLost<T>(error: T): T {
  if (error && typeof error === 'object') {
    try {
      Object.defineProperty(error, 'connectionLost', {
        value: true,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch (_ignored) {
      // a frozen error: the code or message will have to do
    }
  }
  return error;
}

/** Raised instead of connecting while the gate holds new attempts. */
export class ConnectionOnHoldError extends Error {
  code = ERROR_CODE_CONNECTION_ON_HOLD;
  connectionLost = true;
  readonly label: string;
  /** ms until the next attempt is allowed */
  readonly retryAfterMs: number;
  /** what the last attempt failed with */
  readonly cause: string;

  constructor(label: string, retryAfterMs: number, cause: string) {
    super(
      `[${label}]: connection is down (${cause}); ` +
        `next attempt in ${Math.ceil(retryAfterMs / 1000)} s`
    );
    this.label = label;
    this.retryAfterMs = retryAfterMs;
    this.cause = cause;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ConnectionOnHoldError);
    }
  }
}

/**
 * A refused server certificate, told as the connection failure of `host` it
 * is, with the way out. The connection layer raises it in place of the bare
 * OpenSSL error; `code` is kept so the classification still holds.
 */
export class CertificateRejectedError extends Error {
  code: string | undefined;
  connectionLost = true;
  readonly host: string;
  /** `certificate rejected: …`, the one-line form for logs and hold reasons */
  readonly reason: string;
  /** the error the TLS layer raised */
  readonly cause: any;

  constructor(cause: any, host: string) {
    super(`[${host}]: ${describeCertificateError(cause)}. ${CERTIFICATE_HINT}`);
    this.code = cause && typeof cause.code === 'string' ? cause.code : undefined;
    this.host = host;
    this.reason = describeCertificateError(cause);
    this.cause = cause;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CertificateRejectedError);
    }
  }
}

// first hold after a failed attempt; doubled on every further failure
export const BASE_BACKOFF_MS = 1000;
// the hold never grows past this: one attempt a minute while the server is down
export const MAX_BACKOFF_MS = 60 * 1000;
// a 421 means the server turned us away on purpose; coming back sooner only
// keeps its per-IP counter full
export const SERVICE_UNAVAILABLE_BACKOFF_MS = 60 * 1000;
/** hold after a refused certificate: nothing a retry fixes, so the attempts stay rare */
export const CERTIFICATE_BACKOFF_MS = 60 * 1000;

/**
 * The one-line reason of a failed or lost connection, for hold reasons, logs
 * and notices: the message with its code appended when the message lost it;
 * a refused certificate in its short form rather than with the way out.
 */
export function connectionFailureReason(error: any): string {
  if (error instanceof CertificateRejectedError) {
    return error.reason;
  }
  if (error instanceof ConnectionOnHoldError) {
    // already says it all; its code is bookkeeping
    return error.message;
  }
  if (isCertificateError(error)) {
    return describeCertificateError(error);
  }
  const message = String(error && error.message ? error.message : error)
    .replace(/\s+/g, ' ')
    .trim();
  const code = error && error.code;
  if (
    (typeof code === 'string' && code !== '' && !message.includes(code)) ||
    (typeof code === 'number' && !message.includes(String(code)))
  ) {
    return `${message} (${code})`;
  }
  return message;
}

/**
 * The attempt policy of one connection identity.
 *
 * `now` is injectable for tests; production code leaves it to `Date.now`.
 */
export class ConnectionGate {
  /** what messages call this connection, typically the host */
  readonly label: string;
  private readonly now: () => number;
  private failures = 0;
  private nextAttemptAt = 0;
  private lastReason = '';
  private dropped = false;
  private readonly emitter = new EventEmitter();

  constructor(label: string, now: () => number = Date.now) {
    this.label = label;
    this.now = now;
  }

  /** consecutive failed attempts since the last successful connection */
  get consecutiveFailures(): number {
    return this.failures;
  }

  /** what the last failed attempt said, '' after a success */
  get reason(): string {
    return this.lastReason;
  }

  /** ms until a new attempt is allowed; 0 when it may go now */
  retryAfter(): number {
    return Math.max(0, this.nextAttemptAt - this.now());
  }

  /** whether new attempts are being held */
  isOnHold(): boolean {
    return this.retryAfter() > 0;
  }

  /** Throws a {@link ConnectionOnHoldError} while attempts are held. */
  assertMayAttempt(): void {
    const wait = this.retryAfter();
    if (wait > 0) {
      throw new ConnectionOnHoldError(this.label, wait, this.lastReason || 'unreachable');
    }
  }

  /**
   * A connection attempt failed with a loss-of-connection error. Cancelled
   * and authentication failures are not recorded: the user is about to fix
   * those, and holding them would only delay the corrected attempt.
   */
  recordFailure(error: any): void {
    if (!isConnectionLostError(error)) {
      return;
    }
    this.failures += 1;
    this.lastReason = connectionFailureReason(error);
    let delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, this.failures - 1), MAX_BACKOFF_MS);
    if (error && error.code === FTP_SERVICE_NOT_AVAILABLE) {
      delay = Math.max(delay, SERVICE_UNAVAILABLE_BACKOFF_MS);
    }
    if (isCertificateError(error)) {
      // nothing a retry fixes: the server or the configuration has to change
      delay = Math.max(delay, CERTIFICATE_BACKOFF_MS);
    }
    this.nextAttemptAt = this.now() + delay;
    this.emitter.emit('failure', this);
  }

  /**
   * A connection was established; clears the hold. Fires `recovered` when it
   * follows a failed attempt or a drop — not on a first, uneventful connection.
   */
  recordSuccess(): void {
    const recovered = this.failures > 0 || this.dropped;
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.lastReason = '';
    this.dropped = false;
    if (recovered) {
      this.emitter.emit('recovered', this);
    }
  }

  /**
   * An established connection was lost (as opposed to an attempt failing).
   * The next attempt may go at once — a single reconnection is cheap and
   * usually enough —; only a failed attempt starts the hold.
   */
  recordDrop(reason: string): void {
    this.lastReason = reason;
    this.dropped = true;
    this.emitter.emit('drop', this);
  }

  on(event: 'failure' | 'recovered' | 'drop', listener: (gate: ConnectionGate) => void): () => void {
    this.emitter.on(event, listener);
    return () => {
      this.emitter.removeListener(event, listener);
    };
  }
}

const gates = new Map<string, ConnectionGate>();
const globalEmitter = new EventEmitter();

/**
 * The gate of a connection identity, created on first use. `label` is what
 * messages show for it (typically the host).
 */
export function getConnectionGate(identity: string, label: string): ConnectionGate {
  let gate = gates.get(identity);
  if (!gate) {
    gate = new ConnectionGate(label);
    gate.on('recovered', g => globalEmitter.emit('recovered', g));
    gate.on('failure', g => globalEmitter.emit('failure', g));
    gates.set(identity, gate);
  }
  return gate;
}

/** Fires when any connection that had failed (or never connected) connects. */
export function onConnectionRecovered(listener: (gate: ConnectionGate) => void): () => void {
  globalEmitter.on('recovered', listener);
  return () => {
    globalEmitter.removeListener('recovered', listener);
  };
}

/** Fires when any connection attempt fails with a loss-of-connection error. */
export function onConnectionAttemptFailed(listener: (gate: ConnectionGate) => void): () => void {
  globalEmitter.on('failure', listener);
  return () => {
    globalEmitter.removeListener('failure', listener);
  };
}

// test seam: the registry is process-wide
export function __resetConnectionGatesForTest(): void {
  gates.clear();
  globalEmitter.removeAllListeners();
}
