## Setting

There are a handful of settings available for SFTP, and they can be changed:

- On Windows/Linux: File --> Preferences --> Settings
- On macOS: Code --> Preferences --> Settings

### debug
Adds debugging output to the SFTP output panel. <br>
You can view the login in `View --> Output --> SFTP`.  Changing this requires VSCode to be reloaded.

| Key | Value | Default |
| --- | --- | --- |
| *debug* | *boolean* | *false* |

```json
{
  "name": "My Server"
}
```

### downloadWhenOpenInRemoteExplorer
Change the default behavior from `View Content` to `Edit in Local` when opening files in the Remote Explorer.

| Key | Value | Default |
| --- | --- | --- |
| *debug* | *boolean* | *false* |

```json
{
  "name": "My Server"
}
```

### showActivityView
Show the **SFTP Activity** view in the SFTP sidebar container, with the history of transfers, deletions and renames.

| Key | Value | Default |
| --- | --- | --- |
| *showActivityView* | *boolean* | *true* |

```json
{
  "sftp.showActivityView": true
}
```

### updates.check
When to look for a newer release of this extension on GitHub ([jalexiscv/vscode-sftp](https://github.com/jalexiscv/vscode-sftp/releases)). VS Code updates on its own only the extensions that come from the Marketplace; one installed from a vsix stays as it is, so the extension checks by itself. A newer version is **offered, never installed on its own**: the notice has `Install`, `Release notes` and `Skip this version`. `Install` downloads the vsix of the release into the extension's global storage, verifies it against the `.sha256` the release publishes (a release without one is installed unverified, with a line in the output channel), hands it to VS Code's own *Install from VSIX* and offers to reload the window. `Skip this version` silences the automatic notice for that version only; `SFTP: Check for Updates` still offers it, and says so when there is nothing new or the check failed. The automatic check runs 15 s after activation so the extension is usable first; a failure (no network, GitHub down) only reaches the output channel (`[updates] …`). Drafts and prereleases are never offered.

| Key | Value | Default |
| --- | --- | --- |
| *updates.check* | `daily` (once every 24 h, on activation), `startup` (every activation), `off` (only by hand) | `daily` |

```json
{
  "sftp.updates.check": "daily"
}
```
