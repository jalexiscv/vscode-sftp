import * as vscode from 'vscode';
import { EXTENSION_NAME } from './constants';

export function getOpenTextDocuments(): vscode.TextDocument[] {
  return vscode.workspace.textDocuments;
}

export function getUserSetting(section: string, resource?: vscode.Uri | null | undefined) {
  return vscode.workspace.getConfiguration(section, resource);
}

export function executeCommand(command: string, ...rest: any[]): Thenable<any> {
  return vscode.commands.executeCommand(command, ...rest);
}

export function onWillSaveTextDocument(
  listener: (e: vscode.TextDocumentWillSaveEvent) => any,
  thisArgs?: any
) {
  return vscode.workspace.onWillSaveTextDocument(listener, thisArgs);
}

export function onDidSaveTextDocument(listener: (e: vscode.TextDocument) => any, thisArgs?: any) {
  return vscode.workspace.onDidSaveTextDocument(listener, thisArgs);
}

// notebook documents (e.g. .ipynb) don't fire onDidSaveTextDocument.
// The notebook api exists since vscode 1.67 and our engine allows 1.64,
// so probe for it at runtime; on older hosts it returns a noop disposable.
export function onDidSaveNotebookDocument(listener: (uri: vscode.Uri) => any, thisArgs?: any) {
  const workspace = vscode.workspace as any;
  if (typeof workspace.onDidSaveNotebookDocument !== 'function') {
    return {
      dispose() {
        // noop: api not available on this vscode
      },
    } as vscode.Disposable;
  }

  return workspace.onDidSaveNotebookDocument(
    notebook => listener(notebook.uri),
    thisArgs
  ) as vscode.Disposable;
}

export function onDidOpenTextDocument(listener: (e: vscode.TextDocument) => any, thisArgs?: any) {
  return vscode.workspace.onDidOpenTextDocument(listener, thisArgs);
}

const noopDisposable: vscode.Disposable = {
  dispose() {
    // noop: api not available on this vscode
  },
};

// The workspace file operation events (onDidDeleteFiles, onDidRenameFiles,
// onDidCreateFiles) exist since vscode 1.43 but @types/vscode is pinned to
// 1.40 here, so they are probed at runtime and typed locally. They only fire
// for operations performed *through* vscode (explorer, refactorings), never
// for external ones such as `git checkout` or `rm` — the FileSystemWatcher
// covers those.
function probeWorkspaceEvent<T>(
  name: string,
  listener: (e: T) => any,
  thisArgs?: any
): vscode.Disposable {
  const workspace = vscode.workspace as any;
  if (typeof workspace[name] !== 'function') {
    return noopDisposable;
  }

  return workspace[name](listener, thisArgs) as vscode.Disposable;
}

export interface FileDeleteEvent {
  readonly files: ReadonlyArray<vscode.Uri>;
}

export interface FileCreateEvent {
  readonly files: ReadonlyArray<vscode.Uri>;
}

export interface FileRenameEvent {
  readonly files: ReadonlyArray<{ readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }>;
}

export function onDidDeleteFiles(listener: (e: FileDeleteEvent) => any, thisArgs?: any) {
  return probeWorkspaceEvent<FileDeleteEvent>('onDidDeleteFiles', listener, thisArgs);
}

export function onDidCreateFiles(listener: (e: FileCreateEvent) => any, thisArgs?: any) {
  return probeWorkspaceEvent<FileCreateEvent>('onDidCreateFiles', listener, thisArgs);
}

export function onDidRenameFiles(listener: (e: FileRenameEvent) => any, thisArgs?: any) {
  return probeWorkspaceEvent<FileRenameEvent>('onDidRenameFiles', listener, thisArgs);
}

export function pathRelativeToWorkspace(localPath) {
  return vscode.workspace.asRelativePath(localPath);
}

export function getActiveTextEditor() {
  return vscode.window.activeTextEditor;
}

export function getWorkspaceFolders() {
  return vscode.workspace.workspaceFolders;
}

export function refreshExplorer() {
  return executeCommand('workbench.files.action.refreshFilesExplorer');
}

export function focusOpenEditors() {
  return executeCommand('workbench.files.action.focusOpenEditorsView');
}

export function showTextDocument(uri: vscode.Uri, option?: vscode.TextDocumentShowOptions) {
  return vscode.window.showTextDocument(uri, option);
}

export function diffFiles(leftFsPath, rightFsPath, title, option?) {
  const leftUri = vscode.Uri.file(leftFsPath);
  const rightUri = vscode.Uri.file(rightFsPath);

  return executeCommand('vscode.diff', leftUri, rightUri, title, option);
}

export function promptForPassword(prompt: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    ignoreFocusOut: true,
    password: true,
    prompt,
  }) as Promise<string | undefined>;
}

export function setContextValue(key: string, value: any) {
  executeCommand('setContext', EXTENSION_NAME + '.' + key, value);
}

export function showErrorMessage(message: string, ...items: string[]) {
  return vscode.window.showErrorMessage(message, ...items);
}

export function showInformationMessage(message: string, ...items: string[]) {
  return vscode.window.showInformationMessage(message, ...items);
}

export function showWarningMessage(message: string, ...items: string[]) {
  return vscode.window.showWarningMessage(message, ...items);
}

export async function showConfirmMessage(
  message: string,
  confirmLabel: string = 'Yes',
  cancelLabel: string = 'No'
) {
  const result = await vscode.window.showInformationMessage(
    message,
    { title: confirmLabel },
    { title: cancelLabel }
  );

  return Boolean(result && result.title === confirmLabel);
}

// A three-way prompt. Returns the title of the picked button, or undefined
// when the notification is dismissed. `modal` blocks the window, which is what
// destructive confirmations want so they can't be missed.
export async function showChoiceMessage(
  message: string,
  choices: string[],
  option: { modal?: boolean; warning?: boolean } = {}
): Promise<string | undefined> {
  const items = choices.map(title => ({ title }));
  const show = option.warning
    ? vscode.window.showWarningMessage
    : vscode.window.showInformationMessage;
  const result = await show.call(
    vscode.window,
    message,
    { modal: Boolean(option.modal) },
    ...items
  );

  return result ? (result as { title: string }).title : undefined;
}

/**
 * A cancellable progress notification. Wrapped here so modules can be tested
 * with a stand-in: the default vscode mock returns a value that never settles
 * when awaited.
 */
export function withProgress<R>(
  options: { title: string; cancellable?: boolean },
  task: (
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ) => Thenable<R>
): Thenable<R> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.title,
      cancellable: Boolean(options.cancellable),
    },
    task
  );
}

export function showQuickPick<T extends vscode.QuickPickItem>(
  items: T[] | Thenable<T[]>,
  options?: vscode.QuickPickOptions
): Thenable<T | undefined> {
  return vscode.window.showQuickPick(items, options) as Thenable<T | undefined>;
}

export function showOpenDialog(options: vscode.OpenDialogOptions) {
  return vscode.window.showOpenDialog(options);
}

export function openFolder(uri?: vscode.Uri, newWindow?: boolean) {
  return executeCommand('vscode.openFolder', uri, newWindow);
}

export function registerCommand(
  context: vscode.ExtensionContext,
  name: string,
  callback: (...args: any[]) => any,
  thisArg?: any
) {
  const disposable = vscode.commands.registerCommand(name, callback, thisArg);
  context.subscriptions.push(disposable);
}

export function addWorkspaceFolder(...workspaceFoldersToAdd: { uri: vscode.Uri; name?: string }[]) {
  return vscode.workspace.updateWorkspaceFolders(0, 0, ...workspaceFoldersToAdd);
}
