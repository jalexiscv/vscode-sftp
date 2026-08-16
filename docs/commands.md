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

### SFTP: Cancel All Transfers
Stop the current transfers (upload and download).

### SFTP: Open SSH in Terminal
Open a terminal in VSCode and auto login to a specific server.


## Alt commands
An alternative command can be found when pressing `Alt` while opening a menu.

### Force Download
Download file but disregard ignore rules.

### Force Upload
Upload file but disregard ignore rules.
