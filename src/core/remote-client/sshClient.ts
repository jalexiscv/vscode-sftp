import { Client } from 'ssh2';
import upath from '../upath';
import RemoteClient, { ErrorCode, ConnectOption, Config } from './remoteClient';
import localFs from '../localFs';
import { FileSystem, RemoteFileSystem, SFTPFileSystem } from '../fs';
import logger from '../../logger';
import CustomError from '../customError';

let MAX_OPEN_FD_NUM = 222;

// a remote command that has not finished by then is closed and reported as failed
const EXEC_TIMEOUT_MS = 30 * 1000;

/** What a command run through {@link SSHClient.exec} left behind. */
export interface ExecResult {
  // exit status, or null when the server sent none (killed by a signal,
  // channel closed without an exit-status request)
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * SSH/SFTP transport for the extension, wrapping an ssh2 Client.
 *
 * Owns the connection lifecycle: authentication (password, key, agent,
 * keyboard-interactive), optional multi-hop tunneling through intermediate
 * hosts, and the SFTP channel used by SFTPFileSystem. A channel or client
 * closure must end the client so RemoteFs.invalid() reconnects lazily on
 * the next operation.
 *
 * Key lifecycle methods:
 * - {@link _doConnect} resolves hops/keys and opens the SFTP channel.
 * - {@link exec} runs one command on the host the SFTP channel talks to.
 * - {@link end} tears down this client and any hopping clients.
 */
export default class SSHClient extends RemoteClient {
  private sftp: any;
  private hoppingClients!: SSHClient[];
  private _opendFdNum: number = 0;
  private _queuedFdRequireCall: Array<(...args: any[]) => any> = [];

  _initClient() {
    return new Client();
  }

  _hasProvideAuth(connectOption: ConnectOption) {
    return (
      // interactiveAuth : boolean
      connectOption.interactiveAuth === true ||
      // or interactiveAuth : array of phrases
      (Array.isArray(connectOption.interactiveAuth) && !!connectOption.interactiveAuth.length) ||
      // or key defined
      ['password', 'agent', 'privateKeyPath'].some(
        // tslint:disable-next-line triple-equals
        key => connectOption[key] != undefined
      )
    );
  }

  async _doConnect(
    connectOption: ConnectOption,
    config: Config
  ): Promise<void> {
    const { hop, ...option } = connectOption;

    let lastOption: ConnectOption = option;
    let fs: FileSystem | RemoteFileSystem = localFs;
    let sock;
    if (
      (Array.isArray(hop) && hop.length > 0) ||
      (hop && Object.keys(hop).length > 0)
    ) {
      this.hoppingClients = [];
      const connectOptions = Array.isArray(hop)
        ? [option].concat(hop)
        : [option, hop];
      lastOption = connectOptions.pop()!;

      for (let index = 0; index < connectOptions.length; index++) {
        const curOpt = connectOptions[index];
        if (curOpt.port === undefined) {
          curOpt.port = 22;
        }
        const preClient = this.hoppingClients[index - 1];
        if (preClient) {
          sock = await this._makeHopping(preClient, curOpt.host, curOpt.port);
          fs = new SFTPFileSystem(upath, {
            client: preClient,
          });
        }

        if (curOpt.privateKeyPath) {
          const buffer = await fs.readFile(curOpt.privateKeyPath);
          curOpt.privateKey = buffer.toString();
        }

        const client = new SSHClient(curOpt);
        this.hoppingClients.push(client);
        await client.connect({ ...curOpt, sock }, config);
      }

      const lastClient = this.hoppingClients[this.hoppingClients.length - 1];
      sock = await this._makeHopping(
        lastClient,
        lastOption.host,
        lastOption.port
      );
      fs = new SFTPFileSystem(upath, {
        client: lastClient,
      });
    }

    if (lastOption.privateKeyPath) {
      const buffer = await fs.readFile(lastOption.privateKeyPath);
      lastOption.privateKey = buffer.toString();
    }

    await this._connectSSHClient(this._client, { ...lastOption, sock }, config);
    this.sftp = await this._getSftp(this._client);
    // A server-side SFTP channel termination (e.g. killed sftp-server or idle
    // timeout) doesn't emit any event on the ssh2 Client, so the extension
    // would hang reusing a dead channel. Propagate it as a client end, which
    // fires onDisconnected and lets the next operation reconnect.
    this.sftp.on('close', () => {
      this._client.end();
    });

    if (lastOption.limitOpenFilesOnRemote) {
      if (typeof lastOption.limitOpenFilesOnRemote !== 'boolean') {
        MAX_OPEN_FD_NUM = Math.max(127, lastOption.limitOpenFilesOnRemote);
      }
      this._limitSftpFileDescriptor();
    }
  }

  // connect1(readline): Promise<void> {
  //   const {
  //     interactiveAuth,
  //     password,
  //     privateKeyPath,
  //     connectTimeout,
  //     ...option // tslint:disable-line
  //   } = this.getOption();
  //   return new Promise<void>((resolve, reject) => {
  //     const connectWithCredential = (passwd?, privateKey?) =>
  //       this.client
  //         .on('ready', () => {
  //           this.client.sftp((err, sftp) => {
  //             if (err) {
  //               reject(err);
  //             }

  //             this.sftp = sftp;
  //             resolve();
  //           });
  //         })
  //         .on('error', err => {
  //           reject(err);
  //         })
  //         .connect({
  //           keepaliveInterval: 1000 * 30,
  //           keepaliveCountMax: 2,
  //           readyTimeout: interactiveAuth ? Math.max(60 * 1000, connectTimeout) : connectTimeout,
  //           ...option,
  //           privateKey,
  //           password: passwd,
  //           tryKeyboard: interactiveAuth,
  //         });

  //     if (interactiveAuth) {
  //       this.client.on('keyboard-interactive', function redo(
  //         name,
  //         instructions,
  //         instructionsLang,
  //         prompts,
  //         finish,
  //         stackedAnswers
  //       ) {
  //         const answers = stackedAnswers || [];
  //         if (answers.length < prompts.length) {
  //           readline(prompts[answers.length].prompt).then(answer => {
  //             answers.push(answer);
  //             redo(name, instructions, instructionsLang, prompts, finish, answers);
  //           });
  //         } else {
  //           finish(answers);
  //         }
  //       });
  //     }

  //     if (!privateKeyPath) {
  //       connectWithCredential(password);
  //       return;
  //     }

  //     fs.readFile(privateKeyPath, (err, data) => {
  //       if (err) {
  //         reject(err);
  //         return;
  //       }
  //       connectWithCredential(password, data);
  //     });
  //   });
  // }

  private _limitSftpFileDescriptor() {
    if (!this.sftp) {
      return;
    }

    const sftp = this.sftp;
    sftp._stream.open = this._hookCallForRequestFileDescriptor(
      sftp._stream.open
    );
    sftp._stream.opendir = this._hookCallForRequestFileDescriptor(
      sftp._stream.opendir
    );
    sftp._stream.close = this._hookCallForReleaseFileDescriptor(
      sftp._stream.close
    );
  }

  private _hookCallForReleaseFileDescriptor(fn) {
    const self = this;
    return function releaseFileDescriptor(this: any) {
      const last = arguments.length - 1;
      const args = Array.prototype.slice.call(arguments, 0, last);
      const cb = arguments[last];
      function wrapped(this: any) {
        // 队列到下一周期执行, 确保 cb 先执行.
        Promise.resolve().then(() => {
          if (self._queuedFdRequireCall.length > 0) {
            const queuedCall = self._queuedFdRequireCall.pop()!;
            queuedCall();
          }
        });
        self._opendFdNum -= 1;
        cb.apply(this, arguments);
      }
      args.push(wrapped);
      return fn.apply(this, args);
    };
  }

  private _hookCallForRequestFileDescriptor(fn) {
    const self = this;
    return function requestFileDescriptor(this: any) {
      const last = arguments.length - 1;
      const args = Array.prototype.slice.call(arguments, 0, last);
      const cb = arguments[last];
      function wrapped(this: any) {
        self._opendFdNum += 1;
        cb.apply(this, arguments);
      }
      args.push(wrapped);

      if (self._opendFdNum >= MAX_OPEN_FD_NUM) {
        self._queuedFdRequireCall.push(() => {
          fn.apply(this, args);
        });
        return;
      }

      return fn.apply(this, args);
    };
  }

  private async _connectSSHClient(
    client,
    remoteOption: ConnectOption,
    config: Config
  ): Promise<any> {
    const {
      interactiveAuth,
      connectTimeout,
      ...option // tslint:disable-line
    } = remoteOption;

    // explict compare to true, cause we want to distinct between string and true
    if (option.passphrase === true) {
      option.passphrase = await config.askForPasswd(
        `[${option.host}]: Enter your passphrase`
      );
      if (option.passphrase === undefined) {
        throw new CustomError(ErrorCode.CONNECT_CANCELLED, 'cancelled');
      }
    }

    return new Promise<void>((resolve, reject) => {
      if (interactiveAuth) {
        client.on('keyboard-interactive', function redo(
          name,
          instructions,
          instructionsLang,
          prompts,
          finish,
          stackedAnswers
        ) {
          const answers = stackedAnswers ||
            // load predefined answeres if any
            (Array.isArray(interactiveAuth) ? interactiveAuth : undefined) ||
            [];
          if (answers.length < prompts.length) {
            config
              .askForPasswd(
                `[${option.host}]: ${prompts[answers.length].prompt}`
              )
              .then(answer => {
                if (answer === undefined) {
                  return reject(
                    new CustomError(ErrorCode.CONNECT_CANCELLED, 'cancelled')
                  );
                }

                answers.push(answer);
                redo(
                  name,
                  instructions,
                  instructionsLang,
                  prompts,
                  finish,
                  answers
                );
              });
          } else {
            finish(answers);
          }
        });
      }

      client
        .on('ready', resolve)
        .on('error', err => {
          // the host goes into the message; the code (ECONNRESET, ETIMEDOUT,
          // ENOTFOUND…) and ssh2's level travel with it so the layers above
          // can still tell a dead network from a wrong password
          const wrapped: any = new Error(`[${option.host}]: ${err.message}`);
          if (err && err.code !== undefined) {
            wrapped.code = err.code;
          }
          if (err && err.level !== undefined) {
            wrapped.level = err.level;
          }
          reject(wrapped);
        })
        .connect({
          keepaliveInterval: 1000 * 30, // 30 secs, original
          // keepaliveInterval: 1000 * 600, // 10 mins
          // keepaliveInterval: 1000 * 1800, // 30 mins
          keepaliveCountMax: 2, // x2 original
          // keepaliveCountMax: 3, // x3
          // keepaliveCountMax: 6, // x6
          readyTimeout: interactiveAuth
            ? Math.max(60 * 1000, connectTimeout || 0) // 60 secs, original
            // ? Math.max(1800 * 1000, connectTimeout || 0) // 30 mins
            // ? Math.max(10800 * 1000, connectTimeout || 0) // 180 mins
            : connectTimeout,
          ...option,
          tryKeyboard: !!interactiveAuth,
        });
    });
  }

  private _getSftp(client): Promise<any> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(err);
        }

        resolve(sftp);
      });
    });
  }

  private _makeHopping(sshClient: SSHClient, dstHost, dstPort): Promise<any> {
    logger.info(`hopping from ${sshClient._option.host} to ${dstHost}`);
    return new Promise((resolve, reject) => {
      // Create a connect form 127.0.0.1:port to dstHost:dstPort
      sshClient._client.forwardOut(
        '127.0.0.1',
        sshClient._option.port,
        dstHost,
        dstPort,
        (error, stream) => {
          if (error) {
            return reject(error);
          }

          resolve(stream);
        }
      );
    });
  }

  /**
   * Runs `command` on the server this client is connected to and resolves
   * once its channel closes, with the exit code and whatever was written to
   * stdout and stderr. With `hop`, `_client` is the connection of the last
   * hop (the intermediate ones only forward its socket), so the command runs
   * where the SFTP channel does.
   *
   * A non-zero exit code is an answer, not a rejection. It rejects when the
   * server refuses the exec request (SFTP-only accounts, no shell), when the
   * client is not connected, or when the command outlives `timeout` ms; in
   * the latter case the channel is closed so nothing is left open.
   */
  exec(command: string, timeout: number = EXEC_TIMEOUT_MS): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timer | undefined;
      let channel: any;
      const settle = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        fn();
      };

      // armed before exec() so a callback that answers synchronously (a
      // refused request, a client not connected) clears it instead of
      // leaving a dangling 30 s timer; unref'd so it never holds the process
      timer = setTimeout(() => {
        settle(() => {
          if (channel && typeof channel.close === 'function') {
            try {
              channel.close();
            } catch (_error) {
              // the channel is gone already; nothing to release
            }
          }
          reject(new Error(`exec timed out after ${timeout} ms: ${command}`));
        });
      }, timeout);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      try {
        this._client.exec(command, (err, stream) => {
          if (err) {
            settle(() => reject(err));
            return;
          }

          channel = stream;
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          let code: number | null = null;
          stream.on('data', chunk => stdout.push(chunk));
          stream.stderr.on('data', chunk => stderr.push(chunk));
          // ssh2 emits 'exit' with the status when the server sends one and
          // repeats it on 'close'; a signal or a plain close leave it null
          stream.on('exit', exitCode => {
            code = typeof exitCode === 'number' ? exitCode : null;
          });
          stream.on('close', closeCode => {
            if (typeof closeCode === 'number') {
              code = closeCode;
            }
            settle(() =>
              resolve({
                code,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
              })
            );
          });
          stream.on('error', error => settle(() => reject(error)));
        });
      } catch (error) {
        settle(() => reject(error));
      }
    });
  }

  end() {
    this._client.end();

    if (this.hoppingClients) {
      // last connect first end
      this.hoppingClients.reverse().forEach(client => client.end());
    }
  }

  getFsClient() {
    return this.sftp;
  }
}
