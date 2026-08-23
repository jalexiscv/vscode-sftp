import { EventEmitter } from 'events';
import SSHClient from '../sshClient';

/**
 * exec() is what the hash verification rides on over SFTP. The ssh2 Client
 * is faked at its exec(command, cb) boundary with a channel that behaves
 * like ssh2's: 'data' on the channel and on channel.stderr, an 'exit' with
 * the status, then a 'close' that repeats it.
 */

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  close = jest.fn();
}

function createClient() {
  const client = new SSHClient({ host: 'example.org', port: 22 } as any);
  const exec = jest.fn();
  // the real ssh2 Client built by the constructor is swapped for the fake
  (client as any)._client = { exec };
  return { client, exec };
}

// hands the channel to the callback and lets the test script it afterwards
function scriptExec(exec: jest.Mock, script: (channel: FakeChannel) => void) {
  exec.mockImplementation((_command: string, cb: (err: any, channel: FakeChannel) => void) => {
    const channel = new FakeChannel();
    cb(null, channel);
    setImmediate(() => script(channel));
  });
}

describe('SSHClient.exec', () => {
  test('collects stdout, stderr and the exit status once the channel closes', async () => {
    const { client, exec } = createClient();
    scriptExec(exec, channel => {
      channel.emit('data', Buffer.from('e3b0c442  /dev/null\n'));
      channel.stderr.emit('data', Buffer.from('some warning\n'));
      channel.emit('exit', 0);
      channel.emit('close', 0);
    });

    await expect(client.exec('sha256sum /dev/null')).resolves.toEqual({
      code: 0,
      stdout: 'e3b0c442  /dev/null\n',
      stderr: 'some warning\n',
    });
    expect(exec).toHaveBeenCalledWith('sha256sum /dev/null', expect.any(Function));
  });

  test('a non-zero exit status is an answer, not a rejection', async () => {
    const { client, exec } = createClient();
    scriptExec(exec, channel => {
      channel.stderr.emit('data', Buffer.from('sh: sha256sum: not found\n'));
      channel.emit('exit', 127);
      channel.emit('close', 127);
    });

    await expect(client.exec('sha256sum /dev/null')).resolves.toEqual({
      code: 127,
      stdout: '',
      stderr: 'sh: sha256sum: not found\n',
    });
  });

  test('joins output delivered in several chunks', async () => {
    const { client, exec } = createClient();
    scriptExec(exec, channel => {
      channel.emit('data', Buffer.from('abc'));
      channel.emit('data', Buffer.from('def\n'));
      channel.emit('close', 0);
    });

    const result = await client.exec('cat file');
    expect(result.stdout).toBe('abcdef\n');
    expect(result.code).toBe(0);
  });

  test('a channel closed without an exit status reports code null', async () => {
    const { client, exec } = createClient();
    scriptExec(exec, channel => {
      channel.emit('close');
    });

    const result = await client.exec('true');
    expect(result.code).toBeNull();
  });

  test('a signal leaves the code null as well', async () => {
    const { client, exec } = createClient();
    scriptExec(exec, channel => {
      channel.emit('exit', null, 'SIGKILL', false, '');
      channel.emit('close', null, 'SIGKILL', false, '');
    });

    const result = await client.exec('sleep 100');
    expect(result.code).toBeNull();
  });

  test('rejects when the server refuses the exec request', async () => {
    const { client, exec } = createClient();
    exec.mockImplementation((_command: string, cb: (err: any) => void) => {
      cb(new Error('Unable to exec'));
    });

    await expect(client.exec('sha256sum /dev/null')).rejects.toThrow('Unable to exec');
  });

  test('rejects when the client throws synchronously (not connected)', async () => {
    const { client, exec } = createClient();
    exec.mockImplementation(() => {
      throw new Error('Not connected');
    });

    await expect(client.exec('true')).rejects.toThrow('Not connected');
  });

  test('rejects on a channel error', async () => {
    const { client, exec } = createClient();
    scriptExec(exec, channel => {
      channel.emit('error', new Error('channel reset'));
    });

    await expect(client.exec('true')).rejects.toThrow('channel reset');
  });

  test('times out, closes the channel and ignores whatever it says afterwards', async () => {
    const { client, exec } = createClient();
    let channel!: FakeChannel;
    scriptExec(exec, ch => {
      channel = ch;
      // never closes on its own
    });

    await expect(client.exec('sleep 100', 30)).rejects.toThrow(/timed out after 30 ms: sleep 100/);
    expect(channel.close).toHaveBeenCalledTimes(1);

    // a late close must not throw or resolve anything
    channel.emit('data', Buffer.from('late'));
    channel.emit('close', 0);
  });

  test('a fast answer never hits the timeout', async () => {
    const { client, exec } = createClient();
    scriptExec(exec, channel => {
      channel.emit('data', Buffer.from('ok'));
      channel.emit('close', 0);
    });

    await expect(client.exec('true', 1000)).resolves.toEqual({ code: 0, stdout: 'ok', stderr: '' });
  });
});
