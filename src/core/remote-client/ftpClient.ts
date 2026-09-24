import { Client, FTPResponse } from 'basic-ftp';
import { EventEmitter } from 'events';
import * as PQueue from 'p-queue';
import RemoteClient, { ConnectOption } from './remoteClient';
import { isConnectionLostError } from '../connectionHealth';

const KEEPALIVE_INTERVAL = 1000 * 10; // 10 secs

/**
 * How long an FTP connection may sit without a command before it is closed.
 * Shared hosts cap the sessions per IP (often 4 to 8), and a control
 * connection kept alive with NOOPs for hours — one per profile, per
 * sftp.json entry and per window — is what uses that cap up. The next
 * operation reconnects on its own (KeepAliveRemoteFs), at the cost of one
 * login.
 */
export const FTP_IDLE_TIMEOUT = 1000 * 60 * 5; // 5 mins

/**
 * FTP transport backed by the maintained `basic-ftp` package (replacing the
 * abandoned `ftp` package). UTF-8 is negotiated automatically, FTPS
 * (explicit/implicit) works out of the box and passive mode is robust.
 *
 * basic-ftp allows a single task at a time on the control connection —
 * launching a second one throws and closes the client. Every command is
 * therefore serialized through {@link run}, including the keepalive NOOP
 * (basic-ftp brings no keepalive of its own), which is skipped entirely
 * while real work is queued or running.
 *
 * A disconnected/errored control socket is surfaced through an EventEmitter so
 * KeepAliveRemoteFs.invalid() can reconnect lazily, matching the old contract.
 * The drop is reported the moment a command fails because of it, not only
 * when the next keepalive tick notices the closed socket; and a connection
 * that has been idle for {@link FTP_IDLE_TIMEOUT} is closed (reason `idle`).
 */
export default class FTPClient extends RemoteClient {
  private connected: boolean = false;
  private keepaliveTimer: NodeJS.Timer | undefined;
  private events: EventEmitter = new EventEmitter();
  private taskQueue: any = new PQueue({ concurrency: 1 });
  private lastActivityAt: number = 0;
  private idleTimeout: number = FTP_IDLE_TIMEOUT;

  _initClient() {
    // verbose logging goes through our own debug hook, set in _doConnect
    return new Client(0);
  }

  _hasProvideAuth(connectOption: ConnectOption) {
    // tslint:disable-next-line triple-equals
    return connectOption.password != undefined;
  }

  async _doConnect(connectOption: ConnectOption): Promise<void> {
    const {
      username,
      password,
      host,
      port,
      secure,
      secureOptions,
      connectTimeout = 10 * 1000,
      debug,
    } = connectOption;

    const client: Client = this._client;
    client.ftp.verbose = false;
    if (typeof debug === 'function') {
      client.ftp.log = (message: string) => debug(message);
    }

    // basic-ftp's timeout applies to the control socket
    client.ftp.socket.setTimeout(connectTimeout);

    try {
      await client.access({
        host,
        port: port || 21,
        user: username,
        password,
        // `secure: true` = explicit FTPS (AUTH TLS); 'implicit' also supported
        secure: secure === true ? true : secure,
        secureOptions,
      });
      this.connected = true;
      this.lastActivityAt = Date.now();
      this._startKeepAlive();
    } catch (error) {
      this.connected = false;
      throw error;
    }
  }

  // exposes the basic-ftp Client to FTPFileSystem
  getFsClient(): Client {
    return this._client;
  }

  // single-concurrency executor every FTP command must go through
  run<T>(task: () => Promise<T>): Promise<T> {
    return this._enqueue(task, true);
  }

  // `activity` is false for the keepalive NOOP: it must not count as use, or
  // an idle connection would never be idle
  private _enqueue<T>(task: () => Promise<T>, activity: boolean): Promise<T> {
    if (activity) {
      this.lastActivityAt = Date.now();
    }
    return this.taskQueue.add(async () => {
      try {
        return await task();
      } catch (error) {
        // a command that died with the socket: tell the owner now, so the
        // tasks behind it are held instead of failing one by one against a
        // closed client until the keepalive tick notices
        if (this.connected && (this._client.closed || isConnectionLostError(error))) {
          this._stopKeepAlive();
          this._emitDisconnected('error');
        }
        throw error;
      } finally {
        if (activity) {
          this.lastActivityAt = Date.now();
        }
      }
    });
  }

  onDisconnected(cb) {
    this.events.on('disconnected', cb);
  }

  /** Test seam: shortens the idle timeout of this client. */
  setIdleTimeoutForTest(ms: number) {
    this.idleTimeout = ms;
  }

  private _emitDisconnected(reason: string) {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.events.emit('disconnected', reason);
  }

  private _hasQueuedWork(): boolean {
    return this.taskQueue.size > 0 || this.taskQueue.pending > 0;
  }

  private _startKeepAlive() {
    this._stopKeepAlive();
    const client: Client = this._client;
    this.keepaliveTimer = setInterval(() => {
      if (client.closed) {
        this._stopKeepAlive();
        this._emitDisconnected('close');
        return;
      }
      // any queued or running command already keeps the connection alive, and
      // basic-ftp closes the whole client when tasks overlap
      if (this._hasQueuedWork()) {
        return;
      }
      if (this.idleTimeout > 0 && Date.now() - this.lastActivityAt >= this.idleTimeout) {
        this._closeIdle();
        return;
      }
      this._enqueue(() => client.send('NOOP'), false).catch((error: Error) => {
        // surface real socket drops so KeepAliveRemoteFs reconnects
        if (/closed|reset|EPIPE|not connected/i.test(error.message || '')) {
          this._stopKeepAlive();
          this._emitDisconnected('error');
        }
      });
    }, KEEPALIVE_INTERVAL);
    // don't keep the event loop alive just for the keepalive
    if (this.keepaliveTimer.unref) {
      this.keepaliveTimer.unref();
    }
  }

  private _closeIdle() {
    this._stopKeepAlive();
    this._emitDisconnected('idle');
    try {
      this._client.close();
    } catch (_error) {
      // already closed
    }
  }

  private _stopKeepAlive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
  }

  end() {
    this._stopKeepAlive();
    this.connected = false;
    try {
      this._client.close();
    } catch (_error) {
      // already closed
    }
  }
}

// re-exported so FTPFileSystem can reference the response type if needed
export { FTPResponse };
