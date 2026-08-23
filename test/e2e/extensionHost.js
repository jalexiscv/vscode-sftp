// Runs INSIDE the VS Code extension host (loaded through
// `--extensionTestsPath`). It drives the real extension with the VS Code API,
// asks the runner (through the control channel) to act as an external program
// — editing workspace files, injecting server faults, reporting the SFTP
// server's request log — and checks the observable outcome: files on the
// server, the extension's output channel, `activity-log.json` and the
// `sync-index/*.json` files under the workspace storage.
//
// Every scenario records PASS / FAIL / SKIP with evidence; the results are
// written to SFTP_E2E_RESULT_FILE so the runner can assemble the report.
//
// Contract with the runner: see runner.js (environment variables SFTP_E2E_*).
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { connectControl } = require('./control');

const env = process.env;
const SESSION = env.SFTP_E2E_SESSION || 'fresh';
const EXT_ID = env.SFTP_E2E_EXTENSION_ID || 'jalexiscv.sftp';
const WORKSPACE = env.SFTP_E2E_WORKSPACE;
const USER_DATA_DIR = env.SFTP_E2E_USER_DATA_DIR;
const RESULT_FILE = env.SFTP_E2E_RESULT_FILE;
const SERVICE_NAME = env.SFTP_E2E_SERVICE_NAME || 'e2e-local';
const CONTROL_PORT = Number(env.SFTP_E2E_CONTROL_PORT || 0);
const REMOTE_BASE = env.SFTP_E2E_REMOTE_BASE || '/';
const FIXTURES = env.SFTP_E2E_FIXTURES ? JSON.parse(env.SFTP_E2E_FIXTURES) : {};

// hard ceilings: a scenario that hangs must not hang the whole run
const SCENARIO_TIMEOUT_MS = 150 * 1000;

const results = [];
const hostLog = [];
let control = null;
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// small utilities

class SkipError extends Error {}

function now() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:` +
    `${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(message) {
  const line = `[e2e-host ${now()}] ${message}`;
  console.log(line);
  hostLog.push(line);
  if (control) {
    control.call('log', { message: line }).catch(() => undefined);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

/**
 * Polls `probe` (sync or async) until it returns a truthy value. Rejects with
 * the last value after `timeout` ms.
 */
async function waitFor(probe, what, timeout = 30000, interval = 250) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
    } catch (error) {
      last = `probe threw: ${error.message}`;
    }
    if (last) {
      return last;
    }
    await sleep(interval);
  }
  throw new Error(`timed out after ${timeout} ms waiting for ${what}; last value: ${JSON.stringify(last)}`);
}

function withTimeout(promise, ms, what) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms} ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function listFilesRecursive(dir, predicate, acc = []) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return acc;
  }
  names.forEach(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(full, predicate, acc);
    } else if (entry.isFile() && predicate(full)) {
      acc.push(full);
    }
  });
  return acc;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

function localPath(rel) {
  return path.join(WORKSPACE, ...rel.split('/'));
}

function localContent(rel) {
  return fs.readFileSync(localPath(rel));
}

function remotePathOf(rel) {
  return path.posix.join(REMOTE_BASE, rel);
}

function sameFile(a, b) {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

// ---------------------------------------------------------------------------
// evidence sources: output channel, storage files, server

/** The newest VS Code log session directory of this user-data-dir. */
function currentLogsDir() {
  const logsRoot = path.join(USER_DATA_DIR, 'logs');
  let sessions;
  try {
    sessions = fs.readdirSync(logsRoot).filter(name => {
      try {
        return fs.statSync(path.join(logsRoot, name)).isDirectory();
      } catch (error) {
        return false;
      }
    });
  } catch (error) {
    return null;
  }
  if (sessions.length === 0) {
    return null;
  }
  // names are timestamps (YYYYMMDDTHHMMSS); the newest is ours
  sessions.sort();
  return path.join(logsRoot, sessions[sessions.length - 1]);
}

/** Files backing the extension's "sftp" output channel in the current session. */
function sftpOutputLogFiles() {
  const dir = currentLogsDir();
  if (!dir) {
    return [];
  }
  return listFilesRecursive(dir, file => /(^|[\\/])\d+-sftp\.log$/i.test(file) ||
    /output_logging[\\/].*sftp\.log$/i.test(file));
}

function extHostLogFile() {
  const dir = currentLogsDir();
  if (!dir) {
    return null;
  }
  const found = listFilesRecursive(dir, file => /[\\/]exthost\.log$/i.test(file));
  return found.length > 0 ? found[0] : null;
}

function sftpLogText() {
  return sftpOutputLogFiles()
    .map(file => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch (error) {
        return '';
      }
    })
    .join('\n');
}

function sftpLogLines() {
  return sftpLogText().split(/\r?\n/).filter(line => line.length > 0);
}

/** A cursor into the output log, so a scenario can look only at what it caused. */
function logMark() {
  return sftpLogLines().length;
}

function logSince(mark) {
  return sftpLogLines().slice(mark);
}

function extHostLogLines() {
  const file = extHostLogFile();
  if (!file) {
    return [];
  }
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (error) {
    return [];
  }
}

/**
 * The extension's storage directory (`context.storageUri`) for the current
 * workspace folder: `<user-data-dir>/User/workspaceStorage/<id>/<extension id>`.
 *
 * The folder id is opaque, so the folder is recognised by what VS Code leaves
 * next to it — `workspace.json` (`{ folder }`, older versions) or `meta.json`
 * (`{ name }`, the folder's basename, newer versions) — or, failing that, by
 * the local paths in the extension's own activity log.
 */
let storageDirCache = null;

function storageDir() {
  if (storageDirCache && fs.existsSync(storageDirCache)) {
    return storageDirCache;
  }
  const root = path.join(USER_DATA_DIR, 'User', 'workspaceStorage');
  let ids;
  try {
    ids = fs.readdirSync(root).filter(name => fs.statSync(path.join(root, name)).isDirectory());
  } catch (error) {
    return null;
  }
  const wantedUri = vscode.Uri.file(WORKSPACE).toString().toLowerCase().replace(/\/$/, '');
  const wantedName = path.basename(WORKSPACE);
  const wantedPrefix = path.normalize(WORKSPACE).toLowerCase();

  const matches = ids.filter(id => {
    const legacy = readJsonSafe(path.join(root, id, 'workspace.json'));
    if (legacy && legacy.folder) {
      return String(legacy.folder).toLowerCase().replace(/\/$/, '') === wantedUri;
    }
    const meta = readJsonSafe(path.join(root, id, 'meta.json'));
    if (meta && meta.name) {
      return meta.name === wantedName;
    }
    return false;
  });
  let chosen = matches.length === 1 ? matches[0] : null;

  if (!chosen) {
    // the activity log names local paths: the one under this workspace wins
    const byActivity = ids.filter(id => {
      const data = readJsonSafe(path.join(root, id, EXT_ID, 'activity-log.json'));
      return data && Array.isArray(data.entries) && data.entries.some(
        entry => entry.localPath && path.normalize(entry.localPath).toLowerCase().startsWith(wantedPrefix + path.sep)
      );
    });
    if (byActivity.length === 1) {
      chosen = byActivity[0];
    }
  }
  if (!chosen && ids.length === 1) {
    chosen = ids[0];
  }
  if (!chosen) {
    return null;
  }
  storageDirCache = path.join(root, chosen, EXT_ID);
  return storageDirCache;
}

function readActivityLog() {
  const dir = storageDir();
  if (!dir) {
    return [];
  }
  const data = readJsonSafe(path.join(dir, 'activity-log.json'));
  return data && Array.isArray(data.entries) ? data.entries : [];
}

/** All sync-index entries of the current workspace, keyed by relative path (folded). */
function readSyncIndex() {
  const dir = storageDir();
  const merged = {};
  if (!dir) {
    return merged;
  }
  const indexDir = path.join(dir, 'sync-index');
  let files;
  try {
    files = fs.readdirSync(indexDir).filter(name => /\.json$/.test(name));
  } catch (error) {
    return merged;
  }
  files.forEach(name => {
    const data = readJsonSafe(path.join(indexDir, name));
    if (data && data.entries) {
      Object.keys(data.entries).forEach(rel => {
        merged[rel.toLowerCase()] = Object.assign({ _file: name, _rel: rel }, data.entries[rel]);
      });
    }
  });
  return merged;
}

function indexEntry(rel) {
  return readSyncIndex()[rel.toLowerCase()];
}

function activityEntriesFor(rel) {
  const wanted = localPath(rel);
  return readActivityLog().filter(entry => entry.localPath && sameFile(entry.localPath, wanted));
}

async function serverTree(withContent) {
  return control.call('serverTree', { withContent: Boolean(withContent) });
}

async function serverFile(rel) {
  const tree = await serverTree(true);
  const remote = remotePathOf(rel).replace(/^\//, '');
  const entry = tree[remote];
  if (!entry) {
    return null;
  }
  return { size: entry.size, content: entry.content !== undefined ? Buffer.from(entry.content, 'base64') : null };
}

async function serverHas(rel, expectedBuffer) {
  const entry = await serverFile(rel);
  if (!entry) {
    return false;
  }
  if (expectedBuffer === undefined) {
    return true;
  }
  if (entry.content === null) {
    return entry.size === expectedBuffer.length;
  }
  return entry.content.equals(expectedBuffer);
}

async function opsCursor() {
  const reply = await control.call('serverOps', { since: 0, onlyCount: true });
  return reply.nextIndex;
}

async function opsSince(cursor) {
  const reply = await control.call('serverOps', { since: cursor });
  return reply.ops;
}

function describeOps(ops) {
  return ops.map(op => {
    const extra = Object.keys(op)
      .filter(key => ['op', 'path', 't'].indexOf(key) === -1)
      .map(key => `${key}=${JSON.stringify(op[key])}`)
      .join(' ');
    return `${op.op} ${op.path}${extra ? ' ' + extra : ''}`;
  });
}

// ---------------------------------------------------------------------------
// VS Code interaction helpers

async function activateExtension() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert(ext, `extension ${EXT_ID} is installed in the development host`);
  if (!ext.isActive) {
    await ext.activate();
  }
  return ext;
}

/** Accepts the currently selected QuickPick item after a short delay (twice, to be safe). */
function acceptQuickPickSoon(delay = 900) {
  const accept = () =>
    vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem').then(undefined, () => undefined);
  setTimeout(accept, delay);
  setTimeout(accept, delay + 1500);
}

async function openAndSave(rel, textToPrepend) {
  const uri = vscode.Uri.file(localPath(rel));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(0, 0), textToPrepend);
  const applied = await vscode.workspace.applyEdit(edit);
  assert(applied, `workspace edit applied to ${rel}`);
  const saved = await doc.save();
  assert(saved, `document ${rel} saved`);
  return doc;
}

function errorLines(lines) {
  return lines.filter(line => /\[(error|critical)\]/.test(line));
}

// ---------------------------------------------------------------------------
// scenario bookkeeping

async function scenario(id, title, fn) {
  const entry = { id, title, status: 'PASS', evidence: [], error: null, startedAt: Date.now() };
  const evidence = (label, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
    entry.evidence.push({ label, value: text.length > 6000 ? text.slice(0, 6000) + '\n…(truncated)' : text });
  };
  log(`--- ${id} ${title} ---`);
  try {
    await withTimeout(fn(evidence), SCENARIO_TIMEOUT_MS, `scenario ${id}`);
    log(`${id} PASS`);
  } catch (error) {
    if (error instanceof SkipError) {
      entry.status = 'SKIP';
      entry.error = error.message;
      log(`${id} SKIP: ${error.message}`);
    } else {
      entry.status = 'FAIL';
      entry.error = error && error.stack ? error.stack : String(error);
      log(`${id} FAIL: ${error && error.message ? error.message : error}`);
      // whatever the log says at the moment of failure is part of the evidence
      evidence('sftp output channel (last 60 lines at failure)', sftpLogLines().slice(-60).join('\n'));
    }
  }
  entry.finishedAt = Date.now();
  results.push(entry);
  writeResults(false);
}

/** An informational entry: evidence without a verdict (never PASS/FAIL). */
async function note(id, title, fn) {
  const entry = { id, title, status: 'INFO', evidence: [], error: null, startedAt: Date.now() };
  const evidence = (label, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
    entry.evidence.push({ label, value: text.length > 6000 ? text.slice(0, 6000) + '\n…(truncated)' : text });
  };
  try {
    await withTimeout(fn(evidence), 30000, `note ${id}`);
  } catch (error) {
    entry.error = error && error.message ? error.message : String(error);
  }
  entry.finishedAt = Date.now();
  results.push(entry);
  writeResults(false);
}

function writeResults(final) {
  if (!RESULT_FILE) {
    return;
  }
  const payload = {
    session: SESSION,
    workspace: WORKSPACE,
    startedAt,
    finishedAt: final ? Date.now() : undefined,
    complete: Boolean(final),
    scenarios: results,
    hostLog: hostLog.slice(-400),
    sftpOutputLogFiles: sftpOutputLogFiles(),
    storageDir: storageDir(),
  };
  try {
    fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error(`[e2e-host] cannot write results: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// shared scenario steps

async function waitForStartupScanLine(evidence, timeout = 60000) {
  const line = await waitFor(
    () => sftpLogLines().find(l => l.includes('[scan]') && l.includes(`${SERVICE_NAME}:`)),
    'the startup scan to report in the output channel',
    timeout
  );
  evidence('startup scan line', line);
  return line;
}

// ---------------------------------------------------------------------------
// SESSION "fresh": clean storage, clean server (except seeds)

async function sessionFresh() {
  const seeded = FIXTURES.seededIdentical || [];
  const seededDiffer = FIXTURES.seededDiffer || [];
  const serverOnly = FIXTURES.serverOnly || [];
  const allLocal = FIXTURES.uploadable || [];

  await scenario('S1', 'Activation with .vscode/sftp.json present, no errors', async evidence => {
    const ext = await activateExtension();
    assert(ext.isActive, 'extension is active');
    evidence('extension', `${ext.id} v${ext.packageJSON.version}, isActive=${ext.isActive}, path=${ext.extensionPath}`);

    const commands = await vscode.commands.getCommands(true);
    const required = [
      'sftp.upload.file', 'sftp.upload.folder', 'sftp.upload.project', 'sftp.scanExternalChanges',
      'sftp.rebuildSyncIndex', 'sftp.plan.preview', 'sftp.plan.uploadAll', 'sftp.plan.exportReport',
      'sftp.pauseAutoSync', 'sftp.resumeAutoSync',
    ];
    const missing = required.filter(command => commands.indexOf(command) === -1);
    assert(missing.length === 0, `all commands registered (missing: ${missing.join(', ')})`);
    evidence('commands registered', required.join(', '));

    const configLine = await waitFor(
      () => sftpLogLines().find(line => line.includes('config at ')),
      'the "config at" line in the sftp output channel (channel log file)',
      30000
    );
    evidence('sftp output log files', sftpOutputLogFiles().join('\n'));
    evidence('config line', configLine);
    // a connection is opened at activation (trash purge); give it a moment
    await sleep(2000);
    const errors = errorLines(sftpLogLines());
    evidence('[error]/[critical] lines so far', errors.join('\n') || '(none)');
    assert(errors.length === 0, 'no [error]/[critical] lines in the output channel after activation');

    const hostErrors = extHostLogLines().filter(line => /\[error\]/i.test(line) && line.includes('sftp'));
    evidence('exthost.log lines mentioning sftp with [error]', hostErrors.join('\n') || '(none)');
    assert(hostErrors.length === 0, 'exthost.log has no [error] lines mentioning the extension');
  });

  await scenario('S7', 'First use: empty index -> startup scan uploads nothing; Rebuild Sync Index seeds it', async evidence => {
    const emptyLine = await waitFor(
      () => sftpLogLines().find(l => l.includes('[scan]') && l.includes('sync index is empty')),
      '"the sync index is empty" startup scan line',
      60000
    );
    evidence('startup scan line', emptyLine);
    await sleep(1500);
    const tree = await serverTree(false);
    const expected = [].concat(seeded, seededDiffer, serverOnly).map(rel => remotePathOf(rel).replace(/^\//, '')).sort();
    const actual = Object.keys(tree).sort();
    evidence('server tree after startup (seeds only expected)', actual.join('\n'));
    assertEqual(actual.join('|'), expected.join('|'), 'the startup scan with an empty index uploaded nothing');
    assert(errorLines(sftpLogLines()).length === 0, 'no [error] lines after the startup scan');

    const mark = logMark();
    vscode.commands.executeCommand('sftp.rebuildSyncIndex').then(undefined, error => log(`rebuild command rejected: ${error.message}`));
    const summaryLine = await waitFor(
      () => logSince(mark).find(l => /\[rebuild-index\] .*: \d+ indexed, \d+ differ/.test(l)),
      '[rebuild-index] summary line',
      60000
    );
    evidence('rebuild summary', summaryLine);
    const match = summaryLine.match(/(\d+) indexed, (\d+) differ, (\d+) only local, (\d+) only remote/);
    assert(match, 'summary line parses');
    assertEqual(Number(match[1]), seeded.length, 'files identical on both sides were indexed');
    assertEqual(Number(match[2]), seededDiffer.length, 'files that differ were left out');
    assertEqual(Number(match[4]), serverOnly.length, 'server-only files counted');
    const onlyLocalExpected = allLocal.length - seeded.length - seededDiffer.length;
    assertEqual(Number(match[3]), onlyLocalExpected, 'local-only files counted');

    const index = await waitFor(() => {
      const entries = readSyncIndex();
      return Object.keys(entries).length === seeded.length ? entries : null;
    }, `sync index file with ${seeded.length} entries`, 15000);
    seeded.forEach(rel => {
      const entry = index[rel.toLowerCase()];
      assert(entry && entry.status === 'verified', `${rel} indexed as verified`);
      assertEqual(entry.size, localContent(rel).length, `${rel} indexed size`);
    });
    evidence('sync-index entries after rebuild', index);
  });

  await scenario('S2', 'Upload Project: every file reaches the server, is verified, indexed and logged', async evidence => {
    const mark = logMark();
    const cursor = await opsCursor();
    acceptQuickPickSoon(900); // "Select a folder..." of Upload Project (the only service)
    await withTimeout(vscode.commands.executeCommand('sftp.upload.project'), 90000, 'sftp.upload.project');

    await waitFor(async () => {
      for (const rel of allLocal) {
        if (!(await serverHas(rel, localContent(rel)))) {
          return false;
        }
      }
      return true;
    }, 'every uploadable file to be on the server with the local content', 60000, 500);
    const tree = await serverTree(false);
    evidence('server tree after Upload Project', Object.keys(tree).sort().map(k => `${k} (${tree[k].size} B)`).join('\n'));
    const ignoredOnServer = Object.keys(tree).filter(k => k.startsWith('ignored-dir/') || k.startsWith('.vscode/'));
    assertEqual(ignoredOnServer.length, 0, 'ignored paths never uploaded');

    const activity = await waitFor(() => {
      const entries = readActivityLog();
      const ok = allLocal.every(rel => activityEntriesFor(rel).some(e => e.kind === 'upload' && e.status === 'success'));
      return ok ? entries : null;
    }, 'activity-log.json with a success upload entry per file', 20000);
    evidence('activity-log.json upload entries', activity.filter(e => e.kind === 'upload').map(e => `${e.status} ${e.localPath} -> ${e.remotePath}${e.error ? ' ' + e.error : ''}`).join('\n'));
    assertEqual(activity.filter(e => e.kind === 'upload' && e.status === 'failed').length, 0, 'no failed upload entries');

    const index = await waitFor(() => {
      const entries = readSyncIndex();
      return allLocal.every(rel => entries[rel.toLowerCase()] && entries[rel.toLowerCase()].status === 'verified') ? entries : null;
    }, 'sync index with a verified entry per uploaded file', 20000);
    allLocal.forEach(rel => assertEqual(index[rel.toLowerCase()].size, localContent(rel).length, `${rel} index size`));
    evidence('sync-index entries', index);

    const ops = await opsSince(cursor);
    const verifications = ops.filter(op => (op.op === 'LSTAT' || op.op === 'STAT') && op.ok && allLocal.some(rel => remotePathOf(rel) === op.path));
    evidence('server requests (uploads + verification stats)', describeOps(ops.filter(op => op.op !== 'AUTH')).join('\n'));
    assert(verifications.length >= allLocal.length, `a post-upload stat per file (${verifications.length} stats for ${allLocal.length} files)`);
    const doneLines = logSince(mark).filter(l => l.includes('local ➞ remote'));
    evidence('output channel transfer lines', doneLines.join('\n'));
  });

  await scenario('S3', 'Verification failure: truncating server -> 3 attempts, failed in activity log and index', async evidence => {
    const rel = FIXTURES.failFile;
    const remote = remotePathOf(rel);
    await control.call('setFault', { truncate: [remote] });
    const mark = logMark();
    const cursor = await opsCursor();
    const before = activityEntriesFor(rel).length;
    await withTimeout(vscode.commands.executeCommand('sftp.upload.file', vscode.Uri.file(localPath(rel))), 60000, 'sftp.upload.file');

    const failed = await waitFor(() => {
      const entries = activityEntriesFor(rel);
      return entries.length > before && entries[0].status === 'failed' ? entries[0] : null;
    }, 'a failed upload entry in activity-log.json', 20000);
    evidence('activity entry', failed);
    assert(/size mismatch/.test(failed.error || ''), `activity error names the size mismatch (got: ${failed.error})`);
    assert(/remote 0/.test(failed.error || ''), 'remote size reported as 0');

    const retries = logSince(mark).filter(l => l.includes('[transfer] retry') && l.toLowerCase().includes(path.basename(rel).toLowerCase()));
    evidence('retry lines', retries.join('\n'));
    assert(retries.some(l => l.includes('retry 1/2')) && retries.some(l => l.includes('retry 2/2')), 'two retries logged (three attempts)');

    const ops = await opsSince(cursor);
    const writeOpens = ops.filter(op => op.op === 'OPEN' && op.write && op.path === remote);
    evidence('server requests for the file', describeOps(ops.filter(op => op.path === remote)).join('\n'));
    assertEqual(writeOpens.length, 3, 'three upload attempts reached the server');

    const entry = await waitFor(() => {
      const found = indexEntry(rel);
      return found && found.status === 'failed' ? found : null;
    }, 'sync index entry marked failed', 15000);
    evidence('sync-index entry', entry);
    const onServer = await serverFile(rel);
    evidence('server file size', onServer ? onServer.size : 'missing');
    assertEqual(onServer && onServer.size, 0, 'the server holds the truncated (empty) file');

    // recovery: the fault is lifted and the failure is retried from the
    // Activity view ("Retry All Failed Operations"), i.e. through the retry
    // thunk the transfer hook attached to the failed entry
    await control.call('setFault', { truncate: [] });
    const retryMark = logMark();
    vscode.commands.executeCommand('sftp.activity.retryAllFailed').then(undefined, error => log(`retryAllFailed rejected: ${error.message}`));
    await waitFor(async () => (await serverHas(rel, localContent(rel))) && indexEntry(rel) && indexEntry(rel).status === 'verified',
      'recovery upload (Retry All Failed) verified and indexed', 30000);
    evidence('sync-index entry after recovery', indexEntry(rel));
    const recovered = await waitFor(() => {
      const entries = activityEntriesFor(rel);
      return entries.length > before + 1 && entries[0].status === 'success' ? entries[0] : null;
    }, 'a success entry for the retried upload', 15000);
    evidence('activity entry of the retry', recovered);
    evidence('output channel during the retry', logSince(retryMark).filter(l => /\[(info|warn|error)\]/.test(l)).join('\n'));
  });

  await scenario('S4', 'External changes with VS Code open (watcher.autoUpload): modified + batch of new files upload, ignored ones do not', async evidence => {
    const mark = logMark();
    const cursor = await opsCursor();
    const modified = { rel: 'src/app.js', content: `console.log('v2 written by an external process at ${Date.now()}');\n` };
    const batch = [1, 2, 3, 4, 5].map(n => ({ rel: `batch/file-${n}.txt`, content: `batch file ${n} ${Date.now()}\n` }));
    const ignored = [
      { rel: 'ignored-dir/secret.txt', content: 'must not be uploaded\n' },
      { rel: 'notes/skip.ignored', content: 'must not be uploaded either\n' },
    ];
    await control.call('writeWorkspaceFiles', { files: [modified].concat(batch, ignored) });
    evidence('files written externally', [modified].concat(batch, ignored).map(f => f.rel).join(', '));

    await waitFor(async () => {
      for (const file of [modified].concat(batch)) {
        if (!(await serverHas(file.rel, Buffer.from(file.content)))) {
          return false;
        }
      }
      return true;
    }, 'the modified file and the 5 new files on the server', 45000, 500);
    await sleep(3000);
    const tree = await serverTree(false);
    ignored.forEach(file => assert(!tree[remotePathOf(file.rel).replace(/^\//, '')], `${file.rel} not uploaded (ignored)`));
    evidence('server tree', Object.keys(tree).sort().join('\n'));

    const lines = logSince(mark);
    const planLines = lines.filter(l => /\[change-collector\] plan .* from watcher/.test(l));
    evidence('collector plan lines', planLines.join('\n'));
    assert(planLines.length >= 1, 'the watcher batch became an upload plan');
    const summaryLines = lines.filter(l => /\[plan [^\]]+\] \d+ verified, \d+ failed/.test(l));
    evidence('plan summary lines', summaryLines.join('\n'));
    const verified = summaryLines.reduce((sum, l) => sum + Number(l.match(/(\d+) verified/)[1]), 0);
    const failed = summaryLines.reduce((sum, l) => sum + Number(l.match(/(\d+) failed/)[1]), 0);
    assert(verified >= 6, `6 files verified across the watcher plans (got ${verified})`);
    assertEqual(failed, 0, 'no failed items');
    evidence('ignored-by-config lines', lines.filter(l => l.includes('ignored by config')).join('\n') || '(none: ignored paths are filtered before logging at info level)');

    await waitFor(() => [modified].concat(batch).every(f => {
      const entry = indexEntry(f.rel);
      return entry && entry.status === 'verified' && entry.size === Buffer.byteLength(f.content);
    }), 'sync index verified entries for the external changes', 20000);
    evidence('sync-index entries', [modified].concat(batch).map(f => `${f.rel}: ${JSON.stringify(indexEntry(f.rel))}`).join('\n'));
    const ops = await opsSince(cursor);
    evidence('server write opens', describeOps(ops.filter(op => op.op === 'OPEN' && op.write)).join('\n'));
  });

  await scenario('S5', 'Save from the editor with the watcher on = exactly one upload', async evidence => {
    const rel = 'src/app.js';
    const remote = remotePathOf(rel);
    const mark = logMark();
    const cursor = await opsCursor();
    const t0 = Date.now();
    const before = activityEntriesFor(rel).length;
    const marker = `// saved in VS Code at ${t0}\n`;
    await openAndSave(rel, marker);
    await waitFor(async () => {
      const entry = await serverFile(rel);
      return entry && entry.content && entry.content.toString('utf8').startsWith(marker);
    }, 'the saved content on the server', 30000);
    // leave time for a second upload to show up if one were coming
    await sleep(4000);

    const ops = await opsSince(cursor);
    const writeOpens = ops.filter(op => op.op === 'OPEN' && op.write && op.path === remote);
    evidence('server requests for the file since the save', describeOps(ops.filter(op => op.path === remote)).join('\n'));
    assertEqual(writeOpens.length, 1, 'exactly one upload of the saved file reached the server');

    const entries = activityEntriesFor(rel).filter(e => e.startedAt >= t0 - 100);
    evidence('activity entries for the file since the save', entries);
    assertEqual(entries.length, 1, 'exactly one activity entry for the save');
    assertEqual(entries[0].status, 'success', 'the entry is a success');
    assert(activityEntriesFor(rel).length === before + 1, 'activity log grew by one');

    const lines = logSince(mark).filter(l => l.toLowerCase().includes('app.js'));
    evidence('output channel lines mentioning the file', lines.join('\n'));
    assert(lines.some(l => l.includes('[file-save]')), 'the save was seen by uploadOnSave');
  });

  await scenario('S8', 'Preview Upload (dry run) changes nothing; Upload Plan uploads and verifies; resume scan is up to date', async evidence => {
    const rel = 'docs/guide.md';
    const content = `# guide\n\nedited externally while auto sync was paused (${Date.now()})\n`;
    await vscode.commands.executeCommand('sftp.pauseAutoSync');
    await sleep(500);
    const mark = logMark();
    const cursor = await opsCursor();
    await control.call('writeWorkspaceFiles', { files: [{ rel, content }] });
    await sleep(3500);
    assert(!(await serverHas(rel, Buffer.from(content))), 'paused: the external edit was not uploaded by the watcher');
    evidence('collector lines while paused', logSince(mark).filter(l => l.includes('change-collector')).join('\n'));

    const previewCursor = await opsCursor();
    vscode.commands.executeCommand('sftp.plan.preview').then(undefined, error => log(`preview rejected: ${error.message}`));
    acceptQuickPickSoon(900); // scope: "Project"
    const previewLine = await waitFor(
      () => logSince(mark).find(l => /\[plan-preview\] .*: \d+ file\(s\) scanned, \d+ to upload/.test(l)),
      '[plan-preview] summary line',
      45000
    );
    evidence('preview line', previewLine);
    assertEqual(Number(previewLine.match(/(\d+) to upload/)[1]), 1, 'exactly the paused edit is planned');
    await sleep(1500);
    const previewOps = await opsSince(previewCursor);
    evidence('server requests during the preview', describeOps(previewOps).join('\n') || '(none)');
    assertEqual(previewOps.filter(op => op.op === 'OPEN' && op.write).length, 0, 'the dry run wrote nothing on the server');
    assert(!(await serverHas(rel, Buffer.from(content))), 'server content unchanged after the preview');

    // the report of the plan, as a user would export it
    vscode.commands.executeCommand('sftp.plan.exportReport').then(undefined, error => log(`export rejected: ${error.message}`));
    acceptQuickPickSoon(900); // newest plan first = the preview plan
    const report = await waitFor(() => {
      const doc = vscode.workspace.textDocuments.find(d => d.isUntitled && d.languageId === 'markdown' && d.getText().includes('guide.md'));
      return doc ? doc.getText() : null;
    }, 'the exported Markdown report', 20000).catch(error => `(report not captured: ${error.message})`);
    evidence('exported report (before running the plan)', report.split('\n').slice(0, 40).join('\n'));

    const runCursor = await opsCursor();
    vscode.commands.executeCommand('sftp.plan.uploadAll').then(undefined, error => log(`uploadAll rejected: ${error.message}`));
    acceptQuickPickSoon(900); // newest plan first
    const uploadingLine = await waitFor(
      () => logSince(mark).find(l => /\[plan [^\]]+\] uploading 1 file\(s\)/.test(l)),
      'plan run start line',
      45000
    );
    const planId = uploadingLine.match(/\[plan ([^\]]+)\]/)[1];
    const summaryLine = await waitFor(
      () => logSince(mark).find(l => l.includes(`[plan ${planId}]`) && /\d+ verified, \d+ failed/.test(l)),
      'plan summary line',
      45000
    );
    evidence('plan run lines', [uploadingLine, summaryLine].join('\n'));
    assert(/ 1 verified, 0 failed/.test(summaryLine), 'the plan verified its item');
    await waitFor(() => serverHas(rel, Buffer.from(content)), 'the plan upload on the server', 20000);
    await waitFor(() => {
      const entry = indexEntry(rel);
      return entry && entry.status === 'verified' && entry.size === Buffer.byteLength(content);
    }, 'index entry verified after the plan', 15000);
    evidence('index entry', indexEntry(rel));
    evidence('server requests of the plan run', describeOps(await opsSince(runCursor)).join('\n'));

    const resumeMark = logMark();
    await vscode.commands.executeCommand('sftp.resumeAutoSync');
    const resumeLine = await waitFor(
      () => logSince(resumeMark).find(l => l.includes('[scan]') && l.includes('up to date')),
      'the resume scan to report up to date',
      45000
    );
    evidence('resume scan line', resumeLine);
  });

  await note('S1b', 'exthost.log [error] lines over the whole session (informational)', async evidence => {
    const lines = extHostLogLines().filter(line => /\[error\]/i.test(line));
    evidence('count', String(lines.length));
    evidence('lines', lines.map(l => l.slice(0, 300)).join('\n') || '(none)');
    const knownRefresh = lines.filter(l => l.includes("Can't find config for remote resource"));
    evidence('of which "Can\'t find config for remote resource" (remote explorer refresh after an upload while the view was never opened; src/modules/remoteExplorer/treeDataProvider.ts:140/196 via src/fileHandlers/shared.ts refreshRemoteExplorer)', String(knownRefresh.length));
    evidence('[error]/[critical] lines in the sftp output channel over the session', errorLines(sftpLogLines()).join('\n') || '(none)');
  });

  // let the debounced writers (activity log, sync index) land before the host exits
  await sleep(3000);
}

// ---------------------------------------------------------------------------
// SESSION "reconcile": files were edited while VS Code was closed

async function sessionReconcile() {
  const offline = FIXTURES.offlineEdits || [];

  await scenario('S6', 'Startup scan uploads the files edited while VS Code was closed; a manual scan afterwards uploads nothing', async evidence => {
    await activateExtension();
    const cursor0 = await opsCursor();
    const changedLine = await waitFor(
      () => sftpLogLines().find(l => l.includes('[scan]') && l.includes(`${SERVICE_NAME}:`) && /file\(s\) changed since their last verified upload/.test(l)),
      'the startup scan to find the offline edits',
      60000
    );
    evidence('startup scan line', changedLine);
    assertEqual(Number(changedLine.match(/: (\d+) file\(s\) changed/)[1]), offline.length, 'every offline edit was detected');
    const summaryLine = await waitFor(
      () => sftpLogLines().find(l => /\[plan [^\]]+\] \d+ verified, \d+ failed/.test(l)),
      'the startup plan summary',
      60000
    );
    evidence('plan summary line', summaryLine);
    assert(summaryLine.includes(`${offline.length} verified, 0 failed`), 'every offline edit uploaded and verified');

    await waitFor(async () => {
      for (const file of offline) {
        if (!(await serverHas(file.rel, localContent(file.rel)))) {
          return false;
        }
      }
      return true;
    }, 'offline edits on the server', 30000, 500);
    await waitFor(() => offline.every(f => {
      const entry = indexEntry(f.rel);
      return entry && entry.status === 'verified' && entry.size === localContent(f.rel).length;
    }), 'index entries for the offline edits', 20000);
    evidence('index entries', offline.map(f => `${f.rel}: ${JSON.stringify(indexEntry(f.rel))}`).join('\n'));
    evidence('server requests at startup', describeOps((await opsSince(cursor0)).filter(op => op.op !== 'AUTH')).join('\n'));

    const activity = readActivityLog();
    evidence('activity-log.json reloaded from the previous session (count by status)', JSON.stringify(
      activity.reduce((acc, e) => { acc[`${e.kind}/${e.status}`] = (acc[`${e.kind}/${e.status}`] || 0) + 1; return acc; }, {})));

    // a manual scan of an up-to-date tree must upload nothing
    const mark = logMark();
    const cursor = await opsCursor();
    vscode.commands.executeCommand('sftp.scanExternalChanges').then(undefined, error => log(`scan rejected: ${error.message}`));
    const upToDate = await waitFor(
      () => logSince(mark).find(l => l.includes('[scan]') && l.includes('up to date')),
      'the manual scan to report up to date',
      45000
    );
    evidence('manual scan line', upToDate);
    await sleep(2000);
    const ops = await opsSince(cursor);
    evidence('server requests during the manual scan', describeOps(ops).join('\n') || '(none)');
    assertEqual(ops.filter(op => op.op === 'OPEN' && op.write).length, 0, 'the manual scan uploaded nothing');
  });

  await sleep(3000);
}

// ---------------------------------------------------------------------------
// SESSION "drain": save and close the window at once

async function sessionDrain() {
  await scenario('S9-host', 'Save a file and close the window immediately (the runner checks the server after exit)', async evidence => {
    await activateExtension();
    const scanLine = await waitForStartupScanLine(evidence, 60000);
    assert(scanLine, 'startup scan reported');
    const rel = FIXTURES.drainFile;
    const marker = `drained at ${Date.now()}\n`;
    const mark = logMark();
    await openAndSave(rel, marker);
    const expected = fs.readFileSync(localPath(rel), 'utf8');
    evidence('expected content (local after save)', expected);
    evidence('saved at', String(Date.now()));
    // hand the expectation to the runner before the window goes away
    results.push({ id: 'S9-expect', title: 'drain expectation', status: 'INFO', evidence: [{ label: 'expected', value: expected }, { label: 'rel', value: rel }], error: null });
    writeResults(false);
    evidence('output channel right before closing', logSince(mark).join('\n'));
    log('closing the window right after the save');
    vscode.commands.executeCommand('workbench.action.closeWindow').then(undefined, () => undefined);
    // if the window is still here in 20 s the close did not happen; report and fall through
    await sleep(20000);
    evidence('note', 'the window did not close within 20 s of workbench.action.closeWindow');
  });
}

// ---------------------------------------------------------------------------
// SESSION "hash": verifyUpload "hash" against a server without shell, useTempFile

async function sessionHash() {
  const files = FIXTURES.uploadable || [];

  await scenario('S10', 'verifyUpload "hash" degrades to stat (no shell), useTempFile uploads through .new + rename', async evidence => {
    await activateExtension();
    await waitFor(() => sftpLogLines().find(l => l.includes('config at ')), 'config line', 30000);
    const emptyLine = await waitFor(
      () => sftpLogLines().find(l => l.includes('[scan]') && l.includes('sync index is empty')),
      'empty-index startup scan line',
      60000
    );
    evidence('startup scan line', emptyLine);

    const mark = logMark();
    const cursor = await opsCursor();
    await withTimeout(vscode.commands.executeCommand('sftp.upload.folder', vscode.Uri.file(WORKSPACE)), 90000, 'sftp.upload.folder');
    await waitFor(async () => {
      for (const rel of files) {
        if (!(await serverHas(rel, localContent(rel)))) {
          return false;
        }
      }
      return true;
    }, 'every file on the server with the local content', 60000, 500);

    const lines = logSince(mark);
    const degrade = lines.filter(l => l.includes('hash not available on this server, verified by size'));
    evidence('degradation warning lines', degrade.join('\n') || '(none)');
    assert(degrade.length >= 1, 'the hash level degraded to stat with a warning');
    assert(degrade.length === 1, `the warning is logged once per connection (got ${degrade.length})`);
    const temp = lines.filter(l => l.includes('uploading temp file:') || l.includes('moving from:'));
    evidence('temp file lines', temp.join('\n'));
    assertEqual(temp.filter(l => l.includes('uploading temp file:')).length, files.length, 'one .new upload per file');
    assertEqual(temp.filter(l => l.includes('moving from:')).length, files.length, 'one rename per file');
    assertEqual(errorLines(lines).length, 0, 'no [error] lines');

    const ops = await opsSince(cursor);
    evidence('server requests', describeOps(ops.filter(op => op.op !== 'AUTH')).join('\n'));
    const execs = ops.filter(op => op.op === 'EXEC');
    evidence('exec probes refused by the server', describeOps(execs).join('\n') || '(none)');
    assert(execs.length >= 1, 'the client probed for a checksum tool over exec');
    files.forEach(rel => {
      const remote = remotePathOf(rel);
      assert(ops.some(op => op.op === 'OPEN' && op.write && op.path === remote + '.new'), `${rel} uploaded as .new`);
      assert(ops.some(op => op.op === 'RENAME' && op.path === remote + '.new' && op.to === remote && op.ok), `${rel}.new renamed over the target`);
      assert(ops.some(op => (op.op === 'LSTAT' || op.op === 'STAT') && op.ok && op.path === remote), `${rel} stat-verified on the final path`);
    });

    const index = await waitFor(() => {
      const entries = readSyncIndex();
      return files.every(rel => entries[rel.toLowerCase()] && entries[rel.toLowerCase()].status === 'verified') ? entries : null;
    }, 'verified index entries', 20000);
    evidence('sync-index entries', index);
    const activity = await waitFor(() => {
      const ok = files.every(rel => activityEntriesFor(rel).some(e => e.kind === 'upload' && e.status === 'success'));
      return ok ? readActivityLog() : null;
    }, 'activity entries', 20000);
    evidence('activity entries', activity.map(e => `${e.kind} ${e.status} ${e.localPath}`).join('\n'));
  });

  await sleep(3000);
}

// ---------------------------------------------------------------------------

async function run() {
  log(`session "${SESSION}" starting; workspace ${WORKSPACE}; vscode ${vscode.version}; node ${process.version}`);
  if (CONTROL_PORT) {
    control = await connectControl(CONTROL_PORT);
    await control.call('ping', {});
  }
  try {
    switch (SESSION) {
      case 'fresh':
        await sessionFresh();
        break;
      case 'reconcile':
        await sessionReconcile();
        break;
      case 'drain':
        await sessionDrain();
        break;
      case 'hash':
        await sessionHash();
        break;
      default:
        throw new Error(`unknown session ${SESSION}`);
    }
  } finally {
    writeResults(true);
    log(`session "${SESSION}" finished: ${results.map(r => `${r.id}=${r.status}`).join(' ')}`);
    if (control) {
      control.close();
    }
  }
}

module.exports = { run };
