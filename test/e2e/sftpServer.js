// A small SFTP server for the end-to-end tests, built on the `ssh2` package
// the extension itself depends on (no extra dependency).
//
// It serves one local directory as the remote root, authenticates a single
// user with a password, records every request it receives (the "ops" log is
// the evidence the tests read back) and lets the runner inject faults:
//
//   faults.truncate  Set<remotePath>  WRITEs for these paths are acknowledged
//                                     but never land on disk, so the file ends
//                                     up empty and the size verification fails.
//   faults.failWrite Set<remotePath>  WRITEs for these paths are answered with
//                                     SSH_FX_FAILURE.
//
// `exec` requests are refused on purpose: the server has no shell, which is
// what makes `verifyUpload: "hash"` degrade to `stat`.
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { Server, utils } = require('ssh2');

const { OPEN_MODE, STATUS_CODE, flagsToString } = utils.sftp;

const MAX_OPS = 20000;

function toAttrs(stat) {
  return {
    mode: stat.mode,
    uid: 0,
    gid: 0,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

function longname(name, stat) {
  const type = stat.isDirectory() ? 'd' : '-';
  const when = new Date(stat.mtimeMs);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const date = `${months[when.getMonth()]} ${String(when.getDate()).padStart(2, ' ')} ` +
    `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return `${type}rw-r--r--    1 test     test ${String(stat.size).padStart(12, ' ')} ${date} ${name}`;
}

function errnoToStatus(error) {
  if (!error) {
    return STATUS_CODE.OK;
  }
  switch (error.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return STATUS_CODE.NO_SUCH_FILE;
    case 'EACCES':
    case 'EPERM':
      return STATUS_CODE.PERMISSION_DENIED;
    default:
      return STATUS_CODE.FAILURE;
  }
}

/** Finds a free TCP port on 127.0.0.1. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts the server. Resolves with a handle exposing `port`, `ops`, `faults`,
 * `close()` and `resetOps()`.
 *
 * @param {object} options
 * @param {string} options.root       local directory served as "/"
 * @param {string} options.hostKey    private host key (PEM or OpenSSH format)
 * @param {number} [options.port]     0 / undefined picks a free port
 * @param {string} [options.username] default "test"
 * @param {string} [options.password] default "test"
 * @param {(line: string) => void} [options.log]
 */
async function startSftpServer(options) {
  const root = path.resolve(options.root);
  const username = options.username || 'test';
  const password = options.password || 'test';
  const log = options.log || (() => undefined);
  const ops = [];
  const faults = { truncate: new Set(), failWrite: new Set() };
  let clients = 0;

  fs.mkdirSync(root, { recursive: true });

  const record = op => {
    op.t = Date.now();
    ops.push(op);
    if (ops.length > MAX_OPS) {
      ops.splice(0, ops.length - MAX_OPS);
    }
  };

  // remote "/a/b" -> "<root>/a/b", never escaping the root
  const toLocal = remotePath => {
    const normalized = path.posix.normalize('/' + String(remotePath || '/').replace(/\\/g, '/'));
    return path.join(root, normalized);
  };
  const toRemote = remotePath => path.posix.normalize('/' + String(remotePath || '/').replace(/\\/g, '/'));

  const server = new Server({ hostKeys: [options.hostKey] }, client => {
    clients++;
    const clientId = clients;
    log(`[sftp-server] client #${clientId} connected`);

    client.on('error', error => log(`[sftp-server] client #${clientId} error: ${error.message}`));
    client.on('close', () => log(`[sftp-server] client #${clientId} closed`));

    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
        record({ op: 'AUTH', path: ctx.username, ok: true });
        ctx.accept();
        return;
      }
      if (ctx.method !== 'none') {
        record({ op: 'AUTH', path: ctx.username, ok: false, method: ctx.method });
      }
      ctx.reject(['password']);
    });

    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        // no shell on this server: the client's hash probe must degrade
        session.on('exec', (_accept, reject, info) => {
          record({ op: 'EXEC', path: info && info.command });
          reject();
        });
        session.on('shell', (_accept, reject) => reject());
        session.on('sftp', acceptSftp => {
          const sftp = acceptSftp();
          wireSftp(sftp);
        });
      });
    });

    function wireSftp(sftp) {
      let nextHandle = 1;
      // handle id -> { type: 'file', fd, remotePath, written } | { type: 'dir', entries, sent }
      const handles = new Map();

      const newHandle = value => {
        const id = nextHandle++;
        const buffer = Buffer.alloc(4);
        buffer.writeUInt32BE(id, 0);
        handles.set(id, value);
        return buffer;
      };
      const lookup = handle => handles.get(handle.readUInt32BE(0));

      const fail = (reqID, error) => sftp.status(reqID, errnoToStatus(error), error && error.message);

      sftp.on('REALPATH', (reqID, remotePath) => {
        const resolved = toRemote(remotePath === '.' ? '/' : remotePath);
        record({ op: 'REALPATH', path: resolved });
        let attrs;
        try {
          const stat = fs.statSync(toLocal(resolved));
          attrs = toAttrs(stat);
        } catch (error) {
          attrs = {};
        }
        sftp.name(reqID, [{ filename: resolved, longname: resolved, attrs }]);
      });

      const statLike = (kind, follow) => (reqID, remotePath) => {
        const rp = toRemote(remotePath);
        try {
          const stat = follow ? fs.statSync(toLocal(rp)) : fs.lstatSync(toLocal(rp));
          record({ op: kind, path: rp, size: stat.size, ok: true });
          sftp.attrs(reqID, toAttrs(stat));
        } catch (error) {
          record({ op: kind, path: rp, ok: false, code: error.code });
          fail(reqID, error);
        }
      };
      sftp.on('STAT', statLike('STAT', true));
      sftp.on('LSTAT', statLike('LSTAT', false));

      sftp.on('FSTAT', (reqID, handle) => {
        const entry = lookup(handle);
        if (!entry || entry.type !== 'file') {
          return sftp.status(reqID, STATUS_CODE.FAILURE);
        }
        try {
          const stat = fs.fstatSync(entry.fd);
          record({ op: 'FSTAT', path: entry.remotePath, size: stat.size });
          sftp.attrs(reqID, toAttrs(stat));
        } catch (error) {
          fail(reqID, error);
        }
      });

      // `fd` is used when given; on windows futimes needs a writable handle,
      // so a read-only one falls back to the path
      const applyAttrs = (localPath, fd, attrs) => {
        if (attrs && (attrs.atime !== undefined || attrs.mtime !== undefined)) {
          const now = Math.floor(Date.now() / 1000);
          const atime = attrs.atime !== undefined ? attrs.atime : now;
          const mtime = attrs.mtime !== undefined ? attrs.mtime : now;
          try {
            if (fd === undefined) {
              throw new Error('no fd');
            }
            fs.futimesSync(fd, atime, mtime);
          } catch (error) {
            fs.utimesSync(localPath, atime, mtime);
          }
        }
        if (attrs && attrs.mode !== undefined) {
          try {
            if (fd !== undefined) {
              fs.fchmodSync(fd, attrs.mode);
            } else {
              fs.chmodSync(localPath, attrs.mode);
            }
          } catch (error) {
            // windows has no real modes; never fail a SETSTAT over it
          }
        }
      };

      sftp.on('SETSTAT', (reqID, remotePath, attrs) => {
        const rp = toRemote(remotePath);
        record({ op: 'SETSTAT', path: rp, mtime: attrs && attrs.mtime });
        try {
          applyAttrs(toLocal(rp), undefined, attrs);
          sftp.status(reqID, STATUS_CODE.OK);
        } catch (error) {
          fail(reqID, error);
        }
      });

      sftp.on('FSETSTAT', (reqID, handle, attrs) => {
        const entry = lookup(handle);
        if (!entry || entry.type !== 'file') {
          return sftp.status(reqID, STATUS_CODE.FAILURE);
        }
        record({ op: 'FSETSTAT', path: entry.remotePath, mtime: attrs && attrs.mtime });
        try {
          applyAttrs(toLocal(entry.remotePath), entry.fd, attrs);
          sftp.status(reqID, STATUS_CODE.OK);
        } catch (error) {
          fail(reqID, error);
        }
      });

      sftp.on('OPEN', (reqID, remotePath, pflags, attrs) => {
        const rp = toRemote(remotePath);
        const flags = flagsToString(pflags) || 'r';
        const writing = (pflags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND)) !== 0; // tslint:disable-line
        record({ op: 'OPEN', path: rp, flags, write: writing });
        try {
          const mode = attrs && attrs.mode !== undefined ? attrs.mode : 0o644;
          const fd = fs.openSync(toLocal(rp), flags, mode);
          sftp.handle(reqID, newHandle({ type: 'file', fd, remotePath: rp, written: 0, writing }));
        } catch (error) {
          record({ op: 'OPEN-FAILED', path: rp, code: error.code });
          fail(reqID, error);
        }
      });

      sftp.on('WRITE', (reqID, handle, offset, data) => {
        const entry = lookup(handle);
        if (!entry || entry.type !== 'file') {
          return sftp.status(reqID, STATUS_CODE.FAILURE);
        }
        if (faults.failWrite.has(entry.remotePath)) {
          record({ op: 'WRITE-FAULT', path: entry.remotePath, fault: 'failWrite', bytes: data.length });
          return sftp.status(reqID, STATUS_CODE.FAILURE, 'injected write failure');
        }
        if (faults.truncate.has(entry.remotePath)) {
          // acknowledged, never written: the file stays as OPEN left it (empty)
          record({ op: 'WRITE-FAULT', path: entry.remotePath, fault: 'truncate', bytes: data.length });
          return sftp.status(reqID, STATUS_CODE.OK);
        }
        try {
          fs.writeSync(entry.fd, data, 0, data.length, offset);
          entry.written += data.length;
          sftp.status(reqID, STATUS_CODE.OK);
        } catch (error) {
          fail(reqID, error);
        }
      });

      sftp.on('READ', (reqID, handle, offset, length) => {
        const entry = lookup(handle);
        if (!entry || entry.type !== 'file') {
          return sftp.status(reqID, STATUS_CODE.FAILURE);
        }
        try {
          const buffer = Buffer.alloc(length);
          const bytesRead = fs.readSync(entry.fd, buffer, 0, length, offset);
          if (bytesRead === 0) {
            return sftp.status(reqID, STATUS_CODE.EOF);
          }
          sftp.data(reqID, buffer.slice(0, bytesRead));
        } catch (error) {
          fail(reqID, error);
        }
      });

      sftp.on('CLOSE', (reqID, handle) => {
        const id = handle.readUInt32BE(0);
        const entry = handles.get(id);
        handles.delete(id);
        if (!entry) {
          return sftp.status(reqID, STATUS_CODE.FAILURE);
        }
        if (entry.type === 'file') {
          try {
            fs.closeSync(entry.fd);
          } catch (error) {
            // already closed
          }
          let size;
          try {
            size = fs.statSync(toLocal(entry.remotePath)).size;
          } catch (error) {
            size = undefined;
          }
          record({ op: 'CLOSE', path: entry.remotePath, write: entry.writing, written: entry.written, size });
        } else {
          record({ op: 'CLOSEDIR', path: entry.remotePath });
        }
        sftp.status(reqID, STATUS_CODE.OK);
      });

      sftp.on('OPENDIR', (reqID, remotePath) => {
        const rp = toRemote(remotePath);
        try {
          const local = toLocal(rp);
          if (!fs.statSync(local).isDirectory()) {
            record({ op: 'OPENDIR', path: rp, ok: false });
            return sftp.status(reqID, STATUS_CODE.FAILURE, 'not a directory');
          }
          const entries = fs.readdirSync(local).map(name => {
            const stat = fs.lstatSync(path.join(local, name));
            return { filename: name, longname: longname(name, stat), attrs: toAttrs(stat) };
          });
          record({ op: 'OPENDIR', path: rp, ok: true, count: entries.length });
          sftp.handle(reqID, newHandle({ type: 'dir', entries, sent: false, remotePath: rp }));
        } catch (error) {
          record({ op: 'OPENDIR', path: rp, ok: false, code: error.code });
          fail(reqID, error);
        }
      });

      sftp.on('READDIR', (reqID, handle) => {
        const entry = lookup(handle);
        if (!entry || entry.type !== 'dir') {
          return sftp.status(reqID, STATUS_CODE.FAILURE);
        }
        if (entry.sent) {
          return sftp.status(reqID, STATUS_CODE.EOF);
        }
        entry.sent = true;
        sftp.name(reqID, entry.entries);
      });

      sftp.on('MKDIR', (reqID, remotePath, attrs) => {
        const rp = toRemote(remotePath);
        try {
          fs.mkdirSync(toLocal(rp), { mode: attrs && attrs.mode !== undefined ? attrs.mode : 0o755 });
          record({ op: 'MKDIR', path: rp, ok: true });
          sftp.status(reqID, STATUS_CODE.OK);
        } catch (error) {
          record({ op: 'MKDIR', path: rp, ok: false, code: error.code });
          // EEXIST -> FAILURE (the client then stats and finds the directory);
          // ENOENT -> NO_SUCH_FILE (the client creates the parent first)
          fail(reqID, error);
        }
      });

      sftp.on('RMDIR', (reqID, remotePath) => {
        const rp = toRemote(remotePath);
        try {
          fs.rmdirSync(toLocal(rp));
          record({ op: 'RMDIR', path: rp, ok: true });
          sftp.status(reqID, STATUS_CODE.OK);
        } catch (error) {
          record({ op: 'RMDIR', path: rp, ok: false, code: error.code });
          fail(reqID, error);
        }
      });

      sftp.on('REMOVE', (reqID, remotePath) => {
        const rp = toRemote(remotePath);
        try {
          fs.unlinkSync(toLocal(rp));
          record({ op: 'REMOVE', path: rp, ok: true });
          sftp.status(reqID, STATUS_CODE.OK);
        } catch (error) {
          record({ op: 'REMOVE', path: rp, ok: false, code: error.code });
          fail(reqID, error);
        }
      });

      sftp.on('RENAME', (reqID, oldPath, newPath) => {
        const from = toRemote(oldPath);
        const to = toRemote(newPath);
        try {
          fs.renameSync(toLocal(from), toLocal(to));
          record({ op: 'RENAME', path: from, to, ok: true });
          sftp.status(reqID, STATUS_CODE.OK);
        } catch (error) {
          record({ op: 'RENAME', path: from, to, ok: false, code: error.code });
          fail(reqID, error);
        }
      });

      sftp.on('READLINK', (reqID, remotePath) => {
        const rp = toRemote(remotePath);
        try {
          const target = fs.readlinkSync(toLocal(rp));
          sftp.name(reqID, [{ filename: target, longname: target, attrs: {} }]);
        } catch (error) {
          fail(reqID, error);
        }
      });

      sftp.on('EXTENDED', (reqID, extName) => {
        record({ op: 'EXTENDED', path: extName });
        sftp.status(reqID, STATUS_CODE.OP_UNSUPPORTED);
      });
    }
  });

  const port = options.port || (await findFreePort());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  log(`[sftp-server] listening on 127.0.0.1:${port}, root ${root}`);

  return {
    port,
    root,
    username,
    password,
    ops,
    faults,
    resetOps() {
      ops.length = 0;
    },
    close() {
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

/** Lists the files under `root` as { "rel/path": { size, mtimeMs, content? } }. */
function snapshotTree(root, withContent) {
  const result = {};
  const walk = dir => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      return;
    }
    names.forEach(name => {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        const entry = { size: stat.size, mtimeMs: stat.mtimeMs };
        if (withContent && stat.size <= 64 * 1024) {
          entry.content = fs.readFileSync(full).toString('base64');
        }
        result[rel] = entry;
      }
    });
  };
  walk(root);
  return result;
}

module.exports = { startSftpServer, snapshotTree, findFreePort };
