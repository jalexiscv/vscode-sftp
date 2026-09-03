## Common commands

### SFTP: Config
Create a new configuration file for a project.

### SFTP: Set Profile
Set the current profile.
           
#### KeyBindings Args
func(profileName: string)

### SFTP: Upload Active File
Upload the current file.

### SFTP: Upload Changed Files
Upload all files changed or created since the last commit to your Git.
Can be called by default keyboard shortcut `Ctrl+Alt+U`.

### SFTP: Upload Active Folder
Upload the entire folder the current file is located in.

### SFTP: Download Active File
Download the remote version of the current file and overwrite the local copy.

### SFTP: Download Active Folder
Download the entire folder the current file is located in.

### SFTP: Sync Local -> Remote
1. Any files that exist on both local and remote that have a different timestamp between local and remote are copied over.
2. Any files that only exist on the local are copied over.

You can change the default behavior by [syncOption](https://github.com/Natizyskunk/vscode-sftp/wiki/Configuration#syncoption).

### SFTP: Sync Remote -> Local
Same as `Sync Local -> Remote`, but in the opposite direction.

### SFTP: Sync Both Directions
Compare file modification times, and will always perform the action that causes the newest file to be present in both locations.

*Only [skipCreate](https://github.com/Natizyskunk/vscode-sftp/wiki/Configuration#syncoptionskipcreate) and [ignoreExisting](https://github.com/Natizyskunk/vscode-sftp/wiki/Configuration#syncoptionignoreexisting) are valid for this command.*

### SFTP: List Active Folder
List the folder the current file is located in.

### sftp.upload
Upload file or folders.

#### KeyBindings Args
func(fspaths: string[])

### sftp.download
Download file or folders.

#### KeyBindings Args
func(fspaths: string[])

### SFTP: Pause Auto Sync / SFTP: Resume Auto Sync / SFTP: Pause/Resume Auto Sync
Suspend every *automatic* transfer: `uploadOnSave`, `downloadOnOpen`, the watcher, and the mirroring of local deletions and renames.

Explicit commands keep working while paused — running a command *is* how you override the pause for one operation. The state is stored per workspace and survives a window reload, and the status bar shows a `$(debug-pause)` marker while it is active.

### SFTP: Undo Last Remote Deletion
Restore the most recent batch of deletions from the remote trash.

Restores the whole batch rather than a single file: deleting a folder locally produces one trash entry per file, and bringing back only one of them would leave the tree half restored. Requires [remoteTrash](https://github.com/Natizyskunk/vscode-sftp/wiki/Configuration#remotetrash) to be enabled.

### SFTP: Restore from Remote Trash
Pick any entry from the trash history and restore it to its original remote path.

The restore refuses to overwrite: if something already occupies the original path, it reports the conflict instead of replacing what is there.

### SFTP: Empty Remote Trash
Permanently delete the remote trash folder of every configured server. Asks for confirmation with a modal dialog, since this is the point at which deletions stop being recoverable.

### SFTP: Refresh Activity / SFTP: Clear Activity / SFTP: Retry All Failed Operations
Act on the **SFTP Activity** view, the second view in the SFTP sidebar container. It records every transfer, deletion and rename with its type, status, time, path, profile, duration and error.

Failed entries can be retried individually with the inline button, or all at once with `Retry All Failed Operations` — retries run one after another so a failing server is not hammered. The view can be hidden with the `sftp.showActivityView` setting.

### SFTP: Scan for External Changes
Compare the local tree of a server with its **sync index** — what was last uploaded and verified, file by file — and upload whatever changed since, whether it was edited by another tool, rewritten by a `git pull` in a terminal, or modified while VS Code was closed.

The scan walks the local tree with `ignore` and `uploadExclude` pruning (progress is shown and can be cancelled), never lists the server, and produces an upload plan of `new` files (never seen by the sync index) and `modified` files (indexed and changed since their last verified upload); files you skipped earlier are not proposed again until they change. `modified` files below [externalChanges.confirmThreshold](configuration.md#externalchangesconfirmthreshold) are uploaded right away; a plan that contains `new` files, exceeds the threshold or was caused by git asks first with a modal dialog (`Review plan` — the default —, `Upload N file(s)`, `Skip`; `Skip` is remembered). With several servers configured, a QuickPick asks which one to scan. The same scan runs on its own on activation, on `sftp.json` reload, on resume and on focus (see [externalChanges](configuration.md#externalchanges)) and, optionally, on a timer (`watcher.pollInterval`) — but automatic scans only plan `modified` files until the index has been seeded.

A manual scan whose plan you confirm and upload seeds the index, like `SFTP: Rebuild Sync Index` does. On an unseeded index it plans every unindexed file as `new`, so build the index first unless that is what you want.

### SFTP: Rebuild Sync Index
Rebuild the sync index of a server from what is actually there: the remote tree (respecting `ignore` and `uploadExclude`, and skipping the remote trash) is listed and compared with the local one, and every file present on both sides with the same size is recorded as verified — the remote mtime is not required to match, since a deploy through git, rsync or CI never preserves it. Files that differ in size or exist on one side only are left out, so the next scan reports them as `modified` or `new`. The summary reads `N indexed; M differ in size; K only local`, and the index is marked as seeded: from then on automatic scans plan new files too, behind a confirmation.

Run it once per server after installing, or after switching servers or restoring a backup on the remote; until then automatic scans only re-upload files the extension already uploaded itself, and it reminds you once per server (`Build index now` / `Don't show again`). Progress can be cancelled, in which case the index is left as it was.

### SFTP: Preview Upload (Dry Run)
Show what *would* be uploaded — without uploading anything. Pick the server (if there are several) and the scope: the whole project, the folder of the active file, or any folder inside the project. The local tree is scanned and compared with the sync index, and the result is shown as a pending plan in the **Upload plans** group of the SFTP Activity view, with a summary such as `12 file(s) would be uploaded (3 new, 9 modified); 40 unchanged` and an `Upload all` button. If nothing would be uploaded no plan is created.

### SFTP: Upload Plan
Run a pending upload plan. Picks the plan (QuickPick if there is more than one) and uploads its pending items through one scheduler per server, re-checking each file before sending it (gone → `skipped`, changed since it was planned → refreshed) and after (rewritten during the upload → `stale`, sent once more). Every item ends as `verified` or `failed` with its reason, and the summary is shown when the plan finishes. A plan that is already running, or has nothing pending, is refused.

### SFTP: Export Last Upload Report
Open the most recent upload plan as a Markdown document — id, server, profile, source, dates, summary, bytes, and one line per file with its status, reason, attempts, duration and error — ready to be saved or pasted into a ticket. From the view, the same action on a plan exports that plan.

### SFTP: Clear Upload Plans
Remove every upload plan from the **Upload plans** group after a confirmation. Plans that are still running are kept and reported.

### Upload plan actions in the SFTP Activity view
As soon as a plan exists, the SFTP Activity view shows two groups: **Upload plans** and **Activity**. A plan node reads `HH:mm:ss · <source> · <server>` with a summary (`N files — V verified, F failed, P pending`); its children are the files, each with its status, reason and path. Clicking a file opens the local copy. The context menus and inline buttons offer:

| Action | On | What it does |
| :--- | :--- | :--- |
| `Upload Plan` | a plan | Same as the command: uploads the pending items of that plan. |
| `Export Last Upload Report` | a plan | Exports that plan as Markdown. |
| `Remove Plan` | a plan | Drops the plan from the list (not while it is running). |
| `Upload This File` | a file | Uploads only that item. |
| `Skip` | a file | Marks the item `skipped`; the plan closes once nothing is pending. |
| `Diff with Remote` | a file | Opens the diff between the local file and its remote copy. |

The status bar shows `↑N` files pending upload (collector queue plus pending plan items) and `✗N` failed uploads from the recent plans.

### SFTP: Cancel All Transfers
Stop the current transfers (upload and download). Items of an upload plan that had not started yet go back to `pending`.

### SFTP: Open SSH in Terminal
Open a terminal in VSCode and auto login to a specific server.


## Alt commands
An alternative command can be found when pressing `Alt` while opening a menu.

### Force Download
Download file but disregard ignore rules.

### Force Upload
Upload file but disregard the `ignore` and `uploadExclude` rules.
