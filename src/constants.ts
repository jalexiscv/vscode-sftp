import * as path from 'path';

const VENDOR_FOLDER = '.vscode';

export const EXTENSION_NAME = 'sftp';
export const SETTING_KEY_REMOTE = 'remotefs.remote';

export const REMOTE_SCHEME = 'remote';

export const CONGIF_FILENAME = 'sftp.json';
export const CONFIG_PATH = path.join(VENDOR_FOLDER, CONGIF_FILENAME);

// clave de workspaceState donde se persiste el perfil activo entre sesiones
export const STATE_KEY_ACTIVE_PROFILE = 'sftp.state.activeProfile';

// clave de workspaceState donde se persiste la pausa de la sincronización automática
export const STATE_KEY_SYNC_PAUSED = 'sftp.state.syncPaused';

// clave de workspaceState donde se persiste el índice de la papelera remota
export const STATE_KEY_TRASH_INDEX = 'sftp.state.trashIndex';

// clave de workspaceState con las claves de índice de sincronización cuyo aviso
// de "índice sin construir" el usuario pidió no volver a ver
export const STATE_KEY_UNBUILT_INDEX_NOTICE_DISMISSED = 'sftp.state.unbuiltIndexNoticeDismissed';

// command not in package.json
export const COMMAND_TOGGLE_OUTPUT = 'sftp.toggleOutput';

// commands in package.json
export const COMMAND_CONFIG = 'sftp.config';
export const COMMAND_OPEN_CONNECTION_MANAGER = 'sftp.openConnectionManager';
export const COMMAND_SET_PROFILE = 'sftp.setProfile';
export const COMMAND_CANCEL_ALL_TRANSFER = 'sftp.cancelAllTransfer';
export const COMMAND_OPEN_CONNECTION_IN_TERMINAL = 'sftp.openConnectInTerminal';
export const COMMAND_FORGET_SAVED_PASSWORDS = 'sftp.forgetSavedPasswords';

export const COMMAND_FORCE_UPLOAD = 'sftp.forceUpload';
export const COMMAND_UPLOAD = 'sftp.upload';
export const COMMAND_UPLOAD_FILE = 'sftp.upload.file';
export const COMMAND_UPLOAD_CHANGEDFILES = 'sftp.upload.changedFiles';
export const COMMAND_UPLOAD_ACTIVEFILE = 'sftp.upload.activeFile';
export const COMMAND_UPLOAD_FOLDER = 'sftp.upload.folder';
export const COMMAND_UPLOAD_ACTIVEFOLDER = 'sftp.upload.activeFolder';
export const COMMAND_UPLOAD_PROJECT = 'sftp.upload.project';

export const COMMAND_FORCE_UPLOAD_TO_ALL_PROFILES = 'sftp.forceUpload.to.allProfiles';
export const COMMAND_UPLOAD_TO_ALL_PROFILES = 'sftp.upload.to.allProfiles';
export const COMMAND_UPLOAD_FILE_TO_ALL_PROFILES = 'sftp.upload.file.to.allProfiles';
export const COMMAND_UPLOAD_ACTIVEFILE_TO_ALL_PROFILES = 'sftp.upload.activeFile.to.allProfiles';
export const COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES = 'sftp.upload.folder.to.allProfiles';
export const COMMAND_UPLOAD_ACTIVEFOLDER_TO_ALL_PROFILES = 'sftp.upload.activeFolder.to.allProfiles';
export const COMMAND_UPLOAD_PROJECT_TO_ALL_PROFILES = 'sftp.upload.project.to.allProfiles';

export const COMMAND_FORCE_DOWNLOAD = 'sftp.forceDownload';
export const COMMAND_DOWNLOAD = 'sftp.download';
export const COMMAND_DOWNLOAD_FILE = 'sftp.download.file';
export const COMMAND_DOWNLOAD_ACTIVEFILE = 'sftp.download.activeFile';
export const COMMAND_DOWNLOAD_FOLDER = 'sftp.download.folder';
export const COMMAND_DOWNLOAD_ACTIVEFOLDER = 'sftp.download.activeFolder';
export const COMMAND_DOWNLOAD_PROJECT = 'sftp.download.project';

export const COMMAND_SYNC_LOCAL_TO_REMOTE = 'sftp.sync.localToRemote';
export const COMMAND_SYNC_REMOTE_TO_LOCAL = 'sftp.sync.remoteToLocal';
export const COMMAND_SYNC_BOTH_DIRECTIONS = 'sftp.sync.bothDirections';

export const COMMAND_DIFF = 'sftp.diff';
export const COMMAND_DIFF_ACTIVEFILE = 'sftp.diff.activeFile';
export const COMMAND_LIST = 'sftp.list';
export const COMMAND_LIST_ACTIVEFOLDER = 'sftp.listActiveFolder';
export const COMMAND_LIST_ALL = 'sftp.listAll';
export const COMMAND_DELETE_REMOTE = 'sftp.delete.remote';
export const COMMAND_REVEAL_IN_EXPLORER = 'sftp.revealInExplorer';
export const COMMAND_REVEAL_IN_REMOTE_EXPLORER = 'sftp.revealInRemoteExplorer';

export const COMMAND_REMOTEEXPLORER_REFRESH = 'sftp.remoteExplorer.refresh';
export const COMMAND_REMOTEEXPLORER_REFRESH_ACTIVE_FILE = 'sftp.remoteExplorer.refreshActiveFile';
export const COMMAND_REMOTEEXPLORER_EDITINLOCAL = 'sftp.remoteExplorer.editInLocal';
export const COMMAND_REMOTEEXPLORER_VIEW_CONTENT = 'sftp.viewContent';

export const COMMAND_CREATE_FOLDER = 'sftp.create.folder';
export const COMMAND_CREATE_FILE = 'sftp.create.file';

// pausa de la sincronización automática
export const COMMAND_TOGGLE_AUTO_SYNC = 'sftp.toggleAutoSync';
export const COMMAND_PAUSE_AUTO_SYNC = 'sftp.pauseAutoSync';
export const COMMAND_RESUME_AUTO_SYNC = 'sftp.resumeAutoSync';

// papelera remota
export const COMMAND_RESTORE_FROM_TRASH = 'sftp.trash.restore';
export const COMMAND_RESTORE_LAST_DELETION = 'sftp.trash.restoreLast';
export const COMMAND_EMPTY_TRASH = 'sftp.trash.empty';

// registro de actividad
export const COMMAND_ACTIVITY_REFRESH = 'sftp.activity.refresh';
export const COMMAND_ACTIVITY_CLEAR = 'sftp.activity.clear';
export const COMMAND_ACTIVITY_RETRY = 'sftp.activity.retry';
export const COMMAND_ACTIVITY_RETRY_ALL_FAILED = 'sftp.activity.retryAllFailed';
export const COMMAND_ACTIVITY_REVEAL = 'sftp.activity.reveal';

// nombre de la vista del registro de actividad (package.json > views)
export const VIEW_ACTIVITY = 'sftpActivity';

// planes de carga (vista de actividad)
export const COMMAND_PLAN_PREVIEW = 'sftp.plan.preview';
export const COMMAND_PLAN_UPLOAD_ALL = 'sftp.plan.uploadAll';
export const COMMAND_PLAN_UPLOAD_ITEM = 'sftp.plan.uploadItem';
export const COMMAND_PLAN_SKIP_ITEM = 'sftp.plan.skipItem';
export const COMMAND_PLAN_DIFF_ITEM = 'sftp.plan.diffItem';
export const COMMAND_PLAN_EXPORT_REPORT = 'sftp.plan.exportReport';
export const COMMAND_PLAN_REMOVE = 'sftp.plan.remove';
export const COMMAND_PLAN_CLEAR_ALL = 'sftp.plan.clearAll';
// "dar por subido": el usuario afirma que los archivos ya están en el servidor
export const COMMAND_PLAN_MARK_UPLOADED = 'sftp.plan.markUploaded';
export const COMMAND_PLAN_MARK_ITEM_UPLOADED = 'sftp.plan.markItemUploaded';

// comando que VS Code genera por el id de la vista; no se declara en package.json
export const COMMAND_ACTIVITY_FOCUS = `${VIEW_ACTIVITY}.focus`;

// detección de cambios externos e índice de sincronización
export const COMMAND_SCAN_EXTERNAL_CHANGES = 'sftp.scanExternalChanges';
export const COMMAND_REBUILD_SYNC_INDEX = 'sftp.rebuildSyncIndex';
export const COMMAND_MARK_LOCAL_TREE_UPLOADED = 'sftp.markLocalTreeUploaded';

// lista uploadExclude editada desde la interfaz (explorador y QuickPick)
export const COMMAND_UPLOAD_EXCLUDE_ADD = 'sftp.uploadExclude.add';
export const COMMAND_UPLOAD_EXCLUDE_REMOVE = 'sftp.uploadExclude.remove';
export const COMMAND_UPLOAD_EXCLUDE_MANAGE = 'sftp.uploadExclude.manage';
