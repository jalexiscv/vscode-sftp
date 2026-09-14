- [Error: Failure](#error-failure)
	- [Error: Failure - Solution One](#error-failure---solution-one)
	- [Error: Failure - Solution Two](#error-failure---solution-two)
- [Error: Connection closed](#error-connection-closed)
- [Error: Clicking Upload Changed Files does not work](#error-clicking-upload-changed-files-does-not-work)
- [ENFILE: file table overflow ...](#enfile-file-table-overflow-)
	- [ENFILE: file table overflow ... - Solution for MacOS harsh limit](#enfile-file-table-overflow----solution-for-macos-harsh-limit)
- [How do I upload content inside a folder, but not the folder itself?](#how-do-i-upload-content-inside-a-folder-but-not-the-folder-itself)
- [How can I upload files as root?](#how-can-i-upload-files-as-root)
- [Automatically sync both ways without user interaction](#automatically-sync-both-ways-without-user-interaction)
- [How do I upload files that changed while VS Code was closed?](#how-do-i-upload-files-that-changed-while-vs-code-was-closed)
- [How do I know an upload really succeeded?](#how-do-i-know-an-upload-really-succeeded)
- [Show dotfiles/hidden files in remote explorer](#show-dotfileshidden-files-in-remote-explorer)

## Error: Failure

The failure error message comes from the remote side and is more or less the default/generic error 
message that sftp server sends when a syscall fails or something similar happens.
To know what exactly is going wrong you could try to enable debug output for the sftp server 
and then execute your transfers again and see what (if anything) shows up in the logs there.

### Error: Failure - Solution One

Change `remotePath` to the actual path if it's a symlink.

### Error: Failure - Solution Two

The problem could be that your server runs out of file descriptors.
You should try to increase the file descriptors limit.
If you don't have the permission to do this, set [limitOpenFilesOnRemote](https://github.com/Natizyskunk/vscode-sftp/wiki/Configuration#limitopenfilesonremote) option in your config.

## Error: Connection closed

The problem could be that the SFTP extension keeps closing the connection for those who use more legacy/old systems.
You'll have to Explicitly override the default transport layer algorithms used for the connection to remove the new `"diffie-hellman-group-exchange-sha256"` algorithm that cause the problem from the `kex` section. Just add this in your `sftp.json` configuration file, which should make it work.
```json
{
	"algorithms": {
		"kex": [
			"ecdh-sha2-nistp256", 
			"ecdh-sha2-nistp384", 
			"ecdh-sha2-nistp521"
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
			"rsa-sha2-256",
			"rsa-sha2-512"
		],
		"hmac": [
			"hmac-sha2-256", 
			"hmac-sha2-512"
		]
	}
}
```

## Error: Clicking Upload Changed Files does not work

See [vscode-sftp issue #854](https://github.com/liximomo/vscode-sftp/issues/854).

**@PaPa31** added a fix to make the 'Upload Changed Files' command visible and added a default keyboard shortcut to call it.
<!-- **danieleiobbi** has a workaround to create a keyboard shortcut. -->

![upload changed files keyboard shortcut](assets/faq/upload_changed_files_shortcut.png)

## ENFILE: file table overflow ...

MacOS have a harsh limit on number of open files.

### ENFILE: file table overflow ... - Solution for MacOS harsh limit

Run those command:
```sh
echo kern.maxfiles=65536 | sudo tee -a /etc/sysctl.conf
echo kern.maxfilesperproc=65536 | sudo tee -a /etc/sysctl.conf
sudo sysctl -w kern.maxfiles=65536
sudo sysctl -w kern.maxfilesperproc=65536
ulimit -n 65536
```

## How do I upload content inside a folder, but not the folder itself?

See [vscode-sftp issue #852](https://github.com/liximomo/vscode-sftp/issues/852).

As quoted from **raoul2000**, "as long as you set the `context` property to `./[path]` (e.g., `./build`), it
will work."

Example configuration (where all JS and HTML files in `./build` will be copied to `/folder1/folder2/folder3`):
```json
{
  "name": "My Server",
  "host": "<host_ip_address>",
  "protocol": "sftp",
  "port": 22,
  "username": "user1",
  "remotePath": "/folder1/folder2/folder3",
  "context": "./build",
  "uploadOnSave": false,
  "watcher": {
    "files": "*.{js,html}",
    "autoUpload": true,
    "autoDelete": false
  }
}
```

## How do I keep a folder from being uploaded, but still be able to download it?

Use `uploadExclude` (since 1.25.0). It takes the same gitignore patterns as `ignore`, but only applies to what goes from your machine to the server: nothing matched by it is uploaded by any command, by `uploadOnSave`, by the watcher, by a scan or by `Sync Local -> Remote`, and deleting or renaming it locally leaves the server copy alone — while `Download Folder`, `Sync Remote -> Local`, the Remote Explorer and diffs still see it. Typical entries are folders the server owns (`/storage`, `/public/uploads`, logs and caches) and local files that must never reach it (`*.env`):

```json
{
  "ignore": [".git", "node_modules"],
  "uploadExclude": ["/storage", "/public/uploads", "*.env"]
}
```

`ignore` remains the list for paths that must not be transferred in either direction. `Force Upload` bypasses both. See [uploadExclude](docs/configuration.md#uploadexclude).

## How can I upload files as root?

See [vscode-sftp issue #559](https://github.com/liximomo/vscode-sftp/issues/559).

**Yevhen-development** has a workaround, but it may not work for everyone.  In `sftp.json`, set the
following:
```json
"sshCustomParams": "sudo su -;"
```

## Automatically sync both ways without user interaction

See [vscode-sftp issue #136](https://github.com/Natizyskunk/vscode-sftp/issues/136).

> *This can also be used with **GIT** this way when you're checking out a branch or reverting changes/commits, your server will also be updated.*

```json
{
  "name": "My Server",
  "host": "<host_ip_address>",
  "protocol": "sftp",
  "port": 22,
  "username": "user1",
  "remotePath": "/folder1/folder2/folder3",
  "uploadOnSave": true, // Since 1.24.0 this can stay on: saves and watcher events share one change collector, so a save is uploaded once.
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": true
  }
  "syncOption": {
    "delete": true // Delete extraneous files from destination directories.
  },
}
```

Since 1.24.0 a batch of more than `externalChanges.confirmThreshold` files (20 by default), one caused by a git operation such as a checkout, or one that contains files the sync index has never seen, asks for confirmation before uploading — see [externalChanges](docs/configuration.md#externalchanges). Deletions go through the safeguards of [deleteRemoteOnLocalDelete](docs/configuration.md#deleteremoteonlocaldelete).

## How do I upload files that changed while VS Code was closed?

Nothing to configure. Since 1.24.0 the extension keeps a **sync index** of what was last uploaded and verified, file by file, and compares the local tree with it when it activates, when `sftp.json` is reloaded, when auto sync is resumed and when the window regains focus after a while. Whatever changed since its last verified upload — a `git pull` in a terminal, a code generator, edits made with the window closed — is uploaded through an upload plan; files the index has never seen, batches above `externalChanges.confirmThreshold` (20 by default) and batches caused by git are confirmed first (`Review plan`, `Upload N file(s)`, `Mark as uploaded` or `Skip` — `Skip` is remembered until the files change again, and `Mark as uploaded` records the files as being on the server already without transferring them). You can also run it by hand with `SFTP: Scan for External Changes`, and preview it with `SFTP: Preview Upload (Dry Run)`.

After installing, run `SFTP: Rebuild Sync Index` once per server (or upload the project once and run a manual scan) so the extension knows what is already on the server. Until then, automatic scans only re-upload files it has already uploaded itself, and it reminds you once per server (`Build index now` / `Mark all as uploaded` / `Don't show again`). If the local tree is what the server holds already and listing the server would take too long (tens of thousands of files over FTP), `SFTP: Mark Local Files as Uploaded` seeds the index from the local tree without connecting. From then on every verified upload keeps the index current. See [externalChanges](docs/configuration.md#externalchanges) and [External changes and upload verification](docs/configuration.md#external-changes-and-upload-verification).

## How do I know an upload really succeeded?

Every upload is verified after the protocol acknowledges it: the bytes sent are counted against the local size and, with the default `verifyUpload: "stat"`, the remote size must match exactly (`SIZE` over FTP). `verifyUpload: "hash"` additionally compares a digest of the remote file with the local one (over SSH with `sha256sum`/`shasum`/`openssl`/`md5sum`, over FTP with `XSHA256`/`XSHA1`/`XMD5`/`XCRC`/`HASH`) and falls back to `stat` when the server cannot compute one. A failed check is retried like a transient network error (`uploadRetries`, 2 by default; permanent errors such as permission denied are not retried) and then shown as a failed upload in the **SFTP Activity** view, with its reason and a `Retry`, and counted in the `✗N` marker of the status bar. The activity log survives a window reload, and `SFTP: Export Last Upload Report` writes the result of the last batch as Markdown. See [verifyUpload](docs/configuration.md#verifyupload).

## Show dotfiles/hidden files in remote explorer

### If using proftpd

Please edit the config file `proftpd.conf`. Depending on your installation, the default location for this file can be one of those :
- `/etc/proftpd.conf`
- `/etc/proftpd/proftpd.conf`
- `/usr/local/etc/proftpd.conf`
- `/usr/local/etc/proftpd/proftpd.conf`

Search for the `ListOptions` parameter and change it from `"-l"` to `"-la"`.

It should look like this : 
```conf
#Global settings
<Global>
[...]
ListOptions 		"-la"
[...]
</Global>
```
