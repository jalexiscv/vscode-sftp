# SFTP — sync extension for VS Code (fixed fork)

🌍 [Español](README.md) (base) · **English** · [中文（简体）](README.zh-CN.md) · [Português (BR)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

[![Release](https://img.shields.io/github/v/release/jalexiscv/vscode-sftp)](https://github.com/jalexiscv/vscode-sftp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Issues](https://img.shields.io/github/issues/jalexiscv/vscode-sftp)](https://github.com/jalexiscv/vscode-sftp/issues)

**Fixed fork, maintained by [@jalexiscv](https://github.com/jalexiscv)**, of the popular SFTP/FTP sync extension.<br>
Lineage: fork of [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), itself a fork of the no-longer-maintained [SFTP plugin by liximomo](https://github.com/liximomo/vscode-sftp.git).

- 📦 **Installation (VSIX releases):** https://github.com/jalexiscv/vscode-sftp/releases
- 🐛 **Report issues:** https://github.com/jalexiscv/vscode-sftp/issues
- 📄 **Full change history:** [CHANGELOG.md](CHANGELOG.md)

VSCode-SFTP lets you add, edit, or delete files in a local directory and sync them with a directory on a remote server using different transfer protocols such as FTP or SSH. The most basic setup requires only a few lines, with a wide range of specific options available to cover any user's needs. Powerful and fast at the same time, it helps developers save time by letting them use a familiar editor and environment.

## 📑 Table of Contents

- [Why this fork exists](#why-this-fork-exists)
- [What we updated](#what-we-updated)
- [What's new in v1.24.0](#whats-new-in-v1240)
- [What we expect from this release](#what-we-expect-from-this-release)
- [Installation](#installation)
- [Documentation](#documentation)
- [Usage](#usage)
- [Example configurations](#example-configurations)
- [Remote Explorer](#remote-explorer)
- [Debugging](#debugging)
- [FAQ](#faq)
- [Credits and support for the original authors](#credits-and-support-for-the-original-authors)
- [License](#-license) · [Author](#-author) · [Donations](#%EF%B8%8F-donations)

---

## Why this fork exists

We released this version because the original project, excellent as it was, reached a point where it could no longer serve its users:

1. **The upstream project is effectively unmaintained.** Its maintainer stated in March 2025 that he could no longer keep working on it and that [v1.16.3 (June 2023)](https://github.com/Natizyskunk/vscode-sftp/releases/tag/v1.16.3) should be considered the last stable version. Since then, ~600 issues have piled up without a fix.
2. **The extension broke on modern VS Code.** Recent VS Code builds ship a Node.js runtime in which the bundled `ssh2` 1.13 dependency fails with `TypeError: isDate is not a function`, causing every SFTP operation to fail — the project's most reported bug (upstream [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590)).
3. **The upstream development branch didn't even compile.** Its `develop` branch had TypeScript compilation errors and a broken test suite, so community fixes (several submitted as pull requests years ago) had no path to being published.
4. **There was an unresolved security issue.** With the default configuration, syncing a project could upload `.vscode/sftp.json` — with the server's host, username, and password — to the remote server, often inside a public docroot.

Rather than letting a tool used by thousands of developers degrade, we forked it, repaired its foundations (build, tests, linter), fixed the most reported bugs, and committed to keeping it working.

## What we updated

Every fix was verified (clean webpack build, 701 tests, linter with no errors) before being published. The details of each change live in [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

### [v1.16.4](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.4) — foundations and critical fixes

| Area | Fix |
|------|-----|
| **Compatibility** | `ssh2` updated to 1.17.0: fixes *"isDate is not a function"* on modern VS Code and enables modern OpenSSH key formats and rsa-sha2 algorithms (upstream [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590), PR [#595](https://github.com/Natizyskunk/vscode-sftp/pull/595)) |
| **Security** | `.vscode/sftp.json` (credentials) can never be uploaded to the server anymore, regardless of the `ignore` configuration |
| **Reliability** | Automatic reconnection after a server-side SFTP channel close, instead of hanging indefinitely (upstream PR [#582](https://github.com/Natizyskunk/vscode-sftp/pull/582)) |
| **Windows** | Fixed *"Error: Config Not Found"* / `uploadOnSave` not working when the reported path casing differed from the workspace (upstream PR [#447](https://github.com/Natizyskunk/vscode-sftp/pull/447)) |
| **Windows** | `ignore` patterns now actually work (the gitignore matcher was receiving paths with `\` separators) |
| **Configuration** | `sftp.json` is reloaded when it changes outside the editor — e.g. a git branch switch (upstream PR [#494](https://github.com/Natizyskunk/vscode-sftp/pull/494)) |
| **FTP** | Non-ASCII file names (Chinese, accents) no longer arrive corrupted in listings (upstream PR [#443](https://github.com/Natizyskunk/vscode-sftp/pull/443), without its SFTP regression) |
| **FTP** | Overwrites rejected with 550 by proftpd servers with `mod_rename` are safely retried (upstream [#420](https://github.com/Natizyskunk/vscode-sftp/issues/420)) |
| **Build** | Restored code compilation, repaired the test infrastructure (Jest 29, Node 22), and cleaned up all pre-existing lint violations |

### [v1.16.5](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.5) — second round

| Area | Fix |
|------|-----|
| **SSH** | `Open SSH in Terminal` now uses the configured `hop` chain via OpenSSH ProxyJump (`-J`) (upstream [#441](https://github.com/Natizyskunk/vscode-sftp/issues/441)) |
| **Remote Explorer** | Remote symlinks pointing to directories are browsable over SFTP — e.g. `current -> releases/N` style deployments (upstream [#283](https://github.com/Natizyskunk/vscode-sftp/issues/283)) |
| **Notebooks** | `uploadOnSave` now triggers when saving notebook documents such as `.ipynb` |

### [v1.17.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.17.0) — secure passwords and CI

| Area | Change |
|------|--------|
| **Security** | **Secure password saving** with VS Code SecretStorage (the OS keychain): after a successful connection the extension offers to remember the typed password, injects it automatically on later connections and forgets it if the server rejects it. New `SFTP: Forget Saved Passwords` command and `sftp.promptToSavePassword` setting |
| **Quality** | GitHub Actions CI (lint, build and tests on every push/PR) and automated release packaging on tags |

### [v1.18.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.18.0) — modern FTP

| Area | Change |
|------|--------|
| **FTP** | **FTP backend migrated from the abandoned `ftp` package (~10 years unmaintained) to [`basic-ftp`](https://github.com/patrickjuchli/basic-ftp)**: native UTF-8, robust FTPS and reliable passive mode. Validated against a real FTPS server with a new integration test (`ftp` baseline: 7/8 with `read ECONNRESET`; `basic-ftp`: 8/8). Resolves the FTP bug cluster of the backlog (PASV, FTPS with FileZilla, non-ASCII names, ECONNRESET) |
| **Note** | `basic-ftp` supports passive mode only; FTP active mode (`passive: false`) is no longer supported |

### [v1.19.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.19.0) — connection manager

| Area | Change |
|------|--------|
| **UI** | **New Connection Manager** (`SFTP: Open Connection Manager`, also via the gear button of the Remote Explorer view): a graphical panel to create, edit, duplicate, delete, test and activate the connections/profiles of `sftp.json` without editing the JSON by hand. Saving reloads the services automatically; "Test connection" reuses the real connection machinery (including saved passwords) |
| **Quality** | TypeScript `strict` mode enabled (`noImplicitAny` deferred) and 26 real type errors fixed, including a latent crash in the profile state observer |

### [v1.20.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.20.0) — stable active profile and temp-file exclusion

| Area | Change |
|------|--------|
| **Transfers** | Any file or folder whose name contains `.tmp` is now permanently excluded from transfers (uploads, `uploadOnSave` and sync), on every server and without any `ignore` configuration |
| **Profiles** | The profile activated with `SFTP: Set Profile` or the Connection Manager no longer "switches by itself": reloads of `sftp.json` stop resetting it to `defaultProfile`, and the selection persists across VSCode restarts. `defaultProfile` becomes just the initial value and the fallback when the active profile disappears |

### [v1.22.0](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.22.0) — safe local-remote mirror

| Area | Change |
|------|--------|
| **Transfers** | Local scratch files are never uploaded: a built-in list excludes editor swap and backup files, Office lock files, merge leftovers, partial downloads and OS metadata, on every server and with no configuration (`ignoreTempFiles`, `tempFilePatterns`) |
| **Deletions** | Local deletions are mirrored to the server (`deleteRemoteOnLocalDelete`, on by default), with four safeguards: a modal confirmation above `deleteRemoteConfirmThreshold` (10), deletions caused by git discarded, self-suppression during `Sync Remote -> Local --delete`, and the remote trash |
| **Remote trash** | With `remoteTrash`, deleting is a server-side `rename` into a trash folder, reversible with `SFTP: Undo Last Remote Deletion` and `SFTP: Restore from Remote Trash`; `SFTP: Empty Remote Trash` purges it and expired entries are swept after `retentionDays` |
| **Renames** | `renameRemoteOnLocalRename` mirrors renames and moves as a server-side `rename`, without re-uploading and without any moment in which the path is missing on the server |
| **UI** | Activity view with the history of every transfer, deletion and rename, and retries (`sftp.showActivityView`); pause mode (`SFTP: Pause/Resume Auto Sync`) that suspends all automatic syncing |
| **Hardening** | Two adversarial review passes before shipping: git safeguard evaluated at queue time, a single deletion path, unsafe trash paths rejected, the deletion's profile honoured when restoring and purging, a purge that sweeps the remote directory itself |

## What's new in v1.24.0

v1.24.0 is about trust: knowing that what changed locally is on the server — even if another tool changed it, or you did with VS Code closed — and, when an upload does not arrive whole, being told and able to fix it with a click. Until now the extension *did* the uploads; now it also *proves* them.

| Feature | What it gives you |
|---------|-------------------|
| **External change detection** | A persistent sync index remembers, per server, which version of every file was last uploaded and verified. On startup, on `sftp.json` reload, on resume, on focus after five minutes and on demand (`SFTP: Scan for External Changes`), the local tree is compared with that index and whatever changed outside the editor — a `git pull` in a terminal, a code generator, edits made with VS Code closed — is uploaded through a plan, without listing the server. `watcher.pollInterval` adds periodic polling for network drives or Docker/WSL mounts. Keys: `externalChanges.scanOnStartup`, `scanOnResume`, `confirmThreshold` |
| **One change collector** | `uploadOnSave` and the watcher no longer upload the same save twice: editor saves go up immediately, external changes are batched (700 ms) and deduplicated by path. `uploadOnSave: false` is no longer needed when watching `**/*` |
| **Upload plans** | Every batch is a plan with its source, the reason per file (new, modified), status, attempts and error, shown in the "Upload plans" group of the activity view (upload the plan, upload/skip/diff per file, export the report, remove). `SFTP: Preview Upload (Dry Run)` shows what would be uploaded without uploading anything; `SFTP: Upload Plan`, `SFTP: Export Last Upload Report` (Markdown) and `SFTP: Clear Upload Plans` complete the set. The status bar shows `↑N` pending and `✗N` failed |
| **Upload verification** | Every upload counts the bytes sent and, with `verifyUpload: "stat"` (the default), checks that the remote size matches exactly (`SIZE` over FTP). `"hash"` additionally compares a digest (sha256/sha1/md5/crc32 via `sha256sum`/`shasum`/`openssl`/`md5sum` over SSH, or `XSHA256`/`XSHA1`/`XMD5`/`XCRC`/`HASH` over FTP) and falls back to `stat` when the server cannot compute one. A transient failure (network, timeout, verification) is retried (`uploadRetries`, 2) with an increasing delay before being reported with its reason; permanent errors (permission denied, missing source) are not retried |
| **Persistent activity log** | The activity view records every task — from a command, a save or the watcher — with its remote path and verification result, and survives window reloads (`activity-log.json`): the failures of the previous session can still be retried. Failures that happen before the transfer (connection, credentials, permissions) show up too |
| **Fixes** | `uploadFile()` now rejects when the transfer fails (the view could mark a broken upload as a success); the suppression of automatic sync during downloads and `Sync Remote -> Local` was unused; `dir/` patterns in `ignore` prune the subtree; protection against symlink loops; an index robust to corrupt files and failed `rename`s; numeric SFTP errors described; and more in the [CHANGELOG](CHANGELOG.md) |

### Safeguards and decisions

| Safeguard | Behaviour |
|-----------|-----------|
| **Confirmation threshold** | Above `externalChanges.confirmThreshold` (20 by default) nothing is uploaded without asking: a modal dialog lists the files and offers `Review plan` (the default; the plan stays pending in the view), `Upload N file(s)` or `Skip`. `Skip` is remembered: those files are not proposed again until they change |
| **Git awareness** | If HEAD moved between the change and the upload (checkout, pull, rebase, merge…) the batch always asks for confirmation, whatever its size: a branch switch never uploads hundreds of files by surprise |
| **New files** | An automatic batch that contains files the index has never seen always asks for confirmation, however small it is; only files already indexed and modified go up on their own below the threshold |
| **First use** | After installing, run `SFTP: Rebuild Sync Index` once per server (or upload the project once and run a manual scan) so the extension knows what is already on the server. Until then, automatic scans only re-upload files it has already uploaded itself; unindexed files are ignored and you are told once per server (`Build index now` / `Don't show again`). The rebuild indexes what matches in size between local and remote |
| **Hash degradation** | If the server cannot compute a digest (SFTP account without a shell, FTP without `XSHA256`/`HASH`…), the upload is verified by size with a one-time warning per connection; only a different digest is a failure |
| **On by default, nothing to configure** | Scanning on startup and resume, size verification and two retries are active; `externalChanges.scanOnStartup: false`, `scanOnResume: false`, `verifyUpload: "none"` and `uploadRetries: 0` bring the previous behaviour back |

## What we expect from this release

- **A drop-in replacement.** The same `sftp.json` format, the same commands, the same workflows — existing configurations work without any migration.
- **Stability on current tooling.** The extension must keep working on up-to-date VS Code builds and Node.js runtimes, which is exactly where the original broke.
- **Security by default.** Your credentials never leave your machine as part of a sync, even with a custom or empty `ignore` list.
- **A living project.** We will keep triaging the upstream backlog (requests such as SOCKS5 proxies, `.ppk` keys, or folder diff are candidates for upcoming rounds), and issues/PRs on [our tracker](https://github.com/jalexiscv/vscode-sftp/issues) are welcome.
- **Verifiable quality.** No release is published without a clean build, a green test suite, and a linter with no errors; every change is documented in [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

---

## Installation

> ⚠️ **Uninstall or disable any other SFTP extension first** (liximomo's or Natizyskunk's): they register the same `sftp.*` commands and will conflict with this one.

1. Download the latest `sftp-x.y.z.vsix` from the [Releases page](https://github.com/jalexiscv/vscode-sftp/releases).
2. In VS Code, open Extensions (Ctrl + Shift + X).
3. Open the "More Actions" menu (the ellipsis at the top) and choose "Install from VSIX…".
4. Locate the VSIX file and select it.
5. Reload VS Code.
6. Done!

Or from the command line:

```
code --install-extension sftp-1.24.0.vsix
```

## Documentation
- [Home](https://github.com/Natizyskunk/vscode-sftp/wiki)
- [Settings](https://github.com/Natizyskunk/vscode-sftp/wiki/Setting)
- [Common configuration](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration)
- [SFTP configuration](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration)
- [FTP configuration](https://github.com/Natizyskunk/vscode-sftp/wiki/FTP(s)-only-Configuration)
- [Commands](https://github.com/Natizyskunk/vscode-sftp/wiki/Commands)

> The upstream wiki remains the reference for settings and commands: this fork maintains full configuration compatibility.

## Usage
If the most recent files are already on a remote server, you can start with an empty local folder, download the project, and sync from there.

1. In `VS Code`, open the local directory you want to sync with the remote server (or create an empty directory where you first download the contents of a server folder to edit it locally).
2. Press `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on Mac to open the command palette and run the `SFTP: config` command.
3. A basic configuration file named `sftp.json` will appear inside the `.vscode` directory; open it and edit the parameters with your remote server's information.

For example:
```json
{
    "name": "Profile name",
    "host": "remote_server_host",
    "protocol": "ftp",
    "port": 21,
    "secure": true,
    "username": "username",
    "remotePath": "/public_html/project", // <--- This is the path that will be downloaded with "Download Project"
    "password": "password",
    "uploadOnSave": false
}
```
The `password` parameter in `sftp.json` is optional; if you omit it, you will be prompted for the password when syncing.
_Note:_ backslashes and other special characters must be escaped with a backslash.

4. Save and close the `sftp.json` file.
5. Press `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on Mac to open the command palette.
6. Type `sftp` and you will see the rest of the available commands. Many of them are also in the context menus of the project's file explorer.
7. A good one to start with, if you want to sync with a remote folder, is `SFTP: Download Project`: it downloads the directory specified in `remotePath` of `sftp.json` into your open local directory.
8. Done — you can now edit locally and, after each save, the file will be uploaded to keep the remote copy in sync with the local one.
9. Enjoy!

For detailed explanations visit the [wiki](https://github.com/Natizyskunk/vscode-sftp/wiki).

## Example configurations
You can see the full list of configuration options [here](https://github.com/Natizyskunk/vscode-sftp/wiki/configuration).

- [Simple](#simple)
- [Profiles](#profiles)
- [Multiple contexts](#multiple-contexts)
- [Connection hopping](#connection-hopping)
- [Configuration in User Settings](#configuration-in-user-settings)
- [Safe deletions and renames](#safe-deletions-and-renames)
- [External changes and upload verification](#external-changes-and-upload-verification)

### Simple
```json
{
  "host": "host",
  "username": "username",
  "remotePath": "/remote/workspace"
}
```

### Profiles
```json
{
  "username": "username",
  "password": "password",
  "remotePath": "/remote/workspace/a",
  "watcher": {
    "files": "dist/*.{js,css}",
    "autoUpload": false,
    "autoDelete": false
  },
  "profiles": {
    "dev": {
      "host": "dev-host",
      "remotePath": "/dev",
      "uploadOnSave": true
    },
    "prod": {
      "host": "prod-host",
      "remotePath": "/prod"
    }
  },
  "defaultProfile": "dev"
}
```

_Note:_ `context` and `watcher` are only available at the root level.

Use `SFTP: Set Profile` to switch profiles.

### Multiple contexts
The contexts **must not be the same**.
```json
[
  {
    "name": "server1",
    "context": "project/build",
    "host": "host",
    "username": "username",
    "password": "password",
    "remotePath": "/remote/project/build"
  },
  {
    "name": "server2",
    "context": "project/src",
    "host": "host",
    "username": "username",
    "password": "password",
    "remotePath": "/remote/project/src"
  }
]
```

_Note:_ `name` is required in this mode.

### Connection hopping
You can connect to a target server through a proxy with the ssh protocol.

_Note:_ variable substitution does not work inside a `hop` configuration.

#### Single hop
local -> hop -> target
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // hop
  "host": "hopHost",
  "username": "hopUsername",
  "privateKeyPath": "/Users/localUser/.ssh/id_rsa", // <-- The key file is assumed to be on the local machine.

  "hop": {
    // target
    "host": "targetHost",
    "username": "targetUsername",
    "privateKeyPath": "/Users/hopUser/.ssh/id_rsa", // <-- The key file is assumed to be on the hop.
  }
}
```

#### Multiple hops
local -> hopA -> hopB -> target
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // hopA
  "host": "hopAHost",
  "username": "hopAUsername",
  "privateKeyPath": "/Users/hopAUsername/.ssh/id_rsa" // <-- The key file is assumed to be on the local machine.

  "hop": [
    // hopB
    {
      "host": "hopBHost",
      "username": "hopBUsername",
      "privateKeyPath": "/Users/hopaUser/.ssh/id_rsa" // <-- The key file is assumed to be on hopA.
    },

    // target
    {
      "host": "targetHost",
      "username": "targetUsername",
      "privateKeyPath": "/Users/hopbUser/.ssh/id_rsa", // <-- The key file is assumed to be on hopB.
    }
  ]
}
```

### Configuration in User Settings
You can use `remote` to tell sftp to take the configuration from [remote-fs](https://github.com/liximomo/vscode-remote-fs).

In User Settings:
```json
"remotefs.remote": {
  "dev": {
    "scheme": "sftp",
    "host": "host",
    "username": "username",
    "rootPath": "/path/to/somewhere"
  },
  "projectX": {
    "scheme": "sftp",
    "host": "host",
    "username": "username",
    "privateKeyPath": "/Users/xx/.ssh/id_rsa",
    "rootPath": "/home/foo/some/projectx"
  }
}
```

In sftp.json:
```json
{
  "remote": "dev",
  "remotePath": "/home/xx/",
  "uploadOnSave": false,
  "ignore": [".vscode", ".git", ".DS_Store"]
}
```

### Safe deletions and renames
```json
{
  "host": "host",
  "username": "username",
  "remotePath": "/var/www/project",
  "ignoreTempFiles": true,
  "tempFilePatterns": ["*.generated.php"],
  "deleteRemoteOnLocalDelete": true,
  "deleteRemoteConfirmThreshold": 10,
  "renameRemoteOnLocalRename": true,
  "remoteTrash": {
    "enabled": true,
    "path": "/var/tmp/sftp-trash",
    "retentionDays": 14
  }
}
```

_Note:_ all of these are the values the extension already uses by default, except `tempFilePatterns`, `remoteTrash.path` (`.sftp-trash`) and `remoteTrash.retentionDays` (`7`); you only need to write them down in order to change them. An absolute `path` keeps the trash outside the document root served by the web server.

### External changes and upload verification
```json
{
  "host": "host",
  "username": "username",
  "remotePath": "/var/www/project",
  "uploadOnSave": true,
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": false,
    "pollInterval": 0
  },
  "externalChanges": {
    "scanOnStartup": true,
    "scanOnResume": true,
    "confirmThreshold": 20
  },
  "verifyUpload": "stat",
  "uploadRetries": 2
}
```

_Note:_ `externalChanges`, `verifyUpload` and `uploadRetries` carry their default values here; the `watcher` block is not needed for the scans (only to react to live changes and for `pollInterval`). `verifyUpload: "hash"` adds the content check, and a `pollInterval` in milliseconds turns on periodic polling.

## Remote Explorer
![remote-explorer-preview](assets/showcase/remote-explorer.png)

The Remote Explorer lets you browse the server's files. You can open it like this:

1. Run the `View: Show SFTP` command.
2. Click the SFTP view in the activity bar.

With the Remote Explorer you can only view the contents of files. Run the `SFTP: Edit in Local` command to edit them locally.

Since v1.16.5, symlinked directories on the remote are also browsable.

### Multi-selection
You can select multiple files/folders at once on the remote server to download or upload them. Simply hold Ctrl or Shift while selecting the desired files, just like in the regular explorer.

_Note:_ if the explorer does not refresh correctly after **deleting** a file, manually refresh the parent folder.

### Ordering
You can order the Remote Explorer by adding the `remoteExplorer.order` parameter inside your `sftp.json` configuration file.

In sftp.json:
```json
{
  "remoteExplorer": {
    "order": 1 // <-- The default value is 0.
  }
}
```

## Debugging
1. Open User Settings.
  - On Windows/Linux: `File > Preferences > Settings`
  - On macOS: `Code > Preferences > Settings`
2. Enable `sftp.debug` (`true`) and reload VS Code.
3. Check the logs in `View > Output > sftp`.

## FAQ
You can see all the frequently asked questions [here](./FAQ.md).

## Credits and support for the original authors
This fork builds on the work of [@liximomo](https://github.com/liximomo) (original author) and [@Natizyskunk](https://github.com/Natizyskunk) (maintainer of the fork this one derives from). If this extension has helped you over the years, consider supporting them:

- Buy Natizyskunk a coffee: https://www.buymeacoffee.com/Natizyskunk
- PayPal: https://www.paypal.com/donate?business=DELD7APHHM3BC&no_recurring=0&currency_code=EUR

### Community

- **Discussions**: Join the conversations at [GitHub Discussions](https://github.com/jalexiscv/vscode-sftp/discussions)
- **Contributions**: Check the [issues labeled "good first issue"](https://github.com/jalexiscv/vscode-sftp/labels/good%20first%20issue)

---

## 📜 License

Distributed under the **MIT** License. See [LICENSE](LICENSE) for more information.

> The MIT license allows you to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the software without restriction, provided the copyright notice is included.

---

## 👨‍💻 Author

**Jose Alexis Correa Valencia**
*Full Stack Developer & Software Architect*

With over 25 years of experience in enterprise software development, specialized in scalable architectures and modern PHP solutions.

- **GitHub**: [@jalexiscv](https://github.com/jalexiscv)
- **LinkedIn**: [Jose Alexis Correa Valencia](https://www.linkedin.com/in/jalexiscv/)
- **Email**: jalexiscv@gmail.com
- **Location**: Colombia 🇨🇴

---

## ❤️ Donations

If this extension has helped you or your business, consider supporting its ongoing development and maintenance.

| Method | Details |
|--------|---------|
| **PayPal** | [jalexiscv@gmail.com](https://www.paypal.com/paypalme/anssible) |
| **Nequi (Colombia)** | `3117977281` |

### Benefits of Your Support

Your donation helps to:
- ⚡ Speed up the development of new features
- 📚 Create more documentation and examples
- 🧪 Improve test coverage
- 🐛 Address more fixes from the issue backlog
- 🌍 Keep the project active and up to date

*Thank you for your support!* 🙏
