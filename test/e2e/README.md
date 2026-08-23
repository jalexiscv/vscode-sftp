# End-to-end harness: real extension, real VS Code, real SFTP server

This directory drives the **compiled extension** (`dist/extension.js`) inside a
**real VS Code extension host** against a **real SFTP server** listening on
`127.0.0.1`, and checks what a user would observe: files on the server, the
`sftp` output channel, `activity-log.json` and `sync-index/*.json` under the
workspace storage, and the server's own request log.

Nothing here is mocked. The only things that are local are the server (a
small SFTP server written with the `ssh2` package the extension already
depends on) and the VS Code profile (an isolated `--user-data-dir`).

## How it works

```
runner.js  ──spawns──▶  Code.exe --extensionDevelopmentPath=<repo>
   │                             --extensionTestsPath=test/e2e/extensionHost.js
   │                             --user-data-dir=<run>/user-data  <run>/workspace
   ├─ sftpServer.js   (ssh2 Server, serves <run>/server-root, records every request,
   │                   injects faults on demand; refuses `exec`, so no hash on the server)
   └─ control.js      (JSON-lines TCP channel; the in-host script asks the runner to
                       write workspace files "from outside", set faults, dump the
                       server tree / request log)

extensionHost.js  (runs INSIDE the extension host, has the `vscode` API)
   └─ sessions ──▶ scenarios ──▶ PASS / FAIL / SKIP + evidence ──▶ <run>/results/<session>.json
```

`--extensionTestsPath` is the VS Code extension-test mechanism that
`@vscode/test-electron` wraps. The runner launches the **installed** VS Code
with the same flags `runTests()` would use, so the repo needs no new
dependency. (If you prefer `@vscode/test-electron` — e.g. to download a
specific VS Code build — install it *outside* the repo and call
`runTests({ vscodeExecutablePath, extensionDevelopmentPath: <repo>,
extensionTestsPath: test/e2e/extensionHost.js, extensionTestsEnv: {...} })`
with the same `SFTP_E2E_*` variables the runner sets; the in-host script does
not care who launched it.)

Several VS Code **sessions** run one after another over the same profile, so
state persisted by the extension (sync index, activity log) is exercised
across restarts, and the runner acts as "the program that edits files while
VS Code is closed" between them:

| Session | Workspace | What it covers |
| :--- | :--- | :--- |
| `fresh` | `workspace` (clean storage, server seeded with a few files) | S1 activation, S7 empty index + `Rebuild Sync Index`, S2 `Upload Project` + verification, S3 verification failure (truncating server) + retries + `Retry All Failed`, S4 watcher (external edits with VS Code open, ignore), S5 save = one upload, S8 `Preview Upload` / `Upload Plan` / resume scan |
| `reconcile` | same, after offline edits | S6 startup scan uploads what changed while VS Code was closed; manual `Scan for External Changes` on an up-to-date tree uploads nothing |
| `drain` | same | S9 save + `workbench.action.closeWindow` at once; the runner checks the server after the window is gone (deactivate drain) |
| `hash` | `workspace-hash` (`verifyUpload: "hash"`, `useTempFile: true`, `remotePath: /hash`) | S10 hash degrades to stat on a server without shell (one warning), `.new` + rename |

Scenario ids follow the test plan of the 1.24.0 release (S1…S10). The user-facing
modal confirmation (batches above `externalChanges.confirmThreshold`, git-driven
batches) is **not** driven: the fixtures stay below the threshold and the test
workspace has no `.git`.

## Running it

Prerequisites: VS Code installed (Windows: `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`;
otherwise set `SFTP_E2E_CODE_PATH`), and the extension compiled
(`npm run compile`; the runner compiles when `dist/extension.js` is missing).

```sh
npm run test:e2e                 # = node test/e2e/runner.js
SFTP_E2E=1 npx jest test/e2e     # the same run through jest (skipped without SFTP_E2E)
```

Useful environment variables:

| Variable | Meaning |
| :--- | :--- |
| `SFTP_E2E=1` | required for the jest wrapper (`sftpE2e.spec.js`); the runner itself does not need it |
| `SFTP_E2E_CODE_PATH` | VS Code executable to use |
| `SFTP_E2E_RUN_DIR` | where the run lives (default `<tmp>/vscode-sftp-e2e/<timestamp>`); it is kept after the run |
| `SFTP_E2E_SESSIONS` | comma list of sessions, e.g. `fresh` (later sessions depend on the state the earlier ones leave) |
| `SFTP_E2E_SESSION_TIMEOUT_MS` | ceiling per VS Code session (default 8 min) |
| `SFTP_E2E_CLEAN=1` | remove the run dir at the end |

The shells opened from VS Code's terminal inherit `ELECTRON_RUN_AS_NODE=1`; the
runner strips every `ELECTRON_*` / `VSCODE_*` variable before spawning Code,
otherwise Code would start as plain Node.

A run takes about two minutes. VS Code windows open and close on their own; do
not type into them.

## Output

Everything lands under the run dir:

```
<run>/results/report.md            human-readable report: verdict + evidence per scenario
<run>/results/summary.json         the same as data
<run>/results/<session>.json       what the in-host script recorded
<run>/results/<session>-sftp-output.log    the extension's "sftp" output channel (sftp.debug on)
<run>/results/<session>-exthost.log        VS Code's extension host log
<run>/results/<session>-vscode-stdout.log  stdout/stderr of the VS Code process
<run>/results/<session>-server-ops.json    every SFTP request the server saw during the session
<run>/server-root/                 what the "server" holds at the end
<run>/user-data/User/workspaceStorage/<id>/jalexiscv.sftp/{activity-log.json,sync-index/}
```

The process exits 0 only when every scenario passed (INFO entries never fail a run).

## Adding a scenario

In `extensionHost.js`, inside the session function, call
`scenario('Sx', 'title', async evidence => { ... })`. Use `waitFor` for
anything asynchronous, `evidence(label, value)` for what the report should
show, `control.call('writeWorkspaceFiles' | 'serverTree' | 'serverOps' |
'setFault', ...)` to act from outside VS Code, and read the extension's own
traces with `sftpLogLines()` / `readActivityLog()` / `readSyncIndex()`.
QuickPicks are accepted with `acceptQuickPickSoon()`; modal dialogs cannot be
driven, so keep batches under the confirmation threshold.
