import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * The little HTTP the extension needs: a GET that follows redirects, with a
 * timeout, returning a buffer, a text, a JSON document or a file on disk.
 *
 * Kept on the node core modules on purpose: the extension talks to GitHub
 * (the releases API and the asset store behind a redirect) a few times a day
 * at most, which does not justify a dependency in the bundle. Tests drive it
 * against a local `http` server: the protocol is picked from the URL.
 */

export interface HttpOptions {
  headers?: { [name: string]: string };
  /** ms without a response (or between chunks) before the request is dropped */
  timeoutMs?: number;
  /** how many redirects are followed before giving up */
  maxRedirects?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** the URL the response came from, after redirects */
  url: string;
}

export interface DownloadOptions extends HttpOptions {
  /** `total` is undefined when the server does not say the length */
  onProgress?: (received: number, total: number | undefined) => void;
}

export const DEFAULT_TIMEOUT_MS = 15 * 1000;
export const DEFAULT_MAX_REDIRECTS = 5;
// GitHub answers 403 to a request without a User-Agent
export const USER_AGENT = 'vscode-sftp (https://github.com/jalexiscv/vscode-sftp)';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A response with a status outside 2xx. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, body: Buffer) {
    super(`HTTP ${status} from ${url}${describeBody(body)}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.url = url;
  }
}

function describeBody(body: Buffer): string {
  const text = body.toString('utf8').trim();
  if (!text) {
    return '';
  }
  const line = text.split(/\r?\n/)[0];
  return `: ${line.length > 200 ? line.slice(0, 200) + '…' : line}`;
}

function requestOnce(url: string, options: HttpOptions): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (error) {
      reject(new Error(`invalid URL: ${url}`));
      return;
    }
    const isHttps = target.protocol === 'https:';
    if (!isHttps && target.protocol !== 'http:') {
      reject(new Error(`unsupported protocol in ${url}`));
      return;
    }
    const transport: typeof http = isHttps ? (https as any) : http;
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
      },
      response => resolve(response)
    );
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.abort();
      reject(Object.assign(new Error(`timeout after ${timeoutMs} ms waiting for ${url}`), { code: 'ETIMEDOUT' }));
    });
    request.end();
  });
}

/**
 * Opens a GET to `url`, following redirects (relative ones resolved against
 * the URL that answered). The caller consumes the response stream.
 */
export async function openStream(
  url: string,
  options: HttpOptions = {}
): Promise<{ response: http.IncomingMessage; url: string }> {
  const maxRedirects = options.maxRedirects === undefined ? DEFAULT_MAX_REDIRECTS : options.maxRedirects;
  let current = url;
  for (let redirects = 0; ; redirects += 1) {
    const response = await requestOnce(current, options);
    const status = response.statusCode || 0;
    const location = response.headers.location;
    if (!REDIRECT_STATUSES.has(status) || !location) {
      return { response, url: current };
    }
    // the body of a redirect is of no use; drop it so the socket is freed
    response.resume();
    if (redirects >= maxRedirects) {
      throw new Error(`too many redirects (${maxRedirects}) from ${url}`);
    }
    current = new URL(location, current).toString();
  }
}

function collect(response: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
    response.on('aborted', () => reject(new Error('response aborted')));
  });
}

/** GET `url` as a buffer; rejects with {@link HttpStatusError} outside 2xx. */
export async function getBuffer(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
  const { response, url: finalUrl } = await openStream(url, options);
  const body = await collect(response);
  const status = response.statusCode || 0;
  if (status < 200 || status >= 300) {
    throw new HttpStatusError(status, finalUrl, body);
  }
  return { status, headers: response.headers, body, url: finalUrl };
}

/** GET `url` as UTF-8 text. */
export async function getText(url: string, options: HttpOptions = {}): Promise<string> {
  const response = await getBuffer(url, options);
  return response.body.toString('utf8');
}

/** GET `url` and parse it as JSON. */
export async function getJson<T = any>(url: string, options: HttpOptions = {}): Promise<T> {
  const response = await getBuffer(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  const text = response.body.toString('utf8');
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`invalid JSON from ${response.url}: ${error.message}`);
  }
}

/**
 * GET `url` into `destination`. Written to `<destination>.part` and renamed
 * at the end, so a half-downloaded file never sits under the final name; the
 * partial file is removed on failure.
 */
export async function downloadToFile(
  url: string,
  destination: string,
  options: DownloadOptions = {}
): Promise<void> {
  const { response, url: finalUrl } = await openStream(url, options);
  const status = response.statusCode || 0;
  if (status < 200 || status >= 300) {
    throw new HttpStatusError(status, finalUrl, await collect(response));
  }
  const lengthHeader = response.headers['content-length'];
  const total = lengthHeader ? parseInt(String(lengthHeader), 10) || undefined : undefined;
  const partial = `${destination}.part`;
  let received = 0;

  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(partial);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      file.destroy();
      fs.unlink(partial, () => reject(error));
    };
    response.on('data', chunk => {
      received += chunk.length;
      if (options.onProgress) {
        options.onProgress(received, total);
      }
    });
    response.on('error', fail);
    response.on('aborted', () => fail(new Error(`download of ${url} aborted`)));
    file.on('error', fail);
    file.on('finish', () => {
      if (settled) {
        return;
      }
      if (total !== undefined && received !== total) {
        fail(new Error(`download of ${url} incomplete: ${received} of ${total} bytes`));
        return;
      }
      settled = true;
      resolve();
    });
    response.pipe(file);
  });

  await new Promise<void>((resolve, reject) =>
    fs.rename(partial, destination, error => (error ? reject(error) : resolve()))
  );
}
