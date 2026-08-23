import * as vscode from 'vscode';
import {
  COMMAND_ACTIVITY_REFRESH,
  COMMAND_ACTIVITY_RETRY,
  COMMAND_ACTIVITY_REVEAL,
  VIEW_ACTIVITY,
} from '../../constants';
import { reportError } from '../../helper';
import { registerCommand, setContextValue, showTextDocument, showWarningMessage } from '../../host';
import logger from '../../logger';
import { ActivityEntry, getEntry, onDidChange } from '../activityLog';
import { getPlans, onDidChange as onDidChangePlans } from '../uploadPlan';
import { onDidChangeRunning } from '../planRunner';
import ActivityTreeDataProvider from './treeDataProvider';
import { ActivityTreeNode, isActivityEntry, isPlaceholder, localPathOf } from './nodes';

/**
 * The SFTP Activity view: the tree of upload plans and past operations, plus
 * the commands that act on its rows (refresh, retry, open the local file).
 *
 * It owns no state of its own — the log and the plan registry do — and only
 * wires their change events to a tree refresh. It also publishes the
 * `sftp.hasUploadPlans` context key so the plan actions in the view title can
 * show up only when there is something to act on.
 *
 * Key lifecycle methods:
 * - constructor: creates the tree view and registers the row commands.
 * - {@link refresh} rebuilds the tree.
 * - {@link dispose} drops the subscriptions and the view on deactivate.
 */
export default class ActivityView {
  private _activityView: vscode.TreeView<ActivityTreeNode>;
  private _treeDataProvider: ActivityTreeDataProvider;
  private _subscriptions: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext) {
    this._treeDataProvider = new ActivityTreeDataProvider();
    this._activityView = vscode.window.createTreeView(VIEW_ACTIVITY, {
      treeDataProvider: this._treeDataProvider,
      showCollapseAll: true,
    });

    this._subscriptions.push(onDidChange(() => this.refresh()));
    this._subscriptions.push(
      onDidChangePlans(() => {
        this._reflectPlanState();
        this.refresh();
      })
    );
    this._subscriptions.push(onDidChangeRunning(() => this.refresh()));
    this._reflectPlanState();

    registerCommand(context, COMMAND_ACTIVITY_REFRESH, () => this.refresh());
    registerCommand(context, COMMAND_ACTIVITY_RETRY, (node: ActivityTreeNode) => this.retry(node));
    registerCommand(context, COMMAND_ACTIVITY_REVEAL, (node: ActivityTreeNode) => this.reveal(node));
  }

  refresh(): void {
    this._treeDataProvider.refresh();
  }

  async retry(node: ActivityTreeNode): Promise<void> {
    const entry = this._resolve(node);
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

  async reveal(node: ActivityTreeNode): Promise<void> {
    const localPath = localPathOf(node);
    if (!localPath) {
      return;
    }

    try {
      await showTextDocument(vscode.Uri.file(localPath));
    } catch (error) {
      // a single click shouldn't raise a modal: binaries and files removed
      // between the refresh and the click both land here
      logger.error(error, 'activity reveal');
    }
  }

  dispose(): void {
    this._subscriptions.forEach(subscription => subscription.dispose());
    this._subscriptions = [];
    this._activityView.dispose();
  }

  private _reflectPlanState() {
    setContextValue('hasUploadPlans', getPlans().length > 0);
  }

  // The tree hands back the item it was rendered from, which may predate an
  // update of the log; look the live entry up so retry() sees the current state.
  private _resolve(node: ActivityTreeNode): ActivityEntry | undefined {
    if (!isActivityEntry(node) || isPlaceholder(node)) {
      return undefined;
    }

    return getEntry(node.id) || node;
  }
}
