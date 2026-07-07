import upath from './upath';
import { promptForPassword } from '../host';
import logger from '../logger';
import app from '../app';
import {
  passwordKey,
  getSavedPassword,
  removeSavedPassword,
  offerToSavePassword,
  isSavedPasswordsAvailable,
} from '../modules/savedPasswords';
import { ConnectOption } from './remote-client/remoteClient';
import {
  FileSystem,
  RemoteFileSystem,
  SFTPFileSystem,
  FTPFileSystem,
} from './fs';
import localFs from './localFs';

function hashOption(opiton) {
  return Object.keys(opiton)
    .map(key => opiton[key])
    .join('');
}

// mirror of the clients' _hasProvideAuth: a saved password only applies when
// the config brings no authentication of its own
function hasExplicitAuth(option: ConnectOption): boolean {
  return (
    option.password !== undefined ||
    option.privateKeyPath !== undefined ||
    option.privateKey !== undefined ||
    option.agent !== undefined ||
    option.interactiveAuth === true ||
    (Array.isArray(option.interactiveAuth) && option.interactiveAuth.length > 0)
  );
}

function isAuthFailure(error: Error): boolean {
  return /auth|530|password|permission denied/i.test(error.message || '');
}

class KeepAliveRemoteFs {
  private isValid: boolean = false;

  private pendingPromise: Promise<RemoteFileSystem> | null = null;

  private fs!: RemoteFileSystem;

  async getFs(
    option: ConnectOption & {
      protocol: string;
      remoteTimeOffsetInHours: number;
    }
  ): Promise<RemoteFileSystem> {
    if (this.isValid) {
      this.pendingPromise = null;
      return Promise.resolve(this.fs);
    }

    if (this.pendingPromise) {
      return this.pendingPromise;
    }

    const connectOption = Object.assign({}, option);
    // tslint:disable variable-name
    let FsConstructor: typeof SFTPFileSystem | typeof FTPFileSystem;
    if (option.protocol === 'sftp') {
      connectOption.debug = function debug(str) {
        const log = str.match(/^DEBUG(?:\[SFTP\])?: (.*?): (.*?)$/);

        if (log) {
          if (log[1] === 'Parser') return;
          logger.debug(`${log[1]}: ${log[2]}`);
        } else {
          logger.debug(str);
        }
      };
      FsConstructor = SFTPFileSystem;
    } else if (option.protocol === 'ftp') {
      connectOption.debug = function debug(str) {
        const log = str.match(/^\[connection\] (>|<) (.*?)(\\r\\n)?$/);

        if (!log) return;

        if (log[2].match(/200 NOOP/)) return;

        if (log[2].match(/^PASS /)) log[2] = 'PASS ******';

        logger.debug(`${log[1]} ${log[2]}`);
      };
      FsConstructor = FTPFileSystem;
    } else {
      throw new Error(`unsupported protocol ${option.protocol}`);
    }

    this.fs = new FsConstructor(upath, {
      clientOption: connectOption,
      remoteTimeOffsetInHours: option.remoteTimeOffsetInHours,
    });
    this.fs.onDisconnected(this.invalid.bind(this));

    // saved-password support: inject a stored password when the config
    // brings no auth, and remember the one the user types to offer saving it
    const secretKey = passwordKey(connectOption);
    const passwordLabel = `${connectOption.username || ''}@${connectOption.host}`;
    const canUseSavedPassword = isSavedPasswordsAvailable() && !hasExplicitAuth(connectOption);
    let usedSavedPassword = false;
    let typedPassword: string | undefined;

    const connectConfig = {
      askForPasswd: async (msg: string) => {
        const anwser = await promptForPassword(msg);
        if (canUseSavedPassword && anwser && msg.indexOf('Enter your password') !== -1) {
          typedPassword = anwser;
        }
        return anwser;
      },
    };

    app.sftpBarItem.showMsg('connecting...', connectOption.connectTimeout);
    const connectPromise = (async () => {
      if (canUseSavedPassword) {
        const saved = await getSavedPassword(secretKey);
        if (saved !== undefined) {
          connectOption.password = saved;
          usedSavedPassword = true;
        }
      }

      try {
        await this.fs.connect(connectOption, connectConfig);
      } catch (error) {
        if (!usedSavedPassword || !isAuthFailure(error)) {
          throw error;
        }

        // the saved password went stale: forget it and prompt again
        logger.warn(`saved password rejected for ${passwordLabel}, prompting again`);
        await removeSavedPassword(secretKey);
        usedSavedPassword = false;
        delete connectOption.password;
        await this.fs.connect(connectOption, connectConfig);
      }
    })();

    this.pendingPromise = connectPromise.then(
      () => {
        app.sftpBarItem.reset();
        this.isValid = true;
        if (typedPassword !== undefined) {
          // fire and forget: don't block the connection on the toast
          offerToSavePassword(secretKey, typedPassword, passwordLabel);
          typedPassword = undefined;
        }
        return this.fs;
      },
      err => {
        this.fs.end();
        this.invalid('error');
        throw err;
      }
    );

    return this.pendingPromise;
  }

  invalid(reason: string) {
    this.pendingPromise = null;
    this.fs.end();
    this.isValid = false;
  }

  end() {
    this.fs.end();
  }
}

function getLocalFs() {
  return Promise.resolve(localFs);
}

const fsTable: {
  [x: string]: KeepAliveRemoteFs;
} = {};

export function createRemoteIfNoneExist(option): Promise<FileSystem> {
  if (option.protocol === 'local') {
    return getLocalFs();
  }

  const identity = hashOption(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    return fs.getFs(option);
  }

  const fsInstance = new KeepAliveRemoteFs();
  fsTable[identity] = fsInstance;
  return fsInstance.getFs(option);
}

export function removeRemoteFs(option) {
  const identity = hashOption(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    fs.end();
    delete fsTable[identity];
  }
}

// connect once to verify the credentials, closing the connection afterwards
// unless an equivalent one was already alive (in that case it is shared with
// running file services and must be kept open)
export async function testRemoteConnection(option): Promise<void> {
  if (option.protocol === 'local') {
    return;
  }

  const identity = hashOption(option);
  const alreadyExists = fsTable[identity] !== undefined;
  try {
    await createRemoteIfNoneExist(option);
  } finally {
    if (!alreadyExists) {
      removeRemoteFs(option);
    }
  }
}
