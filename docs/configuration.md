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
- [downloadOnOpen](#downloadonopen)
- [syncOption](#syncoption)
- [ignore](#ignore)
- [ignoreFile](#ignorefile)
- [ignoreTempFiles](#ignoretempfiles)
- [tempFilePatterns](#tempfilepatterns)
- [watcher](#watcher)
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
This is the same behavior as gitignore, all paths relative to context of the current configuration.
 
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

### watcher
Configure the behavior of the `watcher` command.

| Key | Value | Default |
| --- | --- | --- |
| *watcher* | *object* | `{}` |

#### watcher.files
Glob patterns that are watched and when edited outside of the VSCode editor are processed.

| 💡 Important |
| :--- |
| *Set* `uploadOnSave` *to* `false` *when you watch everything.*| 

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
```json
{
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": true
  },
}
```

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

Deletions are also skipped for files matched by `ignore`, for files with a transfer in flight, and while auto sync is paused.

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
