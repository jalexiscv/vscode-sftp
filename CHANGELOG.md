## 1.24.0 - 2026-08-22 (fork jalexiscv/vscode-sftp)
*Version 1.23.0 was never released; the number was skipped so that the change in default behaviour introduced here — the local tree is reconciled with the server on startup and every upload is verified — stands out in the version history.*

* New Feature : **External changes are detected, including those made while VS Code was closed** — a persistent *sync index* (one JSON per server, `sync-index/<key>.json` under the workspace storage of the extension) remembers which version of every local file was last uploaded and verified. The local tree is compared with it when the extension activates and when `sftp.json` is reloaded (`externalChanges.scanOnStartup`), when auto sync is resumed and when the window regains focus after five minutes or more (`externalChanges.scanOnResume`), on demand with the new `SFTP: Scan for External Changes`, and optionally on a timer (`watcher.pollInterval`, for network drives and Docker/WSL mounts where filesystem events are unreliable). Whatever changed since its last verified upload — a `git pull` in a terminal, a code generator, a week of edits with the window closed — becomes an upload plan; nothing is listed on the server. The index starts out unseeded: until the new `SFTP: Rebuild Sync Index` has run once for a server (or a manual scan has planned, been confirmed and uploaded — a plain `uploadOnSave` adds entries but does not seed), automatic scans only plan files the extension already uploaded itself and ignore unindexed ones (counted in the output channel, `N unindexed file(s) ignored until the index is built`), and a one-time notice per server — remembered per workspace — offers `Build index now` / `Don't show again`. `SFTP: Rebuild Sync Index` lists the remote and local trees, records every file present on both sides with the same size (the remote mtime is not required to match, since a deploy through git, rsync or CI never preserves it), reports `N indexed; M differ in size; K only local` and marks the index as seeded.
* New Feature : **One change collector for `uploadOnSave` and the watcher** — both now feed the same collector, keyed by path, so a save seen by both is uploaded once; `uploadOnSave: false` is no longer needed when watching `**/*`. Editor saves are uploaded immediately (the watcher echo for that path is discarded for 1.5 s); external changes are batched for 700 ms (1.4 s at most when files keep changing); ignored paths are dropped at enqueue time; a change on a path whose upload is in flight is deferred to the next pass instead of lost; a directory in the batch is expanded into its files.
* New Feature : **Upload plans** — every batch (watcher, scan, poll, command, git) is a plan with its source, one item per file with reason (`new`, `modified`), status (`pending`, `uploading`, `verified`, `failed`, `skipped`, `stale`), attempts and error. Plans appear in a new **Upload plans** group of the SFTP Activity view, with actions to upload the plan, upload/skip/diff a single file, export the report and remove or clear plans. New commands: `SFTP: Preview Upload (Dry Run)` (what would be uploaded for the project, the active folder or a picked folder — without uploading), `SFTP: Upload Plan`, `SFTP: Export Last Upload Report` (Markdown) and `SFTP: Clear Upload Plans`. A plan runs through a single scheduler per server (400 files used to mean 400 schedulers and, over FTP, 400 queued connections), re-checks each file before sending it (gone → `skipped`, changed → refreshed) and after (rewritten during the upload → `stale`, sent once more), and is never run against a profile other than the one it was built under; in automatic plans, files open in the editor with unsaved changes are skipped (`unsaved changes in the editor`) rather than saved and uploaded, and `Cancel All Transfers` returns the items that had not started to `pending`. The status bar shows `↑N` pending and `✗N` failed uploads.
* New Feature : **Confirmation above a threshold, on git operations and on new files** — above `externalChanges.confirmThreshold` files (20 by default), whenever git moved HEAD between the change and the upload, and whenever an automatic batch contains files the index has never seen, nothing is uploaded until you confirm: a modal dialog lists the files and offers `Review plan` (the default; the plan stays pending in the activity view), `Upload N file(s)` or `Skip`. `Skip` is remembered — the files are recorded in the index with their current size and mtime and not proposed again until they change. Only `modified` files below the threshold go up without asking. Symmetric to `deleteRemoteConfirmThreshold`; applies to every source, including a *Save All* of many files with `uploadOnSave`.
* New Feature : **Upload verification** (`verifyUpload`, default `stat`) — the bytes sent are always counted against the local size, in both directions. With `stat`, the remote size must equal the local one exactly after the upload (`lstat` over SFTP, `SIZE` over FTP, on the final path even with `useTempFile`), and over SFTP the mtime is compared within ±2 s — as a warning only — when the server accepted the timestamp. With `hash`, a digest of the remote file is compared with the local one (sha256/sha1/md5/crc32 via `sha256sum`, `shasum -a 256`, `openssl dgst` or `md5sum` run over an SSH `exec` channel — on the final host with `hop` —, or `XSHA256`/`XSHA1`/`XMD5`/`XCRC`/`HASH` when the FTP server advertises them in `FEAT`), probing once per connection and falling back to `stat` with a one-time warning when the server cannot compute one; only a different digest is a failure. `none` trusts the protocol acknowledgement alone. A failed check is retried like a transient network error (`uploadRetries`, default 2, with an increasing delay, also for downloads; permanent errors — permission denied, missing source, FTP `5xx` other than quota — are not retried) and then reported as a failed upload with a concrete reason (`size mismatch (local 1024, remote 0)`, `hash mismatch (sha256: …)`). With `useTempFile`, a short upload never replaces the destination: the byte count is checked before the `rename`.
* New Feature : **Per-task, persistent activity log** — every transfer is recorded from the transfer hooks, whether it came from a command, `uploadOnSave` or the watcher, with local and remote path, profile, retry and verification result; the 200 most recent entries survive a window reload (`activity-log.json` in the workspace storage), pending entries are marked cancelled on reload, and failed uploads/downloads keep their `Retry`, so `Retry All Failed Operations` still sees the failures of the previous session. Failures that happen before any transfer starts (connection refused, bad credentials, missing source, `ensureDir` denied) are recorded too, with a retry.
* Fix : **`uploadFile()` and friends now reject when a transfer fails** — `TransferScheduler.run()` resolved when idle even if a task had failed, so `uploadOnSave` marked a broken upload as a success in the activity view and `Upload Changed Files` never reached its error path. `run()` now reports `{ succeeded, failed, cancelled }` and the handlers throw an aggregated `TransferFailedError` (`ETRANSFER_FAILED`, at most five names and `and N more`) that is marked as already reported, so no dialog is shown twice.
* Fix : **Automatic sync is now really suppressed during downloads and `Sync Remote -> Local`** — `suppressAutoSync` had no caller in production, so the watcher re-uploaded the extension's own writes and the delete monitor mirrored the deletions of a `--delete` sync back to the server. Downloads, `sync2Local` and the bidirectional sync now run under suppression (plus a 1.5 s tail); uploads are deliberately not wrapped, and a save made while the suppression is active is deferred until it ends rather than lost.
* Fix : `ignore` patterns with a trailing slash (`node_modules/`, the usual form in an `ignoreFile` or `.gitignore`) did not prune the directory in the local scanner — the subtree was walked and filtered file by file; `ignore(path, isDirectory)` now also tries `path/` for directories.
* Fix : Following symlinks in the local scanner could loop on a link (or junction) to an ancestor until `ENAMETOOLONG`; a link whose real target is, or contains, a directory already on the path from the root is skipped.
* Fix : Numeric SFTP error codes (ssh2 reports `3` for permission denied) were shown as the failure reason (`a.txt (3)`); only a non-empty string code is used, otherwise the message folded to one line.
* Fix : The watcher's leading-edge 550 ms debounce could upload a file that was still being rewritten; batching is now trailing-edge with a bounded maximum wait, and a `git commit` (which does not move the HEAD ref) or a transient `index.lock` from `git status` no longer marks a batch as git-driven.
* Hardening (found by two adversarial reviews of this release, before shipping — one of the transfer base, index and scanner, one of the whole integration) : the second review reshaped the first-use flow described above (seeded index, automatic scans limited to already-uploaded files until then, one-time notice remembered per workspace), made `Skip` persistent, put `Review plan` first in the dialog, made the index rebuild compare sizes only, restricted retries to transient errors, skipped files with unsaved editor changes in automatic plans and deferred saves made during a download instead of dropping them; from the first review, the sync index survives a failing `rename` of its `.tmp` (retried with a short delay, never left orphaned, saved again on the next change), keeps an unreadable or corrupt index as `<file>.corrupt-<timestamp>` instead of overwriting it, and is flushed on deactivate together with the activity log; `deactivate` drains the change collector and waits up to 5 s for running plans, so a save followed by *Reload Window* is uploaded; with `useTempFile` a failed byte count never reaches the `rename`; hash probing is cached per connection and shared between concurrent uploads, shell paths are quoted for `sh`, coreutils' `\` prefix and `openssl`'s `= ` output are parsed, and a rejected `OPTS HASH` falls back to the next candidate; a plan built under another profile is refused instead of being recorded against the wrong destination; cancelling an index rebuild leaves the index as it was.
* Quality : Test suite grows from 168 to 701 tests (8 env-gated FTP integration tests skipped without a server): the scheduler contract, the transfer pipeline end to end over `memfs`, size and hash verification per filesystem, the sync index persistence and atomic writes, the local scanner (pruning, cancellation, symlink loops, measured concurrency), the change collector with legacy fake timers, the plan runner, the confirmation dialog, the scanner triggers, the status-bar counters and the activity view nodes.

## 1.22.0 - 2026-08-16 (fork jalexiscv/vscode-sftp)
*Version 1.21.0 was never released; the number was skipped so that the change in default behaviour introduced here — local deletions are now mirrored to the server out of the box — stands out in the version history.*

* New Feature : **Local scratch files are never transferred** — a built-in exclusion list now covers editor swap and backup files (vim, emacs), Office and LibreOffice lock files, merge leftovers (`*.orig`, `*.rej`, `*.bak`), partially written downloads (`*.part`, `*.crdownload`), OS metadata (`.DS_Store`, `Thumbs.db`, `desktop.ini`) and the extension's own `.new` staging file, on every server and with no configuration. Tunable with the new `ignoreTempFiles` and `tempFilePatterns` options; dependency lock files such as `composer.lock` are deliberately left out of the list.
* New Feature : **Local deletions are mirrored to the server** (`deleteRemoteOnLocalDelete`, on by default). It covers files and folders, and deletions made from the VS Code explorer, a terminal or an external tool alike — no `watcher.files` glob required. Four safeguards keep it from becoming a footgun: a modal confirmation above `deleteRemoteConfirmThreshold` files (10 by default), deletions caused by a git operation are discarded (detected through `.git/index.lock`, `MERGE_HEAD`, `rebase-merge`…), deletions caused by the extension's own `Sync Remote -> Local --delete` are suppressed instead of bouncing back to the server, and everything goes through the new remote trash.
* New Feature : **Remote trash with undo** (`remoteTrash`) — a deletion is a server-side rename into `<trash>/<timestamp>/<original path>` instead of an `unlink`, so it costs no bandwidth and stays reversible. New commands `SFTP: Undo Last Remote Deletion` (restores the whole last batch), `SFTP: Restore from Remote Trash` and `SFTP: Empty Remote Trash`. Expired entries are purged in the background after `retentionDays`, and the trash folder is excluded from syncs automatically.
* New Feature : **Renames and moves are mirrored as server-side renames** (`renameRemoteOnLocalRename`) instead of upload-then-delete: the file keeps its remote identity and there is no window in which the path is missing on a live document root. Moving into a folder that doesn't exist yet creates it, and a source that was never uploaded falls back to a plain upload.
* New Feature : **SFTP Activity view** — a second view in the SFTP sidebar with the history of every transfer, deletion and rename: type, status, time, path, profile, duration and error. Failed operations can be retried individually or all at once. Hide it with the `sftp.showActivityView` setting.
* New Feature : **Pause automatic sync** (`SFTP: Pause/Resume Auto Sync`) — suspends `uploadOnSave`, `downloadOnOpen`, the watcher and the deletion/rename mirroring, while explicit commands keep working. The state persists per workspace and shows in the status bar, which now also reports the number of pending transfers.
* Hardening (found by an adversarial review of this release, before shipping) : the git safeguard was evaluated when the deletion batch ran rather than when the deletion was observed, so a plain `git checkout` — which releases `index.lock` in well under the batching delay — slipped through it; HEAD is now captured at queue time and compared. `watcher.autoDelete` and `deleteRemoteOnLocalDelete` both mirrored the same event, and the older path won the race with a leading-edge debounce, stripping the trash, the threshold and the confirmation off the deletion; there is now a single path. `remoteTrash.path` accepted values such as `"."` or `"/"`, which resolve to (or above) `remotePath` and would have turned `Empty Remote Trash` into a recursive delete of the document root; unsafe roots are rejected. Restoring and purging used the *active* profile instead of the profile the file was deleted under, which on a multi-profile config meant connecting to the wrong server. A failed rename left the file orphaned on the server, because the deletion of the old path stayed suppressed. `.git/**` was not excluded from the delete monitor, so every `git status` sent a round trip for `index.lock`. `restoreFromTrash` read any `lstat` failure as "the path is free", and over FTP a rename onto an existing path silently overwrites it. `*.tmp*` also matched `.tmpl` and `.tmpx`, silently skipping real template files.
* Hardening (second pass) : expired trash is now swept by scanning the trash directory itself, not only the index — entries pushed out of the bounded index used to sit on the server for ever, unreachable for a restore and invisible to a purge. Batch folders are dated from their own name, and a name whose components don't read back exactly as written is left alone rather than deleted (`Date` rolls out-of-range values over instead of rejecting them, so a nonsense folder name would otherwise have been given a plausible date and swept). Pending suppression timers are tracked, `unref`'d and cancelled on deactivate. Path comparisons in the delete monitor treat macOS as case-insensitive, like Windows, since APFS and HFS+ are by default.
* Fix : **Renaming through `Upload Changed Files` never worked** — `renameRemote` passed *local* paths to the *remote* filesystem and swapped source and destination (`rename(new, old)`).
* Fix : **A transient listing error could wipe a destination during a sync** — `list()` failures were swallowed into an empty array, so a network blip on the source side looked like "everything is gone" and, with `syncOption.delete`, marked the whole destination for removal.
* Fix : **`Sync Remote -> Local --delete` could delete on the server what it had just synced** — the watcher guarded uploads against in-flight transfers but not deletions.
* Fix : Deletions reported by `sync()` included ignored files that were never actually deleted, and the removals themselves were fired without `await`, so a command could report success before the server was done.
* Fix : `chmod` was called without `await` in two places in the transfer pipeline, producing an unhandled rejection on FTP servers that reject `SITE CHMOD`; it is now awaited and non-fatal.
* Fix : `syncOption.update` compared raw milliseconds while the rest of the pipeline compared seconds, so sub-second noise a remote filesystem cannot even represent caused files to be re-transferred on every sync.
* Fix : In `Upload Changed Files`, the `try/catch` blocks wrapped async calls without `await`, so operations were neither awaited nor their errors caught. Deletions there now ask for confirmation as well.
* Fix : `schema/ftp.schema.json` referenced `definitions.json#/sftp` instead of `#/ftp`, so an FTP configuration got SFTP autocompletion and none of its own options (`secure`, `secureOptions`, `passive`).
* Fix : The watcher created a `RelativePattern` from an undefined glob when `watcher.autoDelete` was set without `watcher.files` (`undefined == false` is false in JS), queued duplicates because it keyed by `Uri` identity instead of by path, tried to delete children of an already-deleted directory, and left disposed watchers in its registry.
* Fix : `filePerm` and `dirPerm` were not validated, so a string or boolean reached `parseInt(x, 8)` as `NaN`; they are now declared in both the Joi validator and the JSON schema, along with `passive` (documented as ignored since the `basic-ftp` migration).
* Quality : The flaky `scheduler` test that asserted a 50 ms timing window — and which left `npm test` failing — was rewritten around the property it meant to check. Test suite grows from 42 to 168 tests, covering the exclusion rules end to end, the pause and suppression state machine, git-operation detection and the deletion safeguards.

## 1.20.0 - 2026-07-10 (fork jalexiscv/vscode-sftp)
* New Feature : **Temporary files are never transferred** — any file or folder whose name contains `.tmp` is excluded from uploads, `uploadOnSave` and sync on every server, without any `ignore` configuration.
* Fix : **The active profile no longer switches by itself** — reloading `sftp.json` (editor save, git branch switch, Connection Manager save) stops resetting the selection to `defaultProfile`, and the selected profile now persists across VSCode restarts. `defaultProfile` becomes just the initial value and the fallback when the active profile disappears from the configuration.

## 1.19.0 - 2026-07-07 (fork jalexiscv/vscode-sftp)
* New Feature : **Graphical Connection Manager** — the new `SFTP: Open Connection Manager` command (also reachable from the gear button of the Remote Explorer view) opens a webview panel to create, edit, duplicate, delete, test and activate the connections/profiles of `.vscode/sftp.json` without editing the JSON by hand. Saving reloads the services automatically and "Test connection" reuses the real connection machinery (including securely saved passwords) without touching connections in use.
* Quality : TypeScript `strict` mode enabled (`noImplicitAny` deferred to an incremental follow-up) and 26 real type errors fixed, including a latent crash in the profile state observer.

## 1.18.0 - 2026-07-05 (fork jalexiscv/vscode-sftp)
* FTP : **Migrated the FTP backend from the abandoned `ftp` package (0.3.10, ~10 years unmaintained) to the actively maintained [`basic-ftp`](https://github.com/patrickjuchli/basic-ftp)**. Native UTF-8 negotiation, robust FTPS (explicit/implicit) and passive mode — validated against a real FTPS server with a new env-gated integration test (baseline `ftp`: 7/8 with a `read ECONNRESET`; `basic-ftp`: 8/8). Expected to resolve the FTP bug cluster of the upstream backlog ("unable to parse pasv server response", FTPS with FileZilla, garbled non-ASCII names, ECONNRESET).
* Removed the abandoned `ftp` dependency.
* Note : `basic-ftp` supports passive mode only; FTP active mode (`passive: false`) is no longer supported.

## 1.17.0 - 2026-07-05 (fork jalexiscv/vscode-sftp)
* New Feature : **Securely save passwords** with VS Code SecretStorage (OS keychain). After a successful connection with a typed password the extension offers to remember it; stale passwords are forgotten automatically on auth failure. New command `SFTP: Forget Saved Passwords` and setting `sftp.promptToSavePassword` (most requested feature of the upstream backlog, replaces the discarded approach of upstream PR [#545](https://github.com/Natizyskunk/vscode-sftp/pull/545)).
* CI : GitHub Actions workflow verifying lint, build and tests on every push/PR, plus automated release packaging on tags.
* The README ships in six languages (Spanish base, English, 简体中文, Português-BR, Français, Deutsch).

## 1.16.5 - 2026-07-05 (fork jalexiscv/vscode-sftp)
* Fix : `Open SSH in Terminal` now uses the configured `hop` chain via OpenSSH ProxyJump (`-J`) (upstream issue [#441](https://github.com/Natizyskunk/vscode-sftp/issues/441)).
* Fix : Remote symlinks pointing to directories are now browsable in the Remote Explorer over SFTP (upstream issue [#283](https://github.com/Natizyskunk/vscode-sftp/issues/283)).
* Fix : `uploadOnSave` now triggers when saving notebook documents such as `.ipynb` (notebook saves don't fire `onDidSaveTextDocument`).

## 1.16.4 - 2026-07-05 (fork jalexiscv/vscode-sftp)
* Fix : Restore compilation of the develop codebase (missing constant imports from upstream PR [#408](https://github.com/Natizyskunk/vscode-sftp/pull/408), broken `vscode-uri` import).
* Fix : Upgrade `ssh2` to v1.17.0, fixing "isDate is not a function" on recent VSCode/Node runtimes (upstream issues [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590), PR [#595](https://github.com/Natizyskunk/vscode-sftp/pull/595)).
* Fix : Reconnect automatically after a server-side SFTP channel termination instead of hanging (upstream PR [#582](https://github.com/Natizyskunk/vscode-sftp/pull/582)).
* Fix : "Error: Config Not Found" on save when the reported path casing differs from the workspace one on Windows (related to upstream PR [#447](https://github.com/Natizyskunk/vscode-sftp/pull/447)).
* Fix : Reload configuration when sftp.json changes outside the editor, e.g. a git branch switch (upstream PR [#494](https://github.com/Natizyskunk/vscode-sftp/pull/494)).
* Security : Never upload `.vscode/sftp.json` (credentials) to the server, regardless of the user ignore config.
* Fix : Ignore patterns now work on Windows (gitignore matching received `\`-separated paths).
* Fix : Recover UTF-8 file names in FTP listings decoded as latin1 (garbled non-ASCII directories, upstream PR [#443](https://github.com/Natizyskunk/vscode-sftp/pull/443)).
* Fix : Retry STOR once after a 550 rejection over an existing file (proftpd mod_rename servers, upstream issue [#420](https://github.com/Natizyskunk/vscode-sftp/issues/420)).
* Fix : uploadOnSave handler robustness (wrong "download" log label, unhandled ENOENT when the file disappears right after saving).
* Chore : Repair the test infrastructure (Jest 29 transformer, memfs 4 on Node 22) and clean up all pre-existing tslint violations.

## 1.16.3 - 2023-06-16
* [#356] New Feature : Upload to all profiles (Pull request [#313](https://github.com/Natizyskunk/vscode-sftp/pull/313) from @wewawa vscode-sftp:create_multi_command).
* [#357] Fix : Correcting Typo 'avaliable' => 'available' (Pull request [#343](https://github.com/Natizyskunk/vscode-sftp/pull/343) from @kjo-sdds vscode-sftp:develop).
* [#358] Permissions : Add filePerm and dirPerm options for configuring permissions (Pull request [#347](https://github.com/Natizyskunk/vscode-sftp/pull/347) from @Jchase2 vscode-sftp:develop).
* [#359] Fix : Correcting sftp connection with public key (Pull request [#350](https://github.com/Natizyskunk/vscode-sftp/pull/350) from @inu1255 vscode-sftp:develop).
* Upgrade `ssh2` version to official v1.13.0 by @mscdex.

## pre-1.16.2 - 2022-11-30
* [#271] Fix case change of file name not sent correctly (Pull request [#249](https://github.com/Natizyskunk/vscode-sftp/pull/249) from @NyaPPuu vscode-sftp:fix_rename).
* [#272] Update npm `types/node` depedency to v9.6.51.

## 1.16.1 - 2022-11-02
* [#251] Add multiple select + Update `Download File` & `Downalod Folder` commands to the remote view + Add `Upload File` & `Upload Folder` commands to the remote view (Pull request [#221](https://github.com/Natizyskunk/vscode-sftp/pull/221) from @NyaPPuu vscode-sftp:add_multiple_select).

## 1.16.0 - 2022-10-29
* [#242] Add order option and fix typos in docs (Pull request [#157](https://github.com/Natizyskunk/vscode-sftp/pull/157) from @NyaPPuu vscode-sftp:add_order_option).
* [#243] Fix refresh when creating/deleting file/folder + Fix 'Reveal in Remote Explorer' and Refresh Button in Remote Explorer. (Pull request [#159](https://github.com/Natizyskunk/vscode-sftp/pull/159) from @NyaPPuu vscode-sftp:fix_refresh).
* [#244] Cleanup Text in Markdown Files (Pull request [#213](https://github.com/Natizyskunk/vscode-sftp/pull/213) from @BrayFlex vscode-sftp:develop).

## 1.15.20 - 2022-08-28
* Fix typo 'worksapce' to 'workspace' (Pull request [#158](https://github.com/Natizyskunk/vscode-sftp/pull/158) from @NyaPPuu vscode-sftp:fix_typo).
* Add `Download File` & `Downalod Folder` commands to the remote view (Thanks to @mrandrey on issue #97).
* Update npm `types/fs-extra` depedency to v9.0.13 (Pull request [#204](https://github.com/Natizyskunk/vscode-sftp/pull/204) from @dependabot vscode-sftp:dependabot/npm_and_yarn/types/fs-extra-9.0.13).
* Update npm `typescript-tslint-plugin` depedency to v1.0.2 (Pull request [#206](https://github.com/Natizyskunk/vscode-sftp/pull/206) from @dependabot vscode-sftp:dependabot/npm_and_yarn/typescript-tslint-plugin-1.0.2).
* Update npm `tslint` depedency to v6.1.3 (Pull request [#207](https://github.com/Natizyskunk/vscode-sftp/pull/207) from @dependabot vscode-sftp:dependabot/npm_and_yarn/tslint-6.1.3).
* Update npm `ts-loader` depedency to v9.4.1 (Pull request [#208](https://github.com/Natizyskunk/vscode-sftp/pull/208) from @dependabot vscode-sftp:dependabot/npm_and_yarn/ts-loader-9.4.1).
* Update npm `typescript` depedency to v3.9.7.
* Update npm `jest` depedency to v29.0.3.

## 1.15.19 - 2022-08-26
* [#72] Change `uploadOnSave` default value from true to false.

## 1.15.18 - 2022-08-26
* Update npm `async` depedency to v3.2.4.
* Update npm `fs-extra` depedency to v10.1.0.
* Update npm `tmp` depedency to v0.2.1.
* Update npm `upath` depedency to v2.0.1.

## 1.15.17 - 2022-08-26
* Upgrade `ssh2` version to official v1.11.0 by @mscdex.

## 1.15.16 - 2022-05-26
* Reorder cipher and serverHostKey algorithms.
* Update [FAQ.md](https://github.com/Natizyskunk/vscode-sftp/blob/master/FAQ.md), and [documentations](https://github.com/Natizyskunk/vscode-sftp/tree/master/docs).

## 1.15.15 - 2022-08-21
* Fix "Open SSH in Terminal" not working because "terminal.integrated.shell.windows" is deprecated and fix typo `src/commands/commandOpenSshConnection.ts`. (Pull request [#155](https://github.com/Natizyskunk/vscode-sftp/pull/155) from @mean-cj vscode-sftp:patch-2).

## 1.15.14 - 2022-05-06
* Update npm `async` depedency to v2.6.4.
* Update npm `minimist` depedency to v1.2.6.

## 1.15.13 - 2022-02-11
* Add support for OpenSSH v8.8 SSH private key by using SHA-2 instead of SHA-1 to fix SSH public key signatures. (See issue [#112](https://github.com/Natizyskunk/vscode-sftp/issues/112)).

## 1.15.12 - 2022-02-11
* Add deletions support to "Upload Changed files" command. (Pull request [#113](https://github.com/Natizyskunk/vscode-sftp/pull/113) from @brykov vscode-sftp:master merged inside [#117](https://github.com/Natizyskunk/vscode-sftp/pull/117)).

* ## 1.15.11 - 2022-02-09
* Enhance sftp interactiveAuth mode (See [Wiki](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration#interactiveauth)). (Pull request [#94](https://github.com/Natizyskunk/vscode-sftp/pull/94) from @lacastorine vscode-sftp:lacastorine merged inside [#114](https://github.com/Natizyskunk/vscode-sftp/pull/114)).

## 1.15.10 - 2021-11-22
* Update npm `json-schema` devDepedency to v0.2.3.

## 1.15.9 - 2021-11-21
* Remove ssh configuration bug introduced in pull request [#69](https://github.com/Natizyskunk/vscode-sftp/pull/69) from @clemyan while we can find another solution.

## 1.15.8 - 2021-11-12
  * Fix 'Upload Changed Files' & 'No Such File' bugs (Commit [fix upload changed files](https://github.com/wandway/vscode-sftp/commit/775016788e4c59db901dc68a20c1f61ebcca7bc7#diff-20516d8841b4891f1926f1e40e447e99e0575a5e36ba6814f6b85b45db1b8fbb) from @wandway vscode-sftp:master).
  * Make the 'Upload Changed Files' command visible and add a default keyboard shortcut (Ctrl+Alt+U) to call it (Merged pull request [#84](https://github.com/Natizyskunk/vscode-sftp/pull/84) from @PaPa31 vscode-sftp:master). See [FAQ](https://github.com/Natizyskunk/vscode-sftp/blob/master/FAQ.md#clicking-upload-changed-files-does-not-work)).
  * Update Webpack from 4.39.2 to 5.0.0.
  * Update Webpack-cli from 3.3.7 to 4.7.0.

## 1.15.7 - 2021-11-12
  * Upgrade `ssh2` version to official v1.5.0 by @mscdex.

## 1.15.6 - 2021-10-27
  * Fix ssh configuration resolution (Merged pull request [#69](https://github.com/Natizyskunk/vscode-sftp/pull/69) from @clemyan vscode-sftp:fix-ssh-config).

## 1.15.5 - 2021-10-27
  * Update mtime after file was saved before upload (Merged pull request [#75](https://github.com/Natizyskunk/vscode-sftp/pull/75) from @viperet vscode-sftp:save_before_upload_mtime).
  * Add pull request issue template.
  * Add funding/sponsors page.
  * Add code scanning alert.

## 1.15.4 - 2021-10-04
  * Remove error message when calling sftp.sync.remoteToLocal command in vscode tasks.json.

## 1.15.3 - 2021-09-10
  * Upgrade `ssh2` version to official v1.4.0 bcy @mscdex.

## 1.15.2 - 2021-08-24
  * Fix the `useTempFile` bug (Merged pull request [#41](https://github.com/Natizyskunk/vscode-sftp/pull/41) from @kripper vscode-sftp:master).
  * Change `useTempFile` default value from true to false.
  * Fix the "Cannot read property 'handle' of undefined" bug (related to `useTempFile` bug) [TypeError: Cannot read property 'handle' of undefined](https://github.com/Natizyskunk/vscode-sftp/issues/43).
  * Fix the "fd argument must be of type number. Received undefined" bug (related to `useTempFile` bug) [TypeError since last update (The "fd" argument must be of type number.)](https://github.com/Natizyskunk/vscode-sftp/issues/34).
  * Fix the "Permission denied" bug when uploading.
  * New option [openSsh](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration#openssh) (Pull request [#42](https://github.com/Natizyskunk/vscode-sftp/pull/42) from @kripper vscode-sftp:atomic-rename merged inside [#45](https://github.com/Natizyskunk/vscode-sftp/pull/45)).
  * Update of the wiki to add support for openSsh option.

## 1.15.1 - 2021-08-24
  * Add the `useTempFile` option to the test configuration spec.
  * Fix get target mode error && add more precise logger-infos for tranfer tasks (Merged pull request [#29](https://github.com/Natizyskunk/vscode-sftp/pull/29) from @kripper vscode-sftp:master).

## 1.15.0 - 2021-08-23
  * New option [useTempFile](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration#usetempfile) (Merged pull request [#29](https://github.com/Natizyskunk/vscode-sftp/pull/29) from @kripper vscode-sftp:master).
  * Update of the wiki to add support for useTempFile option.

## 1.14.0 - 2021-08-06
  * Update of the FAQ to add support for old/legacy systems.
  * switching from beta to stable.

## 1.14.0-beta - 2021-07-15
  * Add `create remote file` and `create remote folder` commands (Merged pull request [#18](https://github.com/Natizyskunk/vscode-sftp/pull/18) from @mathsgod vscode-sftp:master).

## 1.13.6 - 2021-07-15
  * Fix syntax in `src\fileHandlers\transfer\__tests__\transfer-test.ts`.

## 1.13.5 - 2021-07-10
  * Reorder test parameters for `keepalive`.
  * Add v1.13.5-beta. Only use beta version if you still encounter the "REQUEST_FAILURE" error like described in those two issues : [Buffering on save file after 15 minute](https://github.com/Natizyskunk/vscode-sftp/issues/7) & [Infinite spinner on file save after server rest connection with client](https://github.com/Natizyskunk/vscode-sftp/issues/8).

## 1.13.4 - 2021-07-10
  * Fix "Error with the transfer direction."
  * Add loggers for transfer informations.

## 1.13.3 - 2021-07-09
  * re-add braces >=2.3.1 to package.json.
  * re-add yargs-parser ^20.2.4 to package.json.
  * Remove `yarn.lock`.
  * Add `package-lock.json`.
  * Fix Writing CHANNEL_DATA (0) / Writing FSETSTAT (Merged pull request [#12](https://github.com/Natizyskunk/vscode-sftp/pull/12) from @zarausto vscode-sftp:patch-1).
  * Fix transfer-test for Windows platform (Merged pull request [#11](https://github.com/Natizyskunk/vscode-sftp/pull/11) from @alex1504 vscode-sftp:fix-transfer-test).

## 1.13.2 - 2021-07-07
  * remove braces >=2.3.1 to package.json.
  * remove yargs-parser ^20.2.4 to package.json.
  * Remove the fix for the "No such file" error on VSCode 1.56 since it's been implementend in the new ssh2 v1.1.0 npm package (Commit [SFTP: explicitly set autoClose option for node 14+](https://github.com/mscdex/ssh2/commit/c0de05d186065ad4081b98d2f7aa0fe22161ec09) from @mscdex ssh2:master).

## 1.13.1 - 2021-07-06
  * Add braces >=2.3.1 to package.json.
  * Add node-notifier >=8.0.1 to package.json.
  * Add yargs-parser ^20.2.4 to package.json.
  * Changing publisher and repo links.
  * Fixed error "No such file" on VSCode 1.56.
  * Fixed issue with uploading of file which has unsaved changes.

## 1.13.0 - 2021-07-06
  * Upgrade `ssh2` version to official v1.1.0 by @mscdex.

## 1.12.10 - 2021-05-15
  * Improve sftp reliability.

## 1.12.3 - 2019-04-27
  * Minor improvements.
  * Bug fix.

## 1.12.1 - 2019-03-28
  * Fix [#510](https://github.com/liximomo/vscode-sftp/issues/510).

## 1.12.0 - 2019-03-21
  * new option [sshCustomParams](https://github.com/liximomo/vscode-sftp/wiki/SFTP-only-Configuration#sshcustomparams).

## 1.11.0 - 2019-03-15
  * Save before upload.
  * Fix [#490](https://github.com/liximomo/vscode-sftp/issues/490).

## 1.9.4 - 2019-02-26
  * Fix sshConfig file not work.
  * Open SSH in Terminal can enter to remote path.

## 1.9.3 - 2019-01-30
  * New icon for RemoteExplorer. Thanks [niccolomineo](https://github.com/niccolomineo) and [jonbp](https://github.com/jonbp).
  * Change `port` to number in the generated configuration.

## 1.9.2 - 2019-01-22
  * Fix [#388](https://github.com/liximomo/vscode-sftp/issues/388).
  * Fix [#456](https://github.com/liximomo/vscode-sftp/issues/456).
  * Fix [#459](https://github.com/liximomo/vscode-sftp/issues/459).

## 1.9.0 - 2019-01-08
  * Control files and folders to show or hide in Remote Explorer by `remoteExplorer.filesExclude`. [#410](https://github.com/liximomo/vscode-sftp/issues/410).
  * Suport new OpenSSH key format. [#391](https://github.com/liximomo/vscode-sftp/issues/391).
  * Improve performance.

## 1.8.4 - 2018-12-16
  * Fix ignore not work when use profile. [#428](https://github.com/liximomo/vscode-sftp/issues/428).

## 1.8.3 - 2018-12-14
  * Upgrade VSCode engine version.

## 1.8.2 - 2018-12-13
  * Add **Collapse All** action to RemoteExplorer.

## 1.8.0 - 2018-12-06
  * New command [Upload Changed Files](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-upload-changed-files).
  * Fix bugs.

## 1.7.6 - 2018-11-22
  * Reduce *80%* startup time.
  * Fix [#396](https://github.com/liximomo/vscode-sftp/issues/396).

## 1.7.5 - 2018-11-15
  * Fix [#394](https://github.com/liximomo/vscode-sftp/issues/394).

## 1.7.4 - 2018-11-09
  * Fix [#362](https://github.com/liximomo/vscode-sftp/issues/362).
  * Don't upload the file when it's in downloading. [#390](https://github.com/liximomo/vscode-sftp/issues/390).

## 1.7.3 - 2018-11-03
  * New configuration [limitOpenFilesOnRemote](https://github.com/liximomo/vscode-sftp/wiki/Configuration#limitopenfilesonremote).
  * Show `upload file` context menu in SCM.

## 1.7.2 - 2018-10-29
  * New command [Open SSH in Terminal](https://github.com/liximomo/vscode-sftp/wiki/Commands#open-ssh-in-terminal).

## 1.7.1 - 2018-10-25
  * New setting [downloadwhenopeninremoteexplorer](https://github.com/liximomo/vscode-sftp/wiki/Setting#downloadwhenopeninremoteexplorer).
  * fix some bugs.

## 1.7.0 - 2018-10-19
### New Features
  * New command [Upload Active Folder](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-upload-active-folder).
  * New command [Download Active Folder](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-download-active-folder).
  * New command [List Active Folder](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-list-active-folder).
  * New command [Cancel All Transfers](https://github.com/liximomo/vscode-sftp/wiki/Commands#cancel-all-transfers).
  * New configuration [remotetimeoffsetinhours](https://github.com/liximomo/vscode-sftp/wiki/Configuration#remotetimeoffsetinhours).

## 1.6.0 - 2018-10-12
### New Features
  * New command [Sync Local -> Remote](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-sync-local---remote).
  * New command [Sync Remote -> Local](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-sync-remote---local).
  * New command [Sync Both Directions](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-sync-both-directions).
  * New configuration [syncOption](https://github.com/liximomo/vscode-sftp/wiki/Configuration#syncoption) for `Sync` command.

### Breaking Changes
  * Remove Command `SFTP: Sync To Remote`.
  * Remove Command `SFTP: Sync To Local`.
  * Remove configuration option `syncModel`.

## 1.5.13 - 2018-10-08
* Fix [#344](https://github.com/liximomo/vscode-sftp/issues/344).

## 1.5.12 - 2018-10-07
* New command `Diff Active File with Remote`.
* Command `Set Profile` can receive an argument from keybindings.

  ```json
  {
    "key": "ctrl+shift+cmd+d",
    "command": "sftp.setProfile",
    "args": "dev"
  }
  ```

## 1.5.10 - 2018-09-28
* Fix [#332](https://github.com/liximomo/vscode-sftp/issues/332).

## 1.5.9 - 2018-09-27
* Fix [#330](https://github.com/liximomo/vscode-sftp/issues/330).

## 1.5.8 - 2018-09-25
* Show name in the remote explorer. [#315](https://github.com/liximomo/vscode-sftp/issues/315).
* Fix [#308](https://github.com/liximomo/vscode-sftp/issues/308).

## 1.5.0 - 2018-09-13
### New Features
  * new [alt commands](https://github.com/liximomo/vscode-sftp#alt-commands) `Force Download` and `Force Upload`. This allow you to download/upload files but disregard ignore rules.

### Breaking Changes
  * Rename command `sftp.trans.remote(SFTP: Upload)` to `sftp.upload.activeFile` and command `sftp.trans.local(SFTP: Download)` to `sftp.download.activeFile`. Please update your keybinding if you've used one of these commands.

### Deprecated
  * Commands `SFTP: List` and `SFTP: List All` will be removed in favor of `Remote Explorer` in next release.

## 1.4.1 - 2018-09-03
### Feature
  * [Configuration in User Setting](https://github.com/liximomo/vscode-sftp#configuration-in-user-setting) Configuration your remote in User Setting.

### Fix
  * Fix sshConfig file not overwriting default configuration. [#305](https://github.com/liximomo/vscode-sftp/issues/305).

## 1.4.0 - 2018-08-27
### Feature
  * [Connection Hopping](https://github.com/liximomo/vscode-sftp#connection-hopping) allow you to connection to a target server through a proxy with ssh protocol.

## 1.3.9 - 2018-08-14
* Fix [#286](https://github.com/liximomo/vscode-sftp/issues/286).
* Fix [#287](https://github.com/liximomo/vscode-sftp/issues/287).

## 1.3.8 - 2018-08-13
* Fix [#285](https://github.com/liximomo/vscode-sftp/issues/285).

## 1.3.7 - 2018-08-10
* Fix bug in `remoteExplorer.refresh`.

## 1.3.0 - 2018-08-02
### New Features
  * [Remote Explorer](https://github.com/liximomo/vscode-sftp#remote-explorer).

## 1.2.7 - 2018-07-27
### New Features
  * `ignoreFile` [option](https://github.com/liximomo/vscode-sftp/wiki/Configuration#ignorefile).

## 1.2.3 - 2018-06-19
### New Features
  * [Swtichable Profiles](https://github.com/liximomo/vscode-sftp/#profiles).

## 1.2.0 - 2018-06-19
* Support [SSH configuration file](https://www.ssh.com/ssh/config/). The default ssh configuration file is `~/.ssh/config`. This can be changed by `sshConfigPath` option.

## 1.1.12 - 2018-06-08
* Fix [#200](https://github.com/liximomo/vscode-sftp/issues/200). Thanks for [Gergo Koos](https://github.com/gergokoos).

## 1.1.11 - 2018-05-21
* Fix [#198](https://github.com/liximomo/vscode-sftp/issues/198).

## 1.1.10 - 2018-05-18
* Show open folder prompt in `sftp:config` command.
* Fix [#174](https://github.com/liximomo/vscode-sftp/issues/174).

## 1.1.9 - 2018-05-17
* Add `confirm` option to `downloadOnOpen`.
* Fix [#160](https://github.com/liximomo/vscode-sftp/issues/160).
* Fix [#195](https://github.com/liximomo/vscode-sftp/issues/195).

## 1.1.8 - 2018-05-15
* Some UX improvements.
    * Only show `sftp` menu when extension get activated (Thanks [@mikolino](https://github.com/mikolino)).
    * Remove some unnecessary warning.
* Improve ftp reliability.
* Upgrade `ssh2` version.

## 1.1.7 - 2018-03-31
* `name` [configuration](https://github.com/liximomo/vscode-sftp#full-config).
* Fix bugs.

## 1.1.6 - 2018-03-24
* Better procedure message in status bar.
* Fix sync error when synced target is not exist.
* Fix [#146](https://github.com/liximomo/vscode-sftp/issues/146).

## 1.1.5 - 2018-03-23
* Improve stability of `ftp` protocol.
* Fix document don't show automatically after select a file through `list` command.
* Fix [#113](https://github.com/liximomo/vscode-sftp/issues/113).

## 1.1.4 - 2018-03-21
* `connectTimeout` [config](https://github.com/liximomo/vscode-sftp#full-config).
* `downloadOnOpen` [config](https://github.com/liximomo/vscode-sftp#full-config).
* Fix ftp unexpectedly traverse up director [#80](https://github.com/liximomo/vscode-sftp/issues/80). Thanks for [Andrey Orst](https://github.com/andreyorst)'s help.

## 1.1.3 - 2018-03-18
* Remove default ignore configuration. No files will be ignored if you don't explicitly configuration `ignore` option. Related isuse [#138](https://github.com/liximomo/vscode-sftp/issues/138).
* Fix [#133](https://github.com/liximomo/vscode-sftp/issues/133).
* Fix [#136](https://github.com/liximomo/vscode-sftp/issues/136).


## 1.1.0 - 2018-03-13
* `diff` command.
* Fix [#113](https://github.com/liximomo/vscode-sftp/issues/113).
* Fix [#124](https://github.com/liximomo/vscode-sftp/issues/124).

## 1.0.5 - 2018-02-24
* Support [multi select in the Explorer](https://code.visualstudio.com/updates/v1_20#_multi-select-in-the-explorer).
* Fix some bugs.

## 1.0.4 - 2018-02-08
* New configuration option `concurrency`.
* New configuration option `algorithms`.
* Fix [#103](https://github.com/liximomo/vscode-sftp/issues/103).

## 1.0.3 - 2018-02-05
* Simplify default configuration file's content when exec `sftp: config`.
* Configuration autocomplete.
* Fix watcher stop work after 'download' or 'sync to local'.

## 1.0.2 - 2018-01-30
* Add FTPS support.
* Add passphrase/password dialog support.
* Fix configuration not found error after configuration file changed.
* Fix `sftp config` failed to show created configuration file in vscode.

## 1.0.0 - 2018-01-26
🎉🎉🎉This release include some new features, bugfixs and improvements. It may be bring some new bugs, welcome to feedback.

### New Features
* `list` and `list all` command.
  * `list` will list all remote files except those match your ignore rules.
  * `list all` will list all remote files.

  The target will be dowmload after you select. And it will be open in vscode if the target is a file.
* When you download a folder through a command, the vscode explorer will be refreshed when the command finish.

### Breaking Changes
* Change to git ignore [spec](https://git-scm.com/docs/gitignore). It's more powerful and concise. You may need to change your ignore configuration.


## 0.9.4 - 2017-12-18
* `Context` now receives a relative path.
* Fix [#69](https://github.com/liximomo/vscode-sftp/issues/69), [#70](https://github.com/liximomo/vscode-sftp/issues/70).

## 0.9.0 - 2017-12-16
* Add a option to configuration a local path that correspond to a remote path.
* Support multiple configurations in one configuration file.
* Remove `.sftpConfig.json` configuration file support.
* Remove none-worksapce-root configuration files support.

## 0.8.11 - 2017-11-30
* Fix ftp can't preserve file permissions.

## 0.8.10 - 2017-11-20
* Disable create configuration at none-workspace-root-folder.

## 0.8.9 - 2017-11-17
* Preserve file permissions.
* Better README thanks [kataklys](https://github.com/kataklys).
* Fix Empty (0kb) files when download and uplaod. Thanks for [kataklys](https://github.com/kataklys)'s help ([#33](https://github.com/liximomo/vscode-sftp/issues/33))
* Show a waring for existing none-worksapce-root configuration files. Previously you can create multiple configuration files anywhere under workspace. So you won't need to open multiple vscode instances to make `sftp` working in different folders. Sincle vscode support [Multi-root Workspaces](https://code.visualstudio.com/docs/editor/multi-root-workspaces). There is no necessary to support multiple configuration now. This will make `sftp` both simple and a bettern starup performace.

## 0.8.8 - 2017-11-11
### Bugfix
* Files is not correctly filtered at configuration setup.

## 0.8.7 - 2017-11-07
### Bugfix
* Configuration setup not work for directories whose name does end with `.vscode`.

## 0.8.6 - 2017-11-06
* Performance improvement.
* Show a waring to the old `.sftpConfig.json` file.

### Behaviour Change
Now `uploadOnSave` only happens on a vscode save opetarion. It used to happen on a disk save opetarion caused by anything.

## 0.8.5 - 2017-10-18
### Improvement
* support more cipher algorithms.

## 0.8.4 - 2017-10-10
### Improvement
* log more infos to output pannel.

## 0.8.3 - 2017-09-26
### Bugfix
* fix couldn't create configuration through file picker when no sub files in the directory.

## 0.8.2 - 2017-09-24
### Enhance
* Don't need to reload vscode after execute `SFTP: config` command.
* `SFTP: config` creates `sftp.json` now.

## 0.8.1 - 2017-09-22
### Bugfix
* WIN could not find configuration(path is not normalized).

## 0.8.0 - 2017-09-22
### Feature
* support multi-root workspace.

### Change
* Configuration file name is changing to `sftp.json` from `.sftpConfig.json` for concision.

### Bugfix
* fix a bug that always return the same ssh session when have multiple configurations in workspace.

## 0.7.11 - 2017-09-13
### Bugfix
* fix tribe retrive.

## 0.7.10 - 2017-09-13
### Bugfix
* fix configuration not found when have multiple configuration files in workspace.

## 0.7.9 - 2017-09-01
### Bugfix
* change tip text from uploading to sync when download and upload.

## 0.7.8 - 2017-08-20
### Bugfix
* Fix `command not found error` when no folder opened.

## 0.7.7 - 2017-07-25
### Bugfix
* Fix folder match of ignore.

## 0.7.6 - 2017-07-24
### Bugfix
* Fix [files in "ignored" directories are still uploaded](https://github.com/liximomo/vscode-sftp/issues/15). Thanks for [Tom Spence](https://github.com/tomjaimz)'s help.

## 0.7.5 - 2017-07-18
### Feature
* A new editor configuration `sftp.printDebugLog`, dafault with false.

## 0.7.4 - 2017-07-14
### Enhance
* Configuration validation failing at startup does not require a reload to make extension work.

## 0.7.3 - 2017-07-13
### Feature
* Configuration validation.

### Misc
* More accurate watcher description.

## 0.7.2 - 2017-07-04
### Feature
* Add a way to execute commands on all detected configuration root folders.(run commands throw command palette)

## 0.7.1 - 2017-07-04
### Bugfix
* Fix miss files because of throttle.

## 0.7.0 - 2017-06-30
### Breaking Change
* Now configuration files are located in .vscode folder. Just move every .sftpConfig.json to the .vscode folder of same hierarchy.

## 0.6.14 - 2017-06-29
### Enhance
* show authentication input as asterisk.

## 0.6.13 - 2017-06-28
### Feature
* ssh agent authentication.

## 0.6.12 - 2017-06-26
### Feature
* Interactive authentication.

## 0.6.11 - 2017-06-22
### Feature
* Ignore works for download/sync remote file to local.

## 0.6.10 - 2017-06-13
### Enhance
* Better log.

## 0.6.9 - 2017-06-11
### Bugfix
* Remove unnecessary error message.
* Sync blocks on symlink.

## 0.6.8 - 2017-06-09
### Enhance
* Activate the extension only when it needs to. You must have the vscode greater than 1.13.0.

## 0.6.7 - 2017-06-07
### Enhance
* Keeping active so you don't have to reload vscode to active sftp when create configuration file at the first time.

## 0.6.6 - 2017-06-06
### Bugfix
* Window can't auto create dir non-existing.

## 0.6.2 - 2017-06-05
### Bugfix
* Incorrectly configuration not found error popup.

## 0.6.1 - 2017-06-03
### Bugfix
* Don't watch file when there is no .sftpConfig file.

## 0.6.0 - 2017-06-02
### Feature
* Support ftp.

### Feedback
* More debug info.

### Bugfix
* Fix `SFTPFileSystem.rmdir` doesn't resolve correctly.
* Disable watcher on pulling files.
* Make true re-connect when it need to.

## 0.5.4 - 2017-05-30
### Feedback
* Better error log.
* Output debug info in sftp output channel.

### Bugfix
* Fix some files missed uploading when they has updated because of throttle.

## 0.5.3 - 2017-05-26
### Feature
* AutoSave now works even in external file update!🎉🎉🎉
* A new configuration `watcher`. Now there is a way to perceive external file change(create, delete).

## 0.5.2 - 2017-05-22
### Bugfix
* Running a command through shortcut couldn't find active document correctly.

### Feedback
* Show path that is relative to the workspace root instead of full path on status bar.

## 0.5.1 - 2017-05-22
### Enhance
* Provide a way to run command at the workspace root.

## 0.5.0 - 2017-05-19
### Feature
* Keep ssh connect alive (re-connect only when needed).

## 0.4.12 - 2017-05-18
### Bugfix
* Fix binary file upload.

## 0.4.11 - 2017-05-18
### Feedback
* Better status indication.

## 0.4.10 - 2017-05-18
### Bugfix
* Configuration file not found in windows.
* Check existence of privateKeyPath.

## 0.4.0 - 2017-05-17
### Configuration
* Add option `syncModel`.

### Command
* New command Upload.
* New command Download.
