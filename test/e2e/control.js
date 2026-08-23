// A minimal JSON-lines request/response channel over TCP on 127.0.0.1.
//
// The runner (the process that owns the SFTP server and acts as "another
// program" editing the workspace) listens; the script running inside the VS
// Code extension host connects and asks it to do things. Nothing but Node
// built-ins, so it can be required from both sides.
'use strict';

const net = require('net');

/**
 * Starts the control server. `handlers` maps a command name to
 * `(args) => result | Promise<result>`. Resolves with `{ port, close() }`.
 */
function createControlServer(handlers, log) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));

    async function handleLine(line) {
      let request;
      try {
        request = JSON.parse(line);
      } catch (error) {
        return;
      }
      const reply = { id: request.id };
      try {
        const handler = handlers[request.cmd];
        if (!handler) {
          throw new Error(`unknown control command: ${request.cmd}`);
        }
        reply.ok = true;
        reply.result = await handler(request.args || {});
      } catch (error) {
        reply.ok = false;
        reply.error = error && error.message ? error.message : String(error);
      }
      if (log && request.cmd !== 'log') {
        log(`[control] ${request.cmd} -> ${reply.ok ? 'ok' : 'error: ' + reply.error}`);
      }
      if (!socket.destroyed) {
        socket.write(JSON.stringify(reply) + '\n');
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        port: server.address().port,
        close() {
          sockets.forEach(socket => socket.destroy());
          return new Promise(done => server.close(() => done()));
        },
      });
    });
  });
}

/** Connects to the control server; resolves with `{ call(cmd, args), close() }`. */
function connectControl(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.setNoDelay(true);
    const pending = new Map();
    let nextId = 1;
    let buffer = '';

    socket.once('error', reject);
    socket.on('connect', () => {
      socket.removeListener('error', reject);
      socket.on('error', error => {
        pending.forEach(entry => entry.reject(error));
        pending.clear();
      });
      resolve({
        call(cmd, args) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { resolve: res, reject: rej });
            socket.write(JSON.stringify({ id, cmd, args: args || {} }) + '\n');
          });
        },
        close() {
          socket.end();
        },
      });
    });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        let reply;
        try {
          reply = JSON.parse(line);
        } catch (error) {
          continue;
        }
        const entry = pending.get(reply.id);
        if (!entry) {
          continue;
        }
        pending.delete(reply.id);
        if (reply.ok) {
          entry.resolve(reply.result);
        } else {
          entry.reject(new Error(reply.error));
        }
      }
    });
  });
}

module.exports = { createControlServer, connectControl };
