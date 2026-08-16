import * as vscode from 'vscode';
import {
  COMMAND_ACTIVITY_REFRESH,
  COMMAND_ACTIVITY_RETRY,
  COMMAND_ACTIVITY_REVEAL,
  VIEW_ACTIVITY,
} from '../../constants';
import { reportError } from '../../helper';
import { registerCommand, showTextDocument, showWarningMessage } from '../../host';
import logger from '../../logger';
import { ActivityEntry, getEntry, onDidChange } from '../activityLog';
import ActivityTreeDataProvider, { isPlaceholder } from './treeDataProvider';

export default class ActivityView {
  private _activityView: vscode.TreeView<ActivityEntry>;
  private _treeDataProvider: ActivityTreeDataProvider;
  private _logSubscription: vscode.Disposable;

  constructor(context: vscode.ExtensionContext) {
    this._treeDataProvider = new ActivityTreeDataProvider();
    this._activityView = vscode.window.createTreeView(VIEW_ACTIVITY, {
      treeDataProvider: this._treeDataProvider,
    });

    this._logSubscription = onDidChange(() => this.refresh());

    registerCommand(context, COMMAND_ACTIVITY_REFRESH, () => this.refresh());
    registerCommand(context, COMMAND_ACTIVITY_RETRY, (item: ActivityEntry) => this.retry(item));
    registerCommand(context, COMMAND_ACTIVITY_REVEAL, (item: ActivityEntry) => this.reveal(item));
  }

  refresh(): void {
    this._treeDataProvider.refresh();
  }

  async retry(item: ActivityEntry): Promise<void> {
    const entry = this._resolve(item);
    if (!entry || !entry.retry) {
      showWarningMessage('SFTP: this operation cannot be retried.');
      return;
    }

    try {
      await entry.retry();
    } catch (error) {
      reportError(error, 'activity retry');
    }
  }

  async reveal(item: ActivityEntry): Promise<void> {
    const entry = this._resolve(item);
    if (!entry || !entry.localPath) {
      return;
    }

    try {
      await showTextDocument(vscode.Uri.file(entry.localPath));
    } catch (error) {
      // a single click shouldn't raise a modal: binaries and files removed
      // between the refresh and the click both land here
      logger.error(error, 'activity reveal');
    }
  }

  dispose(): void {
    this._logSubscription.dispose();
    this._activityView.dispose();
  }

  // The tree hands back the item it was rendered from, which may predate an
  // update of the log; look the live entry up so retry() sees the current state.
  private _resolve(item: ActivityEntry): ActivityEntry | undefined {
    if (!item || isPlaceholder(item)) {
      return undefined;
    }

    return getEntry(item.id) || item;
  }
}
