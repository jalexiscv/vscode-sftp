#!/usr/bin/env node
// End-to-end runner: the real extension, in a real (isolated) VS Code
// extension host, against a real SFTP server on 127.0.0.1.
//
//   node test/e2e/runner.js            (or: npm run test:e2e)
//
// What it does:
//   1. starts the SFTP server of ./sftpServer.js on a free port, serving a
//      scratch directory;
//   2. builds a test workspace with a `.vscode/sftp.json` pointing at it;
//   3. launches the installed VS Code (Code.exe / code) with
//      --extensionDevelopmentPath=<repo> --extensionTestsPath=./extensionHost.js
//      and its own --user-data-dir / --extensions-dir — the same mechanism
//      @vscode/test-electron uses, without the dependency;
//   4. runs several sessions (see SESSIONS below), acting between them as the
//      "external program" that edits files while VS Code is closed, and
//      serving a control channel the in-host script uses while it is open;
//   5. writes results/summary.json + results/report.md under the run dir and
//      exits 1 if any scenario failed.
//
// Environment:
//   SFTP_E2E_CODE_PATH   VS Code executable (default: the usual install path)
//   SFTP_E2E_RUN_DIR     where the run lives (default: <tmp>/vscode-sftp-e2e/<ts>)
//   SFTP_E2E_SESSIONS    comma list of sessions to run (default: all, in order)
//   SFTP_E2E_KEEP        1 keeps the run dir even when everything passed
//   SFTP_E2E_SESSION_TIMEOUT_MS  per-session ceiling (default 8 min)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const ssh2 = require('ssh2');
const { startSftpServer, snapshotTree } = require('./sftpServer');
const { createControlServer } = require('./control');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXTENSION_ID = 'jalexiscv.sftp';
const SERVICE_NAME = 'e2e-local';
const SESSION_TIMEOUT_MS = Number(process.env.SFTP_E2E_SESSION_TIMEOUT_MS || 8 * 60 * 1000);

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function log(message) {
  const d = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  console.log(`[e2e ${time}] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** The VS Code executable to drive, or null when none is installed. */
function findCodeExecutable() {
  const candidates = [];
  if (process.env.SFTP_E2E_CODE_PATH) {
    candidates.push(process.env.SFTP_E2E_CODE_PATH);
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      candidates.push(path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'));
      candidates.push(path.join(local, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'));
    }
    ['ProgramFiles', 'ProgramFiles(x86)'].forEach(key => {
      if (process.env[key]) {
        candidates.push(path.join(process.env[key], 'Microsoft VS Code', 'Code.exe'));
      }
    });
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
  } else {
    candidates.push('/usr/share/code/code', '/usr/lib/code/code', '/snap/code/current/usr/share/code/code');
  }
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

function writeFileEnsuring(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function copyPreservingMtime(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  const stat = fs.statSync(from);
  fs.utimesSync(to, stat.atime, stat.mtime);
}

// ---------------------------------------------------------------------------
// fixtures

function lorem(lines, seed) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(`${seed} line ${i + 1}: the quick brown fox jumps over the lazy dog`);
  }
  return out.join('\n') + '\n';
}

/**
 * The main workspace. Returns what the in-host script needs to know about it.
 */
function buildMainWorkspace(dir, serverRoot, sftpConfig) {
  fs.rmSync(dir, { recursive: true, force: true });
  const files = {
    'README.md': '# e2e workspace\n\n' + lorem(5, 'readme'),
    'src/app.js': "console.log('v1');\n",
    'src/lib/util.js': 'module.exports = value => value;\n',
    'docs/guide.md': '# guide\n\n' + lorem(8, 'guide'),
    'notes/readme.txt': lorem(3, 'notes'),
    'notes/fail-me.txt': lorem(40, 'fail-me'),
    'drain/late-save.txt': 'late save target\n',
    'ignored-dir/keep.txt': 'ignored by config\n',
  };
  Object.keys(files).forEach(rel => writeFileEnsuring(path.join(dir, rel), files[rel]));
  // a binary beyond one SFTP write chunk (32 KiB)
  const blob = crypto.randomBytes(100 * 1024 + 17);
  writeFileEnsuring(path.join(dir, 'assets', 'blob.bin'), blob);
  writeFileEnsuring(path.join(dir, '.vscode', 'sftp.json'), JSON.stringify(sftpConfig, null, 2));

  // seeds on the server: identical (mtime preserved), different, server-only
  const seededIdentical = ['README.md', 'src/app.js', 'notes/readme.txt'];
  seededIdentical.forEach(rel => copyPreservingMtime(path.join(dir, rel), path.join(serverRoot, rel)));
  const seededDiffer = ['src/lib/util.js'];
  writeFileEnsuring(path.join(serverRoot, 'src', 'lib', 'util.js'), '// an older version of util.js on the server\n');
  const serverOnly = ['server-only.txt'];
  writeFileEnsuring(path.join(serverRoot, 'server-only.txt'), 'exists only on the server\n');

  const uploadable = Object.keys(files).filter(rel => !rel.startsWith('ignored-dir/')).concat(['assets/blob.bin']).sort();
  return {
    seededIdentical,
    seededDiffer,
    serverOnly,
    uploadable,
    failFile: 'notes/fail-me.txt',
    drainFile: 'drain/late-save.txt',
  };
}

function buildHashWorkspace(dir, sftpConfig) {
  fs.rmSync(dir, { recursive: true, force: true });
  const files = {
    'a.txt': lorem(4, 'hash-a'),
    'sub/b.txt': lorem(6, 'hash-b'),
  };
  Object.keys(files).forEach(rel => writeFileEnsuring(path.join(dir, rel), files[rel]));
  writeFileEnsuring(path.join(dir, 'c.bin'), crypto.randomBytes(40 * 1024 + 3));
  writeFileEnsuring(path.join(dir, '.vscode', 'sftp.json'), JSON.stringify(sftpConfig, null, 2));
  return { uploadable: ['a.txt', 'c.bin', 'sub/b.txt'] };
}

/**
 * Edits made "while VS Code is closed" before the reconcile session: two
 * files the index knows (modified) and two it never saw (new).
 */
function applyOfflineEdits(workspace) {
  const edits = [
    { rel: 'src/app.js', kind: 'modified', content: `console.log('v3 edited offline at ${Date.now()}');\n// extra line so the size changes\n` },
    { rel: 'notes/readme.txt', kind: 'modified', content: lorem(5, 'notes-offline') },
    { rel: 'new-offline.txt', kind: 'new', content: 'created while VS Code was closed\n' },
    { rel: 'offline/deep/nested.txt', kind: 'new', content: 'a new directory created offline\n' },
  ];
  edits.forEach(edit => writeFileEnsuring(path.join(workspace, edit.rel), edit.content));
  return edits;
}

/** One more offline edit, of an indexed file only, before the drain session. */
function applyOfflineModification(workspace) {
  const edits = [
    { rel: 'notes/readme.txt', kind: 'modified', content: lorem(7, 'notes-offline-again') },
  ];
  edits.forEach(edit => writeFileEnsuring(path.join(workspace, edit.rel), edit.content));
  return edits;
}

const HELD_CONFIG_REL = '.vscode/sftp.json.e2e-held';

/**
 * Moves `.vscode/sftp.json` aside so that `workspaceContains:` does not
 * activate the extension when the window opens. The in-host script — which VS
 * Code loads only after the eager activations — puts it back and activates the
 * extension itself, with its dialog driver already in place, so the startup
 * scan's confirmation dialog can be answered. Returns the relative path of
 * the held file.
 */
function holdSftpConfig(workspace) {
  const from = path.join(workspace, '.vscode', 'sftp.json');
  const to = path.join(workspace, ...HELD_CONFIG_REL.split('/'));
  if (fs.existsSync(from)) {
    fs.renameSync(from, to);
  }
  return HELD_CONFIG_REL;
}

/** Safety net: a session that never restored the config must not break the next one. */
function releaseSftpConfig(workspace) {
  const held = path.join(workspace, ...HELD_CONFIG_REL.split('/'));
  const target = path.join(workspace, '.vscode', 'sftp.json');
  if (fs.existsSync(held) && !fs.existsSync(target)) {
    fs.renameSync(held, target);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// launching VS Code

const liveChildren = new Set();

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch (error) {
    // already gone
  }
}

function killAllChildren() {
  liveChildren.forEach(killTree);
}
process.on('exit', killAllChildren);
process.on('SIGINT', () => {
  killAllChildren();
  process.exit(130);
});

/**
 * Spawns VS Code in extension-test mode and resolves when it exits.
 * Mirrors @vscode/test-electron's runTests(): same flags, plus an isolated
 * profile. The parent shells of this project inherit ELECTRON_RUN_AS_NODE
 * from VS Code's terminal; it (and every VSCODE_ / ELECTRON_ variable) is
 * stripped, or Code.exe would start as plain Node.
 */
function launchVSCode(options) {
  const args = [
    `--extensionDevelopmentPath=${REPO_ROOT}`,
    `--extensionTestsPath=${path.join(__dirname, 'extensionHost.js')}`,
    `--user-data-dir=${options.userDataDir}`,
    `--extensions-dir=${options.extensionsDir}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--disable-updates',
    '--disable-telemetry',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    '--disable-gpu',
    '--new-window',
    options.workspace,
  ];
  const env = {};
  Object.keys(process.env).forEach(key => {
    if (!/^(ELECTRON_|VSCODE_)/i.test(key)) {
      env[key] = process.env[key];
    }
  });
  Object.assign(env, options.env);

  log(`launching ${options.codePath} ${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
  const outFile = fs.openSync(options.stdoutFile, 'a');
  const child = cp.spawn(options.codePath, args, { env, stdio: ['ignore', outFile, outFile], windowsHide: false });
  liveChildren.add(child);

  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        log(`session exceeded ${options.timeoutMs} ms; killing VS Code`);
        killTree(child);
        finish(null, 'TIMEOUT', true);
      }
    }, options.timeoutMs);
    const finish = (code, signal, timedOut) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(child);
      try {
        fs.closeSync(outFile);
      } catch (error) {
        // closed already
      }
      resolve({ code, signal, timedOut: Boolean(timedOut), pid: child.pid });
    };
    child.on('error', error => {
      log(`spawn error: ${error.message}`);
      finish(-1, error.message, false);
    });
    child.on('exit', (code, signal) => finish(code, signal, false));
  });
}

// ---------------------------------------------------------------------------
// evidence collection from the VS Code profile

function listFilesRecursive(dir, predicate, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return acc;
  }
  entries.forEach(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(full, predicate, acc);
    } else if (entry.isFile() && predicate(full)) {
      acc.push(full);
    }
  });
  return acc;
}

function newestLogsDir(userDataDir) {
  const root = path.join(userDataDir, 'logs');
  let names;
  try {
    names = fs.readdirSync(root).filter(name => fs.statSync(path.join(root, name)).isDirectory());
  } catch (error) {
    return null;
  }
  names.sort();
  return names.length > 0 ? path.join(root, names[names.length - 1]) : null;
}

/** Copies the sftp output channel log and exthost.log of the latest VS Code session. */
function collectLogs(userDataDir, resultsDir, sessionName) {
  const dir = newestLogsDir(userDataDir);
  const copied = {};
  if (!dir) {
    return copied;
  }
  const sftpLogs = listFilesRecursive(dir, file => /sftp\.log$/i.test(file));
  if (sftpLogs.length > 0) {
    const target = path.join(resultsDir, `${sessionName}-sftp-output.log`);
    fs.writeFileSync(target, sftpLogs.map(file => fs.readFileSync(file, 'utf8')).join('\n'));
    copied.sftpOutput = target;
  }
  const extHost = listFilesRecursive(dir, file => /[\\/]exthost\.log$/i.test(file));
  if (extHost.length > 0) {
    const target = path.join(resultsDir, `${sessionName}-exthost.log`);
    fs.copyFileSync(extHost[0], target);
    copied.extHost = target;
  }
  return copied;
}

function tail(file, lines) {
  try {
    const all = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    return all.slice(-lines).join('\n');
  } catch (error) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// report

function renderReport(summary) {
  const lines = [];
  lines.push('# VSCode-Sftp end-to-end run');
  lines.push('');
  lines.push(`- Date: ${summary.date}`);
  lines.push(`- VS Code: ${summary.codePath}`);
  lines.push(`- Extension: ${summary.extension}`);
  lines.push(`- SFTP server: 127.0.0.1:${summary.serverPort}, root ${summary.serverRoot}`);
  lines.push(`- Run dir: ${summary.runDir}`);
  lines.push(`- Overall: **${summary.overall}**`);
  lines.push('');
  lines.push('| Session | Scenario | Status | Title |');
  lines.push('| :--- | :--- | :--- | :--- |');
  summary.scenarios.forEach(s => {
    lines.push(`| ${s.session} | ${s.id} | ${s.status} | ${s.title.replace(/\|/g, '\\|')} |`);
  });
  lines.push('');
  summary.sessions.forEach(session => {
    lines.push(`## Session ${session.name} (exit ${session.outcome.code}${session.outcome.signal ? ' / ' + session.outcome.signal : ''}${session.outcome.timedOut ? ', TIMED OUT' : ''})`);
    lines.push('');
    if (session.logs && session.logs.sftpOutput) {
      lines.push(`- sftp output channel: ${session.logs.sftpOutput}`);
    }
    if (session.logs && session.logs.extHost) {
      lines.push(`- exthost.log: ${session.logs.extHost}`);
    }
    lines.push(`- VS Code stdout/stderr: ${session.stdoutFile}`);
    lines.push('');
    (session.scenarios || []).forEach(s => {
      lines.push(`### ${s.id} — ${s.status} — ${s.title}`);
      lines.push('');
      if (s.error) {
        lines.push('```');
        lines.push(s.error);
        lines.push('```');
        lines.push('');
      }
      (s.evidence || []).forEach(e => {
        lines.push(`**${e.label}**`);
        lines.push('');
        lines.push('```');
        lines.push(e.value);
        lines.push('```');
        lines.push('');
      });
    });
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

async function main() {
  const codePath = findCodeExecutable();
  if (!codePath) {
    console.error('No VS Code executable found. Set SFTP_E2E_CODE_PATH to Code.exe / code.');
    process.exit(2);
  }
  const distMain = path.join(REPO_ROOT, 'dist', 'extension.js');
  if (!fs.existsSync(distMain)) {
    log('dist/extension.js missing: running `npm run compile`');
    const build = cp.spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'compile'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (build.status !== 0 || !fs.existsSync(distMain)) {
      console.error('compile failed');
      process.exit(2);
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

  const runDir = path.resolve(process.env.SFTP_E2E_RUN_DIR || path.join(os.tmpdir(), 'vscode-sftp-e2e', stamp()));
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const userDataDir = path.join(runDir, 'user-data');
  const extensionsDir = path.join(runDir, 'extensions');
  const serverRoot = path.join(runDir, 'server-root');
  const workspace = path.join(runDir, 'workspace');
  const workspaceHash = path.join(runDir, 'workspace-hash');
  const resultsDir = path.join(runDir, 'results');
  [userDataDir, extensionsDir, serverRoot, resultsDir, path.join(userDataDir, 'User')].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

  log(`run dir: ${runDir}`);
  log(`vscode: ${codePath}`);
  log(`extension: ${pkg.publisher}.${pkg.name} ${pkg.version} at ${REPO_ROOT}`);

  // the isolated profile: no trust prompt, debug log of the extension on
  writeFileEnsuring(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'sftp.debug': true,
    'sftp.printDebugLog': true,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'workbench.startupEditor': 'none',
    'workbench.enableExperiments': false,
    'files.autoSave': 'off',
    'files.hotExit': 'off',
    'window.restoreWindows': 'none',
    'git.enabled': false,
    // modal dialogs the in-host script does not intercept are then workbench
    // dialogs, not native ones: they never block the window from closing
    'window.dialogStyle': 'custom',
  }, null, 2));

  // the server
  const hostKey = ssh2.utils.generateKeyPairSync('rsa', { bits: 2048 }).private;
  fs.writeFileSync(path.join(runDir, 'hostkey'), hostKey);
  const serverLog = fs.createWriteStream(path.join(resultsDir, 'sftp-server.log'), { flags: 'a' });
  const server = await startSftpServer({
    root: serverRoot,
    hostKey,
    username: 'test',
    password: 'test',
    log: line => serverLog.write(`${new Date().toISOString()} ${line}\n`),
  });
  log(`sftp server on 127.0.0.1:${server.port}`);

  const baseConfig = {
    name: SERVICE_NAME,
    host: '127.0.0.1',
    protocol: 'sftp',
    port: server.port,
    username: 'test',
    password: 'test',
    remotePath: '/',
    uploadOnSave: true,
    useTempFile: false,
    openSsh: false,
    verifyUpload: 'stat',
    uploadRetries: 2,
    ignore: ['.vscode', 'ignored-dir', '**/*.ignored'],
    watcher: { files: '**/*', autoUpload: true, autoDelete: false },
    externalChanges: { scanOnStartup: true, scanOnResume: true, confirmThreshold: 20 },
    connectTimeout: 10000,
  };
  const mainFixtures = buildMainWorkspace(workspace, serverRoot, baseConfig);
  const hashConfig = Object.assign({}, baseConfig, {
    remotePath: '/hash',
    verifyUpload: 'hash',
    useTempFile: true,
    watcher: undefined,
  });
  delete hashConfig.watcher;
  const hashFixtures = buildHashWorkspace(workspaceHash, hashConfig);

  // the control channel the in-host script talks to
  let activeWorkspace = workspace;
  const control = await createControlServer({
    ping: () => 'pong',
    log: ({ message }) => {
      log(message);
      return true;
    },
    writeWorkspaceFiles: ({ files }) => {
      // written by this process, i.e. outside VS Code, in one tight loop
      const written = [];
      (files || []).forEach(file => {
        const target = path.join(activeWorkspace, ...file.rel.split('/'));
        const content = file.contentBase64 !== undefined ? Buffer.from(file.contentBase64, 'base64') : String(file.content);
        writeFileEnsuring(target, content);
        if (file.mtimeMs) {
          fs.utimesSync(target, new Date(file.mtimeMs), new Date(file.mtimeMs));
        }
        written.push(target);
      });
      return written;
    },
    serverTree: ({ withContent }) => snapshotTree(serverRoot, Boolean(withContent)),
    serverOps: ({ since, onlyCount }) => ({
      ops: onlyCount ? [] : server.ops.slice(since || 0),
      nextIndex: server.ops.length,
    }),
    setFault: ({ truncate, failWrite }) => {
      server.faults.truncate = new Set(truncate || []);
      server.faults.failWrite = new Set(failWrite || []);
      return { truncate: Array.from(server.faults.truncate), failWrite: Array.from(server.faults.failWrite) };
    },
  }, log);

  const sessions = [
    { name: 'fresh', workspace, fixtures: mainFixtures, remoteBase: '/' },
    {
      name: 'reconcile', workspace, remoteBase: '/',
      before: () => {
        const edits = applyOfflineEdits(workspace);
        log(`offline edits applied: ${edits.map(e => `${e.rel} (${e.kind})`).join(', ')}`);
        const heldConfig = holdSftpConfig(workspace);
        log(`.vscode/sftp.json held back as ${heldConfig}: the in-host script activates the extension itself`);
        return Object.assign({}, mainFixtures, { offlineEdits: edits, heldConfig });
      },
      after: () => {
        if (releaseSftpConfig(workspace)) {
          log('warning: the reconcile session never restored .vscode/sftp.json; restored by the runner');
        }
        return [];
      },
    },
    {
      name: 'drain', workspace, remoteBase: '/',
      before: () => {
        const edits = applyOfflineModification(workspace);
        log(`offline modification applied: ${edits.map(e => e.rel).join(', ')}`);
        return Object.assign({}, mainFixtures, { offlineModified: edits });
      },
      after: (session, results) => {
        const expect = results && results.scenarios ? results.scenarios.find(s => s.id === 'S9-expect') : null;
        const scenarioResult = { id: 'S9', title: 'Deactivation drains the save made right before the window closed', status: 'NOT RUN', evidence: [], error: null };
        if (!expect) {
          scenarioResult.error = 'the host never reached the save (see S9-host)';
          return [scenarioResult];
        }
        const expected = expect.evidence.find(e => e.label === 'expected').value;
        const rel = expect.evidence.find(e => e.label === 'rel').value;
        const serverFile = path.join(serverRoot, ...rel.split('/'));
        let actual = null;
        try {
          actual = fs.readFileSync(serverFile, 'utf8');
        } catch (error) {
          actual = null;
        }
        scenarioResult.evidence.push({ label: 'expected content', value: expected });
        scenarioResult.evidence.push({ label: 'server content after the window closed', value: actual === null ? '(file missing)' : actual });
        const outputTail = session.logs && session.logs.sftpOutput ? tail(session.logs.sftpOutput, 40) : '';
        scenarioResult.evidence.push({ label: 'sftp output channel (last 40 lines)', value: outputTail });
        const extHostTail = session.logs && session.logs.extHost
          ? fs.readFileSync(session.logs.extHost, 'utf8').split(/\r?\n/).filter(l => /terminat|deactivat|exiting|Extension host/i.test(l)).slice(-15).join('\n')
          : '';
        scenarioResult.evidence.push({ label: 'exthost.log (termination lines)', value: extHostTail });
        scenarioResult.status = actual === expected ? 'PASS' : 'FAIL';
        if (scenarioResult.status === 'FAIL') {
          scenarioResult.error = 'the file saved right before closing the window did not reach the server with the saved content';
        }
        return [scenarioResult];
      },
    },
    { name: 'hash', workspace: workspaceHash, fixtures: hashFixtures, remoteBase: '/hash' },
  ];
  const wanted = (process.env.SFTP_E2E_SESSIONS || sessions.map(s => s.name).join(','))
    .split(',').map(s => s.trim()).filter(Boolean);

  const sessionReports = [];
  for (const session of sessions) {
    if (wanted.indexOf(session.name) === -1) {
      continue;
    }
    log(`=== session ${session.name} ===`);
    activeWorkspace = session.workspace;
    const fixtures = session.before ? session.before() : session.fixtures;
    const resultFile = path.join(resultsDir, `${session.name}.json`);
    fs.rmSync(resultFile, { force: true });
    const stdoutFile = path.join(resultsDir, `${session.name}-vscode-stdout.log`);
    const opsBefore = server.ops.length;
    const outcome = await launchVSCode({
      codePath,
      workspace: session.workspace,
      userDataDir,
      extensionsDir,
      stdoutFile,
      timeoutMs: SESSION_TIMEOUT_MS,
      env: {
        SFTP_E2E_SESSION: session.name,
        SFTP_E2E_CONTROL_PORT: String(control.port),
        SFTP_E2E_RESULT_FILE: resultFile,
        SFTP_E2E_USER_DATA_DIR: userDataDir,
        SFTP_E2E_WORKSPACE: session.workspace,
        SFTP_E2E_SERVER_ROOT: serverRoot,
        SFTP_E2E_SERVICE_NAME: SERVICE_NAME,
        SFTP_E2E_EXTENSION_ID: EXTENSION_ID,
        SFTP_E2E_REMOTE_BASE: session.remoteBase,
        SFTP_E2E_FIXTURES: JSON.stringify(fixtures),
      },
    });
    log(`session ${session.name} exited: code=${outcome.code} signal=${outcome.signal} timedOut=${outcome.timedOut}`);
    // give the profile's log writers a moment, then collect
    await sleep(1500);
    const logs = collectLogs(userDataDir, resultsDir, session.name);
    let results = null;
    try {
      results = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    } catch (error) {
      log(`no results file for session ${session.name}: ${error.message}`);
    }
    const report = { name: session.name, outcome, logs, stdoutFile, results, scenarios: results ? results.scenarios.slice() : [] };
    if (!results) {
      report.scenarios.push({
        id: `${session.name}-harness`, title: `session ${session.name} produced no results (VS Code exit ${outcome.code}/${outcome.signal})`,
        status: 'NOT RUN', evidence: [{ label: 'vscode stdout tail', value: tail(stdoutFile, 60) }], error: 'no results file',
      });
    } else if (!results.complete && !(session.name === 'drain' && results.scenarios.some(s => s.id === 'S9-expect'))) {
      // the drain session closes its own window mid-run on purpose
      report.scenarios.push({
        id: `${session.name}-incomplete`, title: `session ${session.name} did not run to completion (VS Code exit ${outcome.code}/${outcome.signal})`,
        status: 'NOT RUN', evidence: [{ label: 'vscode stdout tail', value: tail(stdoutFile, 60) }], error: null,
      });
    }
    if (session.after) {
      report.scenarios.push(...session.after(report, results));
    }
    fs.writeFileSync(path.join(resultsDir, `${session.name}-server-ops.json`), JSON.stringify(server.ops.slice(opsBefore), null, 1));
    sessionReports.push(report);
  }

  await control.close();
  await server.close();
  serverLog.end();

  const scenarios = [];
  sessionReports.forEach(session => session.scenarios.forEach(s => scenarios.push({ session: session.name, id: s.id, title: s.title, status: s.status, error: s.error })));
  const failed = scenarios.filter(s => s.status === 'FAIL').length;
  const notRun = scenarios.filter(s => s.status === 'NOT RUN').length;
  const overall = failed > 0 ? 'FAIL' : notRun > 0 ? 'INCOMPLETE' : 'PASS';
  const summary = {
    date: new Date().toISOString(),
    codePath,
    extension: `${pkg.publisher}.${pkg.name} ${pkg.version} (${REPO_ROOT})`,
    serverPort: server.port,
    serverRoot,
    runDir,
    overall,
    scenarios,
    sessions: sessionReports.map(s => ({ name: s.name, outcome: s.outcome, logs: s.logs, stdoutFile: s.stdoutFile, scenarios: s.scenarios })),
  };
  fs.writeFileSync(path.join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(resultsDir, 'report.md'), renderReport(summary));

  console.log('');
  console.log('Session    Scenario   Status    Title');
  scenarios.filter(s => s.status !== 'INFO').forEach(s => {
    console.log(`${s.session.padEnd(10)} ${s.id.padEnd(10)} ${s.status.padEnd(9)} ${s.title}`);
  });
  console.log('');
  console.log(`Overall: ${overall}   (report: ${path.join(resultsDir, 'report.md')})`);

  if (overall === 'PASS' && !process.env.SFTP_E2E_KEEP) {
    log('everything passed; the run dir is kept for inspection anyway (set SFTP_E2E_CLEAN=1 to remove it)');
  }
  if (process.env.SFTP_E2E_CLEAN) {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
  process.exitCode = overall === 'PASS' ? 0 : 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  killAllChildren();
  process.exit(1);
});
