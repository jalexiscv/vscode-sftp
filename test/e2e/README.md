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
   ├─ dialog driver: wraps vscode.window.show*Message (shared with the extension),
   │                 holds modal confirmations until a scenario answers them
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
| `fresh` | `workspace` (clean storage, server seeded with a few files) | S1 activation, S7 unbuilt index (startup scan leaves the unindexed files alone) + `Rebuild Sync Index` (indexes by size, marks the index as built), S2 `Upload Project` + verification, S3 verification failure (truncating server) + retries + `Retry All Failed`, S4 watcher (external edits with VS Code open, ignore), S5 save = one upload, S8 `Preview Upload` / `Upload Plan` / resume scan, S1b no `[error]` in exthost.log |
| `reconcile` | same, after offline edits (2 modified + 2 new); `.vscode/sftp.json` held back until the script activates the extension | S6 startup scan on a built index: the plan has new files, so it asks first (nothing uploads meanwhile), `Upload N file(s)` uploads and verifies everything, a manual `Scan for External Changes` afterwards uploads nothing; S6c a file created while auto sync was paused: the resume scan asks, `Skip` is remembered in the index and a manual scan leaves it alone |
| `drain` | same, after one more offline edit of an indexed file | S6b startup scan with modified files only uploads them on its own (no dialog); S9 save + `workbench.action.closeWindow` at once; the runner checks the server after the window is gone (deactivate drain) |
| `hash` | `workspace-hash` (`verifyUpload: "hash"`, `useTempFile: true`, `remotePath: /hash`) | S10 hash degrades to stat on a server without shell (one warning), `.new` + rename |

Scenario ids follow the test plan of the 1.24.0 release (S1…S10; S6b/S6c split
the reconciliation rules). The fixtures stay below
`externalChanges.confirmThreshold` and the test workspace has no `.git`, so
the only confirmation dialog that appears is the one a scan or poll plan opens
when it contains files the sync index never saw (`new`) on a built index —
which is exactly what S6 and S6c exercise.

### Driving the confirmation dialog

A modal dialog cannot be driven with commands, so `extensionHost.js` answers
it the way a user would, from inside the extension host: the host hands every
module under an extension's path the same `vscode` API object (one instance
per extension, chosen by the requiring file's path), and this script lives
under the extension development path. Wrapping `vscode.window.show*Message`
at module load therefore wraps it for the extension too. Modal calls are
*held* (recorded, never shown) until a scenario answers them with one of the
offered buttons (`pendingModal(/pattern/)` → `dialog.answer('Skip')`);
non-modal messages pass through and are recorded. Every call (message,
buttons, answer) is part of the evidence, and a held dialog that nobody
answers behaves like one the user never closes — which is what the "nothing
uploads while the dialog is open" assertions rely on. The profile also sets
`window.dialogStyle: custom`, so a dialog the driver did not catch can never
block the window from closing.

The test module is loaded only after the eager activations, so a startup
scan triggered by `workspaceContains:.vscode/sftp.json` would already be past
its dialog by the time the driver exists. For the `reconcile` session the
runner therefore moves `.vscode/sftp.json` aside (`sftp.json.e2e-held`) before
launching VS Code; the script puts it back and activates the extension itself,
which runs the same `activate()` → `scanAll('startup')` path (`trigger
startup` in the log). The `drain` session needs no such trick: its startup
plan holds modified files only and must run without asking.

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
<run>/results/<session>.json       what the in-host script recorded (scenarios, host log, every dialog seen: message, buttons, answer)
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
QuickPicks are accepted with `acceptQuickPickSoon()`; a modal confirmation is
held by the dialog driver — wait for it with `pendingModal(/pattern/)`, assert
on `describeDialog(dialog)`, and answer with `dialog.answer('Upload 2 file(s)')`
(or `dialog.answer()` to dismiss it). A held dialog that is never answered
stalls the flow that asked for it, which the scenario then reports.
