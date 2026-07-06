import { Client, FTPResponse } from 'basic-ftp';
import { EventEmitter } from 'events';
import * as PQueue from 'p-queue';
import RemoteClient, { ConnectOption } from './remoteClient';

const KEEPALIVE_INTERVAL = 1000 * 10; // 10 secs

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
 */
export default class FTPClient extends RemoteClient {
  private connected: boolean = false;
  private keepaliveTimer: NodeJS.Timer | undefined;
  private events: EventEmitter = new EventEmitter();
  private taskQueue: any = new PQueue({ concurrency: 1 });

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
    return this.taskQueue.add(task);
  }

  onDisconnected(cb) {
    this.events.on('disconnected', cb);
  }

  private _emitDisconnected(reason: string) {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.events.emit('disconnected', reason);
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
      if (this.taskQueue.size > 0 || this.taskQueue.pending > 0) {
        return;
      }
      this.run(() => client.send('NOOP')).catch((error: Error) => {
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
