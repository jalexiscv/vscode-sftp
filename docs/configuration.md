# VSCode-SFTP

Configurations are stored in your project working directory under `../.vscode/sftp.json`. <br>
The configuration file can always be accessed with `CTRL` + `Shift` + `P`, and searching for `SFTP: Config`.

![image](https://github.com/user-attachments/assets/5ceff350-7678-4264-98d4-2741a98a9dbe)

## Table of Contents

### Configuration
- [name](#name)
- [context](#context)
- [protocol](#protocol)
- [host](#host)
- [port](#port)
- [username](#username)
- [password](#password)
- [remotePath](#remotepath)
- [filePerm](#fileperm)
- [dirPerm](#dirperm)
- [uploadOnSave](#uploadonsave)
- [useTempFile](#usetempfile)
- [openSsh](#openssh)
- [verifyUpload](#verifyupload)
- [uploadRetries](#uploadretries)
- [downloadOnOpen](#downloadonopen)
- [syncOption](#syncoption)
- [ignore](#ignore)
- [ignoreFile](#ignorefile)
- [ignoreTempFiles](#ignoretempfiles)
- [tempFilePatterns](#tempfilepatterns)
- [uploadExclude](#uploadexclude)
- [watcher](#watcher)
- [externalChanges](#externalchanges)
- [deleteRemoteOnLocalDelete](#deleteremoteonlocaldelete)
- [deleteRemoteConfirmThreshold](#deleteremoteconfirmthreshold)
- [renameRemoteOnLocalRename](#renameremoteonlocalrename)
- [remoteTrash](#remotetrash)
- [remoteTimeOffsetInHours](#remotetimeoffsetinhours)
- [remoteExplorer](#remoteexplorer)
- [concurrency](#concurrency)
- [connectTimeout](#connecttimeout)
- [limitOpenFilesOnRemote](#limitopenfilesonremote)

### SFTP only configuration
- [agent](#agent)
- [privateKeyPath](#privatekeypath)
- [passphrase](#passphrase)
- [interactiveAuth](#interactiveauth)
- [algorithms](#algorithms)
- [sshConfigPath](#sshconfigpath)
- [sshCustomParams](#sshcustomparams)

### FTP(s) only configuration
- [secure](#secure)
- [secureOptions](#secureoptions)

### How it works
- [External changes and upload verification](#external-changes-and-upload-verification)



## Configuration

### name
A string to identify your configuration.

| Key | Value |
| --- | --- |
| *name* | *string* |

```json
{
  "name": "My Server"
}
```

### context
A path relative to the workspace root folder. <br>
Use this when you want to map a subfolder to the `remotePath`.

| Key | Value | Default |
| --- | --- | --- |
| *context* | *string* | *The workspace root.* |

```json
{
  "context": "/_subfolder_"
}
```

### protocol
Protocol to be used.

| Key | Value | Default |
| --- | --- | --- |
| *protocol* | `sftp` *or* `ftp` | `sftp` |

```json
{
  "protocol": "sftp"
}
```

### host
Hostname or IP address of the server.

| Key | Value |
| --- | --- |
| *host* | *string* |

```json
{
  "host": "server.example.com"
}
```

### port
Port number of the server.

| Key | Value |
| --- | --- |
| *port* | *integer* |

```json
{
  "port": 22
}
```

### username
Username for authentication.

| Key | Value |
| --- | --- |
| *username* | *string* |

```json
{
  "username": "user1"
}
```

### password
[!WARNING]
**Passwords are stored as plain-text!**

The password for password-based user authentication.

| Key | Value |
| --- | --- |
| *password* | *string* |

```json
{
  "password": "Password123"
}
```

### remotePath
The absolute path on the remote host.

| Key | Value | Default |
| --- | --- | --- |
| *remotePath* | *string* | `/` |

```json
{
  "remotePath": "/_subfolder_"
}
```

### filePerm
Set octal file permissions for new files.

| Key | Value | Default |
| --- | --- | --- |
| *filePerm* | *number* | `false` |

```json
{
  "filePerm": 644
}
```
 
### dirPerm
Set octal directory permissions for new directories.

| Key | Value | Default |
| --- | --- | --- |
| *dirPerm* | *number* | `false` |

```json
{
  "dirPerm": 750
}
```

### uploadOnSave
Upload on every save operation of VSCode.

| Key | Value | Default |
| --- | --- | --- |
| *uploadOnSave* | *boolean* | `false` |

```json
{
  "uploadOnSave": true
}
```

### useTempFile
Upload temp file on every save operation of VSCode to avoid breaking a webpage when a user accesses it while the file is still being uploaded (is incomplete).

| Key | Value | Default |
| --- | --- | --- |
| *useTempFile* | *boolean* | `false` |

```json
{
  "useTempFile": true
}
```

### openSsh
Enable atomic file uploads (*only supported by openSSH servers*).

| 💡 Important |
| :--- |
| *If set to* `true`*, the* `useTempFile` *option must also be set to* `true`.|

| Key | Value | Default |
| --- | --- | --- |
| *openSsh* | *boolean* | `false` |

```json
{
  "openSsh": true,
  "useTempFile": true
}
```

### verifyUpload
What to check on the server after each upload, once the protocol has acknowledged it. <br>
The acknowledgement alone (the end of the SFTP write stream, a `226` reply over FTP) does not catch a file truncated by a quota, a failed `rename` with `useTempFile` that leaves the destination missing, or a local read cut short: the upload *happened*, but nothing proved it arrived whole. The bytes sent are always counted against the local size, whatever the level; the level decides what is asked of the server afterwards.

| Level | What it proves | Cost per file |
| :--- | :--- | :--- |
| `none` | Protocol acknowledgement and byte count only. | — |
| `stat` | The remote size equals the local size exactly (`lstat` over SFTP, `SIZE` over FTP), measured on the final path — never on the `.new` staging file of `useTempFile`. Over SFTP, when the server accepted the timestamp update, the mtime is also compared within ±2 s, but a difference only logs a warning. | One round trip. |
| `hash` | On top of `stat`, a digest of the remote file equals the local one (sha256, sha1, md5 or crc32 — the strongest the server can compute, chosen once per connection). Over SFTP the digest comes from `sha256sum`, `shasum -a 256`, `openssl dgst -sha256` or `md5sum` run through an SSH `exec` channel — with `hop`, on the final host — so the account needs a shell. Over FTP the server must advertise `XSHA256`, `HASH`, `XSHA1`, `XMD5` or `XCRC` in `FEAT`. | One command, and the server reads the whole file. |

When the server cannot compute a digest — an SFTP-only account, a jailed `internal-sftp`, an FTP server without digest commands, a command that fails or times out for one file — `hash` **degrades to `stat`** instead of failing: the upload is reported as verified by size, the reason is kept with the transfer, and a warning is logged once per connection. Only a *different* digest is a verification failure.

A failed check is retried like a network error (see [uploadRetries](#uploadretries)) and then reported as a failed upload, with a concrete reason such as `size mismatch (local 1024, remote 0)` or `hash mismatch (sha256: local 3a7f9c12…, remote 9c01e4b7…)`, in the SFTP Activity view and in the `✗N` counter of the status bar. With `useTempFile`, a short upload never replaces the destination: the byte count is checked before the `rename`. Verification applies to uploads; downloads count bytes only.

| Key | Value | Default |
| --- | --- | --- |
| *verifyUpload* | `none` *or* `stat` *or* `hash` | `stat` |

```json
{
  "verifyUpload": "hash"
}
```

### uploadRetries
How many times a transiently failed transfer — a network error, a timeout, a failed verification — is repeated before it is reported as failed. <br>
Each retry waits a little longer than the previous one (500 ms × attempt), closes the stream of the failed attempt and reopens the source; a `[transfer] retry n/m` line is written to the output channel. Cancellations and permanent errors — permission denied, a source that no longer exists, FTP `5xx` replies other than quota — are never retried. The setting also applies to downloads. `0` disables retries.

| Key | Value | Default |
| --- | --- | --- |
| *uploadRetries* | *number* | `2` |

```json
{
  "uploadRetries": 2
}
```

### downloadOnOpen
Download the file from the remote server whenever it is opened.

| Key | Value | Default |
| --- | --- | --- |
| *downloadOnOpen* | *boolean* | `false` |

```json
{
  "downloadOnOpen": true
}
```

### syncOption
Configure the behavior of the `Sync` command.

| Key | Value | Default |
| --- | --- | --- |
| *syncOption* | *object* | `{}` |

#### syncOption.delete
Delete extraneous files from destination directories.

| Key | Value |
| --- | --- |
| *syncOption.delete* | *boolean* |

#### syncOption.skipCreate
Skip creating new files on the destination.

| Key | Value |
| --- | --- |
| *syncOption.skipCreate* | *boolean* |

#### syncOption.ignoreExisting
Skip updating files that exist on the destination.

| Key | Value |
| --- | --- |
| *syncOption.ignoreExisting* | *boolean* |

#### syncOption.update
Update the destination only if a newer version is on the source filesystem.

| Key | Value |
| --- | --- |
| *syncOption.update* | *boolean* |

```json
{
  "syncOption": {
    "delete": true,
    "skipCreate": false,
    "ignoreExisting": false,
    "update": true
  },
}
```

### ignore
Ignore can be used to ignore files and folders from sync, and even supports wildcards using `*`. <br>
This is the same behavior as gitignore, all paths relative to context of the current configuration. <br>
It applies to **both directions**: an ignored path is neither uploaded nor downloaded. To keep a path from being uploaded while still being able to download it, use [uploadExclude](#uploadexclude).
 
| Key | Value | Default |
| --- | --- | --- |
| *ignore* | *string[]* | `[]` |
 
```json
{
  "ignore": [
    "/.vscode",
    "/.git",
    "/.cache",
    "/_subfolder_",
    ".DS_Store",
    "*.gz",
    "*.log"
  ],
}
```

### ignoreFile
Absolute path to the ignore file or Relative path relative to the workspace root folder.
 
| Key | Value |
| --- | --- |
| *ignoreFile* | *string* |
 
```json
{
  "ignoreFile": "/.vscode/sftp.json"
}
```

### ignoreTempFiles
Never transfer local scratch files. <br>
These are artifacts of editors, operating systems, merge tools and browsers: uploading them is at best noise, and at worst harmful — a stale `.orig` next to a deployed file leaks the pre-merge source, and an interrupted download (`*.part`) would publish a truncated file.

The built-in list is applied on top of your own `ignore` patterns, on every server and without any configuration:

| Origin | Patterns |
| --- | --- |
| Generic temporary files | `*.tmp`, `*.tmp.*`, `*.tmp[0-9]*`, `*.temp`, `*.$$$` |
| This extension's upload staging file | `*.new` |
| vim / vi | `*.swp`, `*.swo`, `*.swn`, `.*.sw[a-p]`, `*~` |
| emacs | `.#*`, `\#*#` (the leading `#` must be escaped, or gitignore reads it as a comment) |
| Office / LibreOffice lock files | `~$*`, `.~lock.*#` |
| Merge, patch and backup leftovers | `*.orig`, `*.rej`, `*.bak` |
| Partially written downloads | `*.crdownload`, `*.part`, `*.partial`, `*.download` |
| macOS | `.DS_Store`, `._*`, `.Spotlight-V100`, `.Trashes` |
| Windows | `Thumbs.db`, `ehthumbs.db`, `desktop.ini` |

The `*.tmp` variants are spelled out rather than written as `*.tmp*`, which would also match real extensions that merely start with "tmp" — `.tmpl` templates are common enough that the silent skip read as a broken upload.
Dependency lock files such as `composer.lock` or `yarn.lock` are **not** in the list and are transferred normally.

| Key | Value | Default |
| --- | --- | --- |
| *ignoreTempFiles* | *boolean* | `true` |

```json
{
  "ignoreTempFiles": true
}
```

### tempFilePatterns
Extra gitignore patterns added to the built-in temporary file list of `ignoreTempFiles`. <br>
They are appended **after** the built-in ones, and gitignore resolves conflicts with the last matching pattern, so a negation here can let one of the built-ins back through.

| Key | Value | Default |
| --- | --- | --- |
| *tempFilePatterns* | *array* | `[]` |

```json
{
  "tempFilePatterns": ["*.generated.php", "!*.bak"]
}
```

In the example above, `*.generated.php` is added to the exclusions and `*.bak` — which is excluded by default — is transferred again.

### uploadExclude
gitignore patterns — typically directories — that are **never uploaded**, whatever triggers the upload: `Upload File` / `Upload Folder` / `Upload Project`, `uploadOnSave`, the watcher, the external-change scans and their plans, `Upload Changed Files` and `Sync Local -> Remote` (with `syncOption.delete` on, the remote copy is not deleted either). The remote copy is also left alone when the local one is deleted or renamed. <br>
Unlike [ignore](#ignore), which applies to both directions, an excluded path can still be downloaded, listed in the Remote Explorer, diffed and brought down by `Sync Remote -> Local`. It is the right tool for what the server owns — user uploads, generated caches, logs — and for local files that must never reach it. `Force Upload` bypasses the list, as it does with `ignore`; `Sync Both Directions` skips an excluded directory whole, in both directions. An explicit upload command on an excluded path says so in a notification and does nothing.

Same syntax and anchoring as `ignore`, relative to the context: `/storage` anchors at the root, `uploads/` matches a directory at any depth. In a profile the list is added to the base one, like `ignore`.

| Key | Value | Default |
| --- | --- | --- |
| *uploadExclude* | *string[]* | `[]` |

```json
{
  "uploadExclude": [
    "/storage",
    "/public/uploads",
    "*.env"
  ]
}
```

### watcher
Watch the local tree for changes made outside the VS Code editor and mirror them to the server.

| Key | Value | Default |
| --- | --- | --- |
| *watcher* | *object* | `{}` |

Since 1.24.0 the watcher and `uploadOnSave` feed the **same change collector**, so a save that is seen by both is uploaded once — there is no longer any need to turn `uploadOnSave` off when you watch everything. Editor saves are uploaded immediately; external changes are grouped for 700 ms (1.4 s at most when files keep changing), deduplicated by path and turned into an [upload plan](#external-changes-and-upload-verification) that goes through the [externalChanges.confirmThreshold](#externalchangesconfirmthreshold) confirmation. Ignored paths and everything while auto sync is paused are left alone; while a download or `Sync Remote -> Local` is running, the extension's own writes are ignored and your saves are deferred until it finishes.

The watcher only sees events while VS Code is open, and can miss them on network drives or container mounts; the reconciliation scans of [externalChanges](#externalchanges) and the optional [watcher.pollInterval](#watcherpollinterval) cover those gaps.

#### watcher.files
Glob patterns that are watched and when edited outside of the VSCode editor are processed.

| Key | Value |
| --- | --- |
| *watcher.files* | *string* |
 
#### watcher.autoUpload
Upload when the file changed.

| Key | Value |
| --- | --- |
| *watcher.autoUpload* | *boolean* |

#### watcher.autoDelete
Delete when the file is removed.

| Key | Value |
| --- | --- |
| *watcher.autoDelete* | *boolean* |

#### watcher.pollInterval
Milliseconds between scans of the local tree against the sync index, for environments where filesystem events are unreliable (network drives, Docker or WSL mounts). <br>
Each tick compares the local tree with the index of verified uploads and plans what changed, like the automatic scans of [externalChanges](#externalchanges) do (so, on an unseeded index, only files the extension already uploaded itself); ticks never overlap, and a scan is not repeated while a previous scan plan is still waiting for review. `0` disables polling. Only effective when the `watcher` block is present.

| Key | Value | Default |
| --- | --- | --- |
| *watcher.pollInterval* | *number* | `0` |

```json
{
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": true,
    "pollInterval": 0
  },
}
```

### externalChanges
Detection of local changes made outside the editor — by an external tool, by git, or while VS Code was closed — by comparing the local tree with the **sync index** of verified uploads. <br>
The watcher only sees events while the window is open; these scans are what catch a `git pull` run in another terminal, a code generator, or a week of edits made with VS Code closed. See [External changes and upload verification](#external-changes-and-upload-verification) for the whole flow.

A scan walks the local tree (pruned by `ignore`, `uploadExclude` and the temporary-file list), compares the size and mtime of every file with the index and turns what differs into an upload plan of `new` files (never seen by the index) and `modified` files (indexed, and changed since their last verified upload). Files unchanged since their last verified upload are not touched, files you skipped are not proposed again until they change, and nothing is listed on the server. `modified` files below `confirmThreshold` are uploaded right away; a plan that contains `new` files, exceeds the threshold or was caused by a git operation asks first with a modal dialog.

The index starts out **unseeded**. Until `SFTP: Rebuild Sync Index` has run once for a server — or a manual `SFTP: Scan for External Changes` has planned, been confirmed and uploaded — automatic scans only plan `modified` files, i.e. they re-upload what the extension already uploaded itself; unindexed files are ignored and counted in the output channel (`N unindexed file(s) ignored until the index is built`), nothing new is uploaded and nothing is asked. The extension tells you once per server, remembered per workspace, with `Build index now`, `Mark all as uploaded` and `Don't show again`. A plain `uploadOnSave` adds entries to the index but does not seed it. After installing, run `SFTP: Rebuild Sync Index` once per server (or upload the project once and run a manual scan) so the extension knows what is already on the server; when the local tree is known to be what the server holds, `SFTP: Mark Local Files as Uploaded` seeds the index from it without listing the server.

| Key | Value | Default |
| --- | --- | --- |
| *externalChanges* | *object* | `{}` |

#### externalChanges.scanOnStartup
Scan the local tree when the extension activates and whenever `sftp.json` is reloaded, and upload what changed since the last verified upload.

| Key | Value | Default |
| --- | --- | --- |
| *externalChanges.scanOnStartup* | *boolean* | `true` |

#### externalChanges.scanOnResume
Scan when automatic sync is resumed (`SFTP: Resume Auto Sync`) and when the window regains focus after five minutes or more without a scan — the moment you come back from a terminal or another editor.

| Key | Value | Default |
| --- | --- | --- |
| *externalChanges.scanOnResume* | *boolean* | `true` |

#### externalChanges.confirmThreshold
Number of changed files above which SFTP shows the upload plan and asks for confirmation before uploading anything. <br>
The dialog lists up to 12 paths and offers `Review plan` (the default: the plan stays pending in the **Upload plans** group of the SFTP Activity view, where it can be uploaded, trimmed file by file, marked as uploaded or removed), `Upload N file(s)`, `Mark as uploaded` (the files are recorded in the index as being on the server already, in their current version, and nothing is transferred) and `Skip`. Two kinds of batch **always** ask, whatever their size: those caused by a git operation — HEAD moved between the change and the upload: checkout, pull, rebase, merge… — and automatic batches that contain `new` files, which the index has never seen; only `modified` files go up without asking below the threshold. `Skip` is remembered: the skipped files are recorded in the index with their current size and mtime and are not proposed again until they change. Set it to `0` to always ask. It applies to every source of changes: scans, the watcher, polling, and even `uploadOnSave` with a *Save All* of many files. Symmetric to `deleteRemoteConfirmThreshold`.

| Key | Value | Default |
| --- | --- | --- |
| *externalChanges.confirmThreshold* | *number* | `20` |

```json
{
  "externalChanges": {
    "scanOnStartup": true,
    "scanOnResume": true,
    "confirmThreshold": 20
  }
}
```

`externalChanges` can be overridden partially inside a profile.

### deleteRemoteOnLocalDelete
Delete a file on the server when it is deleted locally, so the two sides don't drift apart. <br>
Works for files and folders, whether the deletion comes from the VS Code explorer, a terminal or an external tool. Unlike `watcher.autoDelete`, this needs no `watcher.files` glob and is on by default.

Deleting is the one operation with no undo at the protocol level, so it comes with four safeguards:

| Safeguard | Behaviour |
| :--- | :--- |
| Bulk confirmation | A batch larger than `deleteRemoteConfirmThreshold` opens a modal dialog listing the files, and does nothing unless you confirm. |
| Git awareness | Deletions caused by a git operation (checkout, rebase, merge, stash, cherry-pick, revert, bisect) are **discarded**, detected through the marker files git holds in `.git` (`index.lock`, `MERGE_HEAD`, `rebase-merge`…). Switching a branch never touches the server. |
| Self-suppression | Deletions caused by the extension itself — a `Sync Remote -> Local` with `syncOption.delete` removing extraneous local files — are suppressed, so they are not mirrored back to the server. |
| Remote trash | With `remoteTrash.enabled`, the deletion is a server-side move to a trash folder rather than an `unlink`, and it can be undone. |

Deletions are also skipped for files matched by `ignore` or `uploadExclude`, for files with a transfer in flight, and while auto sync is paused.

| Key | Value | Default |
| --- | --- | --- |
| *deleteRemoteOnLocalDelete* | *boolean* | `true` |

```json
{
  "deleteRemoteOnLocalDelete": true
}
```

### deleteRemoteConfirmThreshold
Number of local deletions above which SFTP asks for confirmation before mirroring them to the server. <br>
Set it to `0` to be asked every time. The count is per batch and per server.

| Key | Value | Default |
| --- | --- | --- |
| *deleteRemoteConfirmThreshold* | *number* | `10` |

```json
{
  "deleteRemoteConfirmThreshold": 10
}
```

### renameRemoteOnLocalRename
Rename or move the file on the server when it is renamed or moved locally, instead of uploading it again and deleting the old path. <br>
The server-side rename keeps the file's identity (permissions, ownership) and leaves no window in which the path is missing — which matters when the remote is a live document root. Moving into a folder that doesn't exist yet on the server creates it; if the source is not on the server at all, the file is uploaded instead.

| Key | Value | Default |
| --- | --- | --- |
| *renameRemoteOnLocalRename* | *boolean* | `true` |

```json
{
  "renameRemoteOnLocalRename": true
}
```

### remoteTrash
Move deleted remote files to a trash folder instead of removing them outright, so a mistaken deletion can be undone. <br>
Deleting becomes a server-side `rename` to `<trash>/<timestamp>/<path relative to remotePath>`, which costs no bandwidth. The original path is preserved inside the trash, so a restore is unambiguous even when two deleted files share a basename.

The trash folder is excluded from `ignore` automatically: a sync will neither download it nor delete it.

Use `SFTP: Undo Last Remote Deletion` to restore the whole last batch, `SFTP: Restore from Remote Trash` to pick from the history, and `SFTP: Empty Remote Trash` to purge it.

#### enabled
Whether deletions go through the trash.

| Key | Value | Default |
| --- | --- | --- |
| *enabled* | *boolean* | `true` |

#### path
Trash folder, relative to `remotePath` unless it starts with `/`, in which case it is an absolute path on the server. <br>
Use an absolute path outside the document root when the remote is served by a web server.

| Key | Value | Default |
| --- | --- | --- |
| *path* | *string* | `.sftp-trash` |

| 💡 Important |
| :--- |
| *Over FTP, prefer a name without a leading dot (for example `sftp-trash`). Many FTP servers omit dotfiles from a plain `LIST`, which makes the extension unable to tell an existing trash directory from a missing one.* |

#### retentionDays
Days to keep trashed files before they are purged. Purging runs in the background when the extension activates. `0` disables automatic purging.

| Key | Value | Default |
| --- | --- | --- |
| *retentionDays* | *number* | `7` |

```json
{
  "remoteTrash": {
    "enabled": true,
    "path": "/var/tmp/sftp-trash",
    "retentionDays": 14
  }
}
```

### remoteTimeOffsetInHours
The number of hours difference between the local machine and the remote server (remote minus local).

| Key | Value | Default |
| --- | --- | --- |
| *remoteTimeOffsetInHours* | *number* | `0` |

```json
{
  "remoteTimeOffsetInHours": 3
}
```

### remoteExplorer
Configure the behavior of the `remoteExplorer` command.

| Key | Value | Default |
| --- | --- | --- | 
| *remoteExplorer* | *object* | `{}` |
 
#### remoteExplorer.filesExclude
Configure that patterns for excluding files and folders. <br>
The Remote Explorer decides which files and folders to show or hide based on this setting..

| Key | Value |
| --- | --- |
| *remoteExplorer.filesExclude* | *string[]* |

#### remoteExplorer.order

| Key | Value |
| --- | --- |
| *remoteExplorer.order* | *number* |
```json
{
  "remoteExplorer": {
    "filesExclude": [],
    "order": 0
  }
}
```

### concurrency
Lowering the concurrency could get more stability because some clients/servers have some sort of configured/hard coded limit.

| Key | Value | Default |
| --- | --- | --- |
| *concurrency* | *number* | `4` |

```json
{
  "concurrency": 3
}
```

### connectTimeout
The maximum connection time.

| Key | Value | Default |
| --- | --- | --- |
| *connectTimeout* | *number* | `10000` |

```json
{
  "connectTimeout": 15000
}
```

### limitOpenFilesOnRemote
Limit open file descriptors to the specific number in a remote server. <br>
Set to true for using default `limit(222)`.

| 💡 Important |
| :--- |
| *Do not set this unless you have to!* | 

| Key | Value | Default |
| --- | --- | --- |
| *limitOpenFilesOnRemote* | *mixed* | `false` |

```json
{
  "limitOpenFilesOnRemote": 15000
}
```


## SFTP only configuration

### agent
Path to ssh-agent's UNIX socket for ssh-agent-based user authentication. <br>
Windows users must set to 'pageant' for authenticating with Pagenat or (actual) path to a Cygwin "UNIX socket". <br>
It'd get more stability because some client/server have some sort of configured/hard coded limit.

| Key | Value |
| --- | --- |
| *agent* | *string* |

```json
{
  "agent": "/_subfolder_/agent"
}
```

### privateKeyPath
Absolute path to user private key.

| Key | Value |
| --- | --- |
| *privateKeyPath* | *string* |

```json
{
  "privateKeyPath": "/.ssh/key.pem"
}
```

### passphrase
For an encrypted private key, this is the passphrase string used to decrypt it. <br>
Set to 'true' for enable passphrase dialog. This will prevent from using cleartext passphrase in this config.

| Key | Value |
| --- | --- |
| *passphrase* | *mixed* |

```json
{
  "passphrase": true
}
```

### interactiveAuth
Enable keyboard interaction authentication mechanism. Set to 'true' to enable `verifyCode` dialog. <br>
For example using Google Authentication (multi-factor). Or pass array of predefined phrases to automatically enter them without user prompting.

| 💡 Note |
| :--- |
| *Requires the server to have keyboard-interactive authentication enabled.* | 

| Key | Value | Default |
| --- | --- | --- |
| *interactiveAuth* | *boolean*\|*string[]* | 'false' |

```json
{
  "interactiveAuth": true
}
```

### algorithms
Explicit overrides for the default transport layer algorithms used for the connection.

**Default**:
```json
{
  "algorithms": {
    "kex": [
      "ecdh-sha2-nistp256",
      "ecdh-sha2-nistp384",
      "ecdh-sha2-nistp521",
      "diffie-hellman-group-exchange-sha256"
    ],
    "cipher": [
      "aes128-gcm",
		"aes128-gcm@openssh.com",
		"aes256-gcm",
		"aes256-gcm@openssh.com",
		"aes128-cbc",
		"aes192-cbc",
		"aes256-cbc",
		"aes128-ctr",
		"aes192-ctr",
		"aes256-ctr"
    ],
    "serverHostKey": [
      "ssh-rsa",
      "ssh-dss",
      "ssh-ed25519",
      "ecdsa-sha2-nistp256",
      "ecdsa-sha2-nistp384",
      "ecdsa-sha2-nistp521",
      "rsa-sha2-512",
      "rsa-sha2-256"
    ],
    "hmac": [
      "hmac-sha2-256",
      "hmac-sha2-512"
    ]
  },
}
```

### sshConfigPath
Absolute path to your SSH configuration file.

| Key | Value | Default |
| --- | --- | --- |
| *sshConfigPath* | *string* | `~/.ssh/config` |

```json
{
  "sshConfigPath": "~/.ssh/config"
}
```

### sshCustomParams
Extra parameters appended to the SSH command used by "Open SSH in Terminal".

| Key | Value |
| --- | --- |
| *sshCustomParams* | *string* |

```json
{
  "sshCustomParams": "-g"
}
```


## FTP(s) only configuration

### secure
Set to true for both control and data connection encryption. <br>
Set to `control` for control encryption only, or `implicit` for implicitly encrypted control connection (this mode is deprecated in modern times, but usually uses port 990).

| Key | Value | Default |
| --- | --- | --- |
| *secure* | *mixed* | `false` |

```json
{
  "secure": control
}
```

### secureOptions
Additional options to be passed to `tls.connect()`.

| 💡 Note |
| :--- |
| *See [TLS connect options callback](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback).* | 

| Key | Value |
| --- | --- |
| *secureOptions* | *object* |

```json
{
  "secureOptions": {
    "enableTrace": true
  }
}
```

## External changes and upload verification

Since 1.24.0 a local change no longer goes "event → immediate upload". It goes through a small pipeline with state, so that what you changed locally is known to be on the server — and when it isn't, you are told and can fix it with a click.

```
save / watcher / scan / poll / command ─▶ change collector ─▶ upload plan ─▶ confirmation ─▶ run ─▶ verification ─▶ activity log + sync index
```

**Sync index.** One JSON per destination (server, port, `remotePath` and profile), stored as `sync-index/<key>.json` under the extension's storage for the workspace (VS Code's `storageUri`; nothing is written inside your project). For every file it remembers the size and local mtime of the last **verified** upload, and whether that upload failed. It is fed only by verified transfers — an upload that passed verification, a download as it landed on disk — and by the mirroring of deletions and renames; it never records an attempt as a success. It also remembers the files you chose to skip, and whether it has been **seeded** — by `SFTP: Rebuild Sync Index`, or by a manual scan whose plan you confirmed and uploaded; a plain `uploadOnSave` adds entries but does not seed it. `SFTP: Rebuild Sync Index` rebuilds it from the server.

**Collector.** Saves from the editor, watcher events, scan results and polling ticks all enter the same collector, keyed by path: a save also seen by the watcher is one upload, a file rewritten ten times in a burst is one upload. Editor saves are processed immediately; the rest is grouped for 700 ms (1.4 s at most). Ignored and upload-excluded paths are dropped at the door, a change to a path whose upload is in flight is deferred to the next pass rather than lost, and directories are expanded into their files.

**Scans.** A scan walks the local tree with `ignore` and `uploadExclude` pruning, compares each file's size and mtime with the index and plans the `new` and `modified` files. It runs on activation and on `sftp.json` reload ([externalChanges.scanOnStartup](#externalchangesscanonstartup)), on resume and on focus after five minutes or more ([externalChanges.scanOnResume](#externalchangesscanonresume)), on a timer ([watcher.pollInterval](#watcherpollinterval)) and on demand (`SFTP: Scan for External Changes`). On an unseeded index, automatic scans plan only `modified` files and ignore unindexed ones (counted in the output channel); a manual scan plans everything. An automatic scan is not repeated while an earlier scan plan is waiting for review; a manual one supersedes it.

**Plan.** Every batch is an upload plan: its source (watcher, scan, poll, command or git), one item per file with its reason (`new`, `modified`), status (`pending`, `uploading`, `verified`, `failed`, `skipped`, `stale`), attempts and error. Plans are listed in the **Upload plans** group of the SFTP Activity view; `SFTP: Preview Upload (Dry Run)` builds one without uploading, `SFTP: Upload Plan` runs it (or file by file from the view), `SFTP: Export Last Upload Report` writes it as Markdown, and plans can be removed or cleared. The status bar shows `↑N` pending and `✗N` failed uploads.

**Confirmation.** `modified` files below [externalChanges.confirmThreshold](#externalchangesconfirmthreshold) are uploaded right away; a plan that contains `new` files, exceeds the threshold or was caused by git asks first with a modal dialog (`Review plan` — the default —, `Upload N file(s)`, `Skip`). Skipped files are remembered in the index and not proposed again until they change.

**Run.** A plan is executed with one scheduler per server. Each file is checked again before it is sent (gone → `skipped`; changed → the item is refreshed) and after (rewritten during the upload → `stale`, sent once more). In automatic plans, files open in the editor with unsaved changes are skipped (`unsaved changes in the editor`) rather than saved and uploaded. Cancelled items — including those `SFTP: Cancel All Transfers` stops before they start — go back to `pending`. A plan built under one profile is never run against another.

**Verification.** Every transfer counts the bytes sent; [verifyUpload](#verifyupload) decides what is asked of the server afterwards — the size by default, optionally a digest — and [uploadRetries](#uploadretries) how many times a transient failure is retried before it is reported.

**Record.** Every transfer — from a command, a save or the watcher — is one entry in the SFTP Activity view, with its remote path, its verification result and a `Retry`; the 200 most recent entries survive a window reload (`activity-log.json` in the workspace storage). Failures that happen before a transfer starts (connection, credentials, permissions, missing source) are recorded too.

**First use.** After installing, run `SFTP: Rebuild Sync Index` once per server (or upload the project once and run a manual scan) so the extension knows what is already on the server. Until then, automatic scans only re-upload files it has already uploaded itself: the index is unseeded, unindexed files are ignored (and counted in the output channel), and you are told once per server — remembered per workspace — with `Build index now`, `Mark all as uploaded` and `Don't show again`. `SFTP: Rebuild Sync Index` lists the remote and local trees, records every file present on both sides with the same size (the remote mtime is not required to match: a deploy through git, rsync or CI never preserves it), reports `N indexed; M differ in size; K only local` and marks the index as seeded. `SFTP: Mark Local Files as Uploaded` reaches the same state without a connection, on your word: every local file is recorded as being on the server as it is now (flagged `assumed` in the index) — for a tree that has been mirrored for years, when listing tens of thousands of remote files would take longer than it is worth. From then on, every verified upload and every download keeps the index current.

Defaults that changed in 1.24.0: `externalChanges.scanOnStartup` and `externalChanges.scanOnResume` are on, `verifyUpload` is `stat` and `uploadRetries` is `2`. To get the previous behaviour back:

```json
{
  "externalChanges": {
    "scanOnStartup": false,
    "scanOnResume": false
  },
  "verifyUpload": "none",
  "uploadRetries": 0
}
```
