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

Every fix was verified (clean webpack build, 42/42 tests, linter with no errors) before being published. The details of each change live in [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

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
code --install-extension sftp-1.17.0.vsix
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
