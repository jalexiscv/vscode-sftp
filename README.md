# SFTP — sync extension for VS Code (corrected fork)

**A maintained, corrected fork by [@jalexiscv](https://github.com/jalexiscv)** of the popular SFTP/FTP sync extension.<br>
Lineage: forked from [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), itself a fork of the no longer maintained [liximomo's SFTP plugin](https://github.com/liximomo/vscode-sftp.git).

- 📦 **Install (VSIX releases):** https://github.com/jalexiscv/vscode-sftp/releases
- 🐛 **Report issues:** https://github.com/jalexiscv/vscode-sftp/issues
- 📄 **Full change history:** [CHANGELOG.md](CHANGELOG.md)

VSCode-SFTP enables you to add, edit or delete files within a local directory and have it sync to a remote server directory using different transfer protocols like FTP or SSH. The most basic setup requires only a few lines of configuration, with a wide array of specific settings also available to meet the needs of any user. Both powerful and fast, it helps developers save time by allowing the use of a familiar editor and environment.

---

## Why this fork exists

We launched this version because the original project, while excellent, reached a point where it could no longer serve its users:

1. **The upstream project is effectively unmaintained.** Its maintainer stated in March 2025 that he could not keep working on it and that [v1.16.3 (June 2023)](https://github.com/Natizyskunk/vscode-sftp/releases/tag/v1.16.3) should be considered the last stable release. Since then, ~600 issues have accumulated without fixes.
2. **The extension broke on modern VS Code.** Recent VS Code builds ship a Node.js runtime where the bundled `ssh2` 1.13 dependency crashes with `TypeError: isDate is not a function`, making every SFTP operation fail — the single most-reported bug of the project (upstream [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590)).
3. **The upstream development branch could not even be built.** Its `develop` branch had TypeScript compilation errors and a broken test suite, which meant community fixes (several of them submitted as pull requests years ago) had no path to being released.
4. **There was an unresolved security problem.** With the default configuration, syncing a project could upload `.vscode/sftp.json` — containing the server host, username and password — to the remote server, often inside a public web root.

Rather than letting a tool used by thousands of developers decay, we forked it, repaired its foundations (build, tests, linter), fixed the most-reported bugs, and committed to keeping it working.

## What we updated

Every fix was verified (clean webpack build, 42/42 tests, lint) before release. Full details per change live in [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

### [v1.16.4](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.4) — foundations and critical fixes

| Area | Fix |
|------|-----|
| **Compatibility** | Upgraded `ssh2` to 1.17.0: fixes *"isDate is not a function"* on modern VS Code, adds modern OpenSSH key formats and rsa-sha2 algorithms (upstream [#586](https://github.com/Natizyskunk/vscode-sftp/issues/586), [#590](https://github.com/Natizyskunk/vscode-sftp/issues/590), PR [#595](https://github.com/Natizyskunk/vscode-sftp/pull/595)) |
| **Security** | `.vscode/sftp.json` (credentials) can never be uploaded to the server, regardless of the `ignore` configuration |
| **Reliability** | Automatic reconnection after a server-side SFTP channel termination instead of hanging forever (upstream PR [#582](https://github.com/Natizyskunk/vscode-sftp/pull/582)) |
| **Windows** | Fixed *"Error: Config Not Found"* / `uploadOnSave` not working when the reported path casing differs from the workspace one (upstream PR [#447](https://github.com/Natizyskunk/vscode-sftp/pull/447)) |
| **Windows** | `ignore` patterns now actually work (gitignore matching received `\`-separated paths) |
| **Config** | `sftp.json` is reloaded when it changes outside the editor — e.g. a git branch switch (upstream PR [#494](https://github.com/Natizyskunk/vscode-sftp/pull/494)) |
| **FTP** | Non-ASCII file names (Chinese, accents) no longer garbled in listings (upstream PR [#443](https://github.com/Natizyskunk/vscode-sftp/pull/443), without its SFTP regression) |
| **FTP** | Overwrites rejected with 550 by proftpd `mod_rename` servers are retried safely (upstream [#420](https://github.com/Natizyskunk/vscode-sftp/issues/420)) |
| **Build** | Restored compilation of the codebase, repaired the test infrastructure (Jest 29, Node 22) and cleaned all pre-existing lint violations |

### [v1.16.5](https://github.com/jalexiscv/vscode-sftp/releases/tag/v1.16.5) — second round

| Area | Fix |
|------|-----|
| **SSH** | `Open SSH in Terminal` now uses the configured `hop` chain via OpenSSH ProxyJump (`-J`) (upstream [#441](https://github.com/Natizyskunk/vscode-sftp/issues/441)) |
| **Remote Explorer** | Remote symlinks pointing to directories are browsable over SFTP — e.g. `current -> releases/N` deployment layouts (upstream [#283](https://github.com/Natizyskunk/vscode-sftp/issues/283)) |
| **Notebooks** | `uploadOnSave` now triggers when saving notebook documents such as `.ipynb` |

## What we expect from this version

- **A drop-in replacement.** Same `sftp.json` format, same commands, same workflows — existing configurations work without any migration.
- **Stability on current tooling.** The extension must keep working on up-to-date VS Code and Node.js runtimes, which is where the original broke.
- **Safe by default.** Your credentials never leave your machine as part of a sync, even with a custom or empty `ignore` list.
- **A living project.** We will keep triaging the upstream backlog (feature requests like SOCKS5 proxies, `.ppk` keys or folder diffing are candidates for future rounds), and issues/PRs on [our tracker](https://github.com/jalexiscv/vscode-sftp/issues) are welcome.
- **Verifiable quality.** No release ships without a clean build, a green test suite and a clean linter; every change is documented in [documents/Changelogs](documents/Changelogs/CHANGELOG.md).

---

## Installation

> ⚠️ **Uninstall or disable any other SFTP extension first** (liximomo's or Natizyskunk's): they register the same `sftp.*` commands and will conflict with this one.

1. Download the latest `sftp-x.y.z.vsix` from the [Releases page](https://github.com/jalexiscv/vscode-sftp/releases).
2. In VS Code, select Extensions (Ctrl + Shift + X).
3. Open the "More Actions" menu (ellipsis on the top) and click "Install from VSIX…".
4. Locate the VSIX file and select it.
5. Reload VS Code.
6. Voilà!

Or from the command line:

```
code --install-extension sftp-1.16.5.vsix
```

## Documentation
- [Home](https://github.com/Natizyskunk/vscode-sftp/wiki)
- [Settings](https://github.com/Natizyskunk/vscode-sftp/wiki/Setting)
- [Common configuration](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration)
- [SFTP configuration](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration)
- [FTP configuration](https://github.com/Natizyskunk/vscode-sftp/wiki/FTP(s)-only-Configuration)
- [Commands](https://github.com/Natizyskunk/vscode-sftp/wiki/Commands)

> The upstream wiki remains the reference for settings and commands: this fork keeps full configuration compatibility.

## Usage
If the latest files are already on a remote server, you can start with an empty local folder,
then download your project, and from that point sync.

1. In `VS Code`, open a local directory you wish to sync to the remote server (or create an empty directory
that you wish to first download the contents of a remote server folder in order to edit locally).
2. `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on Mac open command palette, run `SFTP: config` command.
3. A basic configuration file will appear named `sftp.json` under the `.vscode` directory, open and edit the configuration parameters with your remote server information.

For instance:
```json
{
    "name": "Profile Name",
    "host": "name_of_remote_host",
    "protocol": "ftp",
    "port": 21,
    "secure": true,
    "username": "username",
    "remotePath": "/public_html/project", // <--- This is the path which will be downloaded if you "Download Project"
    "password": "password",
    "uploadOnSave": false
}
```
The password parameter in `sftp.json` is optional, if left out you will be prompted for a password on sync.
_Note：_ backslashes and other special characters must be escaped with a backslash.

4. Save and close the `sftp.json` file.
5. `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on Mac open command palette.
6. Type `sftp` and you'll now see a number of other commands. You can also access many of the commands from the project's file explorer context menus.
7. A good one to start with if you want to sync with a remote folder is `SFTP: Download Project`.  This will download the directory shown in the `remotePath` setting in `sftp.json` to your local open directory.
8. Done - you can now edit locally and after each save it will upload to sync your remote file with the local copy.
9. Enjoy!

For detailed explanations please go to [wiki](https://github.com/Natizyskunk/vscode-sftp/wiki).

## Example configurations
You can see the full list of configuration options [here](https://github.com/Natizyskunk/vscode-sftp/wiki/configuration).

- [Simple](#simple)
- [Profiles](#profiles)
- [Multiple Context](#multiple-context)
- [Connection Hopping](#connection-hopping)
- [Configuration in User Setting](#configuration-in-user-setting)

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

_Note：_ `context` and `watcher` are only available at root level.

Use `SFTP: Set Profile` to switch profile.

### Multiple Context
The context must **not be same**.
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

_Note：_ `name` is required in this mode.

### Connection Hopping
You can connect to a target server through a proxy with ssh protocol.

_Note：_ Variable substitution is not working in a hop configuration.

#### Single Hop
local -> hop -> target
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // hop
  "host": "hopHost",
  "username": "hopUsername",
  "privateKeyPath": "/Users/localUser/.ssh/id_rsa", // <-- The key file is assumed on the local.

  "hop": {
    // target
    "host": "targetHost",
    "username": "targetUsername",
    "privateKeyPath": "/Users/hopUser/.ssh/id_rsa", // <-- The key file is assumed on the hop.
  }
}
```

#### Multiple Hop
local -> hopa -> hopb -> target
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // hopa
  "host": "hopAHost",
  "username": "hopAUsername",
  "privateKeyPath": "/Users/hopAUsername/.ssh/id_rsa" // <-- The key file is assumed on the local.

  "hop": [
    // hopb
    {
      "host": "hopBHost",
      "username": "hopBUsername",
      "privateKeyPath": "/Users/hopaUser/.ssh/id_rsa" // <-- The key file is assumed on the hopa.
    },

    // target
    {
      "host": "targetHost",
      "username": "targetUsername",
      "privateKeyPath": "/Users/hopbUser/.ssh/id_rsa", // <-- The key file is assumed on the hopb.
    }
  ]
}
```

### Configuration in User Setting
You can use `remote` to tell sftp to get the configuration from [remote-fs](https://github.com/liximomo/vscode-remote-fs).

In User Setting:
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

Remote Explorer lets you explore files in remote. You can open Remote Explorer by:

1. Run Command `View: Show SFTP`.
2. Click SFTP view in Activity Bar.

You can only view a files content with Remote Explorer. Run command `SFTP: Edit in Local` to edit it in local.

Since v1.16.5, symlinked directories on the remote are browsable too.

### Multiple Select
You are able to select multiple files/folders at once on the remote server to download and upload. You can do it simply by holding down Ctrl or Shift while selecting all desired files, just like on the regular explorer view.

_Note：_ You need to manually refresh the parent folder after you **delete** a file if the explorer isn't correctly updated.

### Order
You can order the remote Explorer by adding the `remoteExplorer.order` parameter inside your `sftp.json` config file.

In sftp.json:
```json
{
  "remoteExplorer": {
    "order": 1 // <-- Default value is 0.
  }
}
```

## Debug
1. Open User Settings.
  - On Windows/Linux - `File > Preferences > Settings`
  - On macOS - `Code > Preferences > Settings`
2. Set `sftp.debug` to `true` and reload vscode.
3. View the logs in `View > Output > sftp`.

## FAQ
You can see all the Frequently Asked Questions [here](./FAQ.md).

## Credits and support for the original authors
This fork stands on the work of [@liximomo](https://github.com/liximomo) (original author) and [@Natizyskunk](https://github.com/Natizyskunk) (maintainer of the fork this one derives from). If this extension helped you over the years, consider supporting them:

- Buy Natizyskunk a coffee: https://www.buymeacoffee.com/Natizyskunk
- PayPal: https://www.paypal.com/donate?business=DELD7APHHM3BC&no_recurring=0&currency_code=EUR
