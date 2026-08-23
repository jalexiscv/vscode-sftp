// End-to-end run of the REAL extension in a REAL VS Code extension host against
// a REAL (local) SFTP server. See ./README.md.
//
// Skipped unless SFTP_E2E=1 is set AND a VS Code executable is available
// (the usual install path, or SFTP_E2E_CODE_PATH), so `npm test` never opens
// VS Code windows on its own. The heavy lifting is in runner.js, which is run
// as a child process here so that jest only has to assert its verdict.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function codeExecutable() {
  const candidates = [process.env.SFTP_E2E_CODE_PATH];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
  } else {
    candidates.push('/usr/share/code/code');
  }
  return candidates.find(candidate => candidate && fs.existsSync(candidate));
}

const ENABLED = process.env.SFTP_E2E === '1' && Boolean(codeExecutable());
const describeIf = ENABLED ? describe : describe.skip;

jest.setTimeout(30 * 60 * 1000);

describeIf('end-to-end: extension in VS Code against a local SFTP server', () => {
  const runDir = process.env.SFTP_E2E_RUN_DIR || path.join(os.tmpdir(), 'vscode-sftp-e2e', `jest-${Date.now()}`);

  test('every scenario passes', () => {
    const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'runner.js')], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: Object.assign({}, process.env, { SFTP_E2E_RUN_DIR: runDir }),
      stdio: 'inherit',
      maxBuffer: 64 * 1024 * 1024,
    });

    const summaryFile = path.join(runDir, 'results', 'summary.json');
    expect(fs.existsSync(summaryFile)).toBe(true);
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    const failed = summary.scenarios.filter(s => s.status === 'FAIL' || s.status === 'NOT RUN');
    expect(failed.map(s => `${s.session}/${s.id}: ${s.error || s.title}`)).toEqual([]);
    expect(summary.overall).toBe('PASS');
    expect(result.status).toBe(0);
  });
});
