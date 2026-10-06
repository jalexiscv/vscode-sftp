jest.mock('fs');

import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import { vol } from 'memfs';
import {
  getBuffer,
  getJson,
  getText,
  downloadToFile,
  HttpStatusError,
  USER_AGENT,
} from '../httpClient';

/**
 * The client is exercised against a local http server: redirects (absolute
 * and relative), status errors, JSON, timeouts and the download to disk
 * (memfs) with its partial file.
 */

const PAYLOAD = Buffer.from('vsix bytes '.repeat(1000));

let server: http.Server;
let base: string;
let requests: http.IncomingMessage[];

function route(request: http.IncomingMessage, response: http.ServerResponse) {
  requests.push(request);
  switch (request.url) {
    case '/json':
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ tag_name: 'v1.30.0', ok: true }));
      return;
    case '/text':
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('abc123  sftp-1.30.0.vsix\n');
      return;
    case '/redirect-absolute':
      response.writeHead(302, { Location: `${base}/json` });
      response.end('moved');
      return;
    case '/redirect-relative':
      response.writeHead(301, { Location: '/redirect-absolute' });
      response.end();
      return;
    case '/loop':
      response.writeHead(302, { Location: '/loop' });
      response.end();
      return;
    case '/missing':
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not Found\nsecond line');
      return;
    case '/file':
      response.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
      response.end(PAYLOAD);
      return;
    case '/file-redirect':
      response.writeHead(302, { Location: '/file' });
      response.end();
      return;
    case '/truncated':
      // claims more than it sends, then closes
      response.writeHead(200, { 'Content-Length': String(PAYLOAD.length * 2) });
      response.write(PAYLOAD);
      response.destroy();
      return;
    case '/invalid-json':
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{not json');
      return;
    case '/slow':
      // never answers; the client's timeout has to fire
      return;
    default:
      response.writeHead(500);
      response.end();
  }
}

beforeAll(
  () =>
    new Promise<void>(resolve => {
      server = http.createServer(route);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        base = `http://127.0.0.1:${port}`;
        resolve();
      });
    })
);

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

beforeEach(() => {
  requests = [];
  vol.reset();
  vol.mkdirSync('/downloads', { recursive: true });
});

async function rejectionOf(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('httpClient', () => {
  test('getJson parses the body and sends a User-Agent and an Accept header', async () => {
    const json = await getJson(`${base}/json`);

    expect(json).toEqual({ tag_name: 'v1.30.0', ok: true });
    expect(requests[0].headers['user-agent']).toBe(USER_AGENT);
    expect(requests[0].headers.accept).toBe('application/json');
  });

  test('getText returns the body as a string', async () => {
    await expect(getText(`${base}/text`)).resolves.toBe('abc123  sftp-1.30.0.vsix\n');
  });

  test('redirects are followed, relative ones against the answering URL', async () => {
    const response = await getBuffer(`${base}/redirect-relative`);

    expect(response.status).toBe(200);
    expect(response.url).toBe(`${base}/json`);
    expect(requests.map(request => request.url)).toEqual(['/redirect-relative', '/redirect-absolute', '/json']);
  });

  test('a redirect loop gives up after the limit', async () => {
    const error = await rejectionOf(getBuffer(`${base}/loop`, { maxRedirects: 3 }));

    expect(error.message).toBe(`too many redirects (3) from ${base}/loop`);
    expect(requests).toHaveLength(4);
  });

  test('a status outside 2xx rejects with the status and the first line of the body', async () => {
    const error = await rejectionOf(getJson(`${base}/missing`));

    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error.status).toBe(404);
    expect(error.message).toBe(`HTTP 404 from ${base}/missing: Not Found`);
  });

  test('a body that is not JSON rejects with the URL', async () => {
    const error = await rejectionOf(getJson(`${base}/invalid-json`));

    expect(error.message).toMatch(new RegExp(`^invalid JSON from ${base}/invalid-json: `));
  });

  test('a server that does not answer within the timeout rejects with ETIMEDOUT', async () => {
    const error = await rejectionOf(getBuffer(`${base}/slow`, { timeoutMs: 50 }));

    expect(error.code).toBe('ETIMEDOUT');
    expect(error.message).toBe(`timeout after 50 ms waiting for ${base}/slow`);
  });

  test('an unsupported protocol is refused before any request', async () => {
    const error = await rejectionOf(getBuffer('ftp://example.test/x'));

    expect(error.message).toBe('unsupported protocol in ftp://example.test/x');
    expect(requests).toHaveLength(0);
  });

  test('downloadToFile writes the body behind a redirect, reports progress and leaves no partial file', async () => {
    const progress: Array<[number, number | undefined]> = [];

    await downloadToFile(`${base}/file-redirect`, '/downloads/sftp.vsix', {
      onProgress: (received, total) => progress.push([received, total]),
    });

    expect(fs.readFileSync('/downloads/sftp.vsix')).toEqual(PAYLOAD);
    expect(fs.existsSync('/downloads/sftp.vsix.part')).toBe(false);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toEqual([PAYLOAD.length, PAYLOAD.length]);
  });

  test('a download cut short of its announced length fails and removes the partial file', async () => {
    const error = await rejectionOf(downloadToFile(`${base}/truncated`, '/downloads/cut.vsix'));

    // the socket error, the abort or the length check: whichever node raises
    // first, the outcome is a rejection and no file (a core error comes from
    // another realm, so it is not an instance of this one's Error)
    expect(typeof error.message).toBe('string');
    expect(fs.existsSync('/downloads/cut.vsix')).toBe(false);
    expect(fs.existsSync('/downloads/cut.vsix.part')).toBe(false);
  });

  test('a download answered with an error status fails without writing', async () => {
    const error = await rejectionOf(downloadToFile(`${base}/missing`, '/downloads/none.vsix'));

    expect(error).toBeInstanceOf(HttpStatusError);
    expect(fs.existsSync('/downloads/none.vsix')).toBe(false);
    expect(fs.existsSync('/downloads/none.vsix.part')).toBe(false);
  });
});
