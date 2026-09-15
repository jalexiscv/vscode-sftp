import * as vscode from 'vscode';
import { COMMAND_ACTIVITY_REVEAL, COMMAND_PLAN_SHOW_MORE } from '../../constants';
import { ActivityEntry, ActivityStatus, getEntries } from '../activityLog';
import { getPlans } from '../uploadPlan';
import { isPlanRunning } from '../planRunner';
import {
  activityDescription,
  activityIcon,
  activityLabel,
  activityTooltip,
  IconSpec,
  planDescription,
  planIcon,
  planItemDescription,
  planItemIcon,
  planItemLabel,
  planItemTooltip,
  planLabel,
  planTooltip,
} from './format';
import {
  ActivityTreeNode,
  GroupNode,
  MoreNode,
  PLAN_ITEMS_PAGE,
  PlanItemNode,
  PlanNode,
  buildChildNodes,
  buildRootNodes,
  isGroupNode,
  isMoreNode,
  isPlaceholder,
  isPlanItemNode,
  isPlanNode,
  localPathOf,
  nodeId,
} from './nodes';

export { isPlaceholder } from './nodes';

/**
 * Renders the activity log and the upload plans as a tree.
 *
 * Two roots once there is a plan — "Upload plans" (one node per plan, newest
 * first, its items underneath) and "Activity" (the flat, newest-first log) —
 * and just the flat log while there is none. The log is bounded and every
 * change can reorder it, and a plan item changes status several times per
 * upload, so the view rebuilds on every refresh instead of tracking per-item
 * events; stable ids keep the selection and the expanded state across
 * rebuilds. Event-driven refreshes go through {@link scheduleRefresh}, which
 * folds a burst (a 400-file plan fires several changes per file) into one
 * rebuild every {@link REFRESH_DELAY_MS}; {@link refresh} rebuilds at once.
 */

// long enough to fold the log/plan/runner events of one upload into a single
// rebuild, short enough that the tree still reads as live
const REFRESH_DELAY_MS = 100;

// @types/vscode is pinned to 1.40, where ThemeIcon still has a private
// constructor and no color parameter. Both exist at runtime on every vscode
// this extension supports, so reach the real constructor through a local type.
type ThemeIconConstructor = new (id: string, color?: vscode.ThemeColor) => vscode.ThemeIcon;
const themeIcon = (vscode.ThemeIcon as unknown) as ThemeIconConstructor;

function toThemeIcon(spec: IconSpec): vscode.ThemeIcon {
  return spec.color
    ? new themeIcon(spec.id, new vscode.ThemeColor(spec.color))
    : new themeIcon(spec.id);
}

function makeCommand(node: ActivityTreeNode): vscode.Command | undefined {
  // Offered whenever the node has a local path: getTreeItem runs for every
  // visible node on every rebuild, and a stat per node turned each refresh of
  // a long plan into hundreds of blocking syscalls. The reveal command copes
  // with a file that is gone by then.
  const localPath = localPathOf(node);
  if (!localPath) {
    return undefined;
  }

  return {
    command: COMMAND_ACTIVITY_REVEAL,
    title: 'Abrir archivo local',
    arguments: [node],
  };
}

function groupItem(node: GroupNode): vscode.TreeItem {
  const isPlans = node.group === 'plans';
  const count = isPlans ? getPlans().length : getEntries().length;
  return {
    id: nodeId(node),
    label: isPlans ? 'Upload plans' : 'Activity',
    description: `${count}`,
    iconPath: new themeIcon(isPlans ? 'checklist' : 'history'),
    contextValue: isPlans ? 'sftpPlanGroup' : 'sftpActivityGroup',
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
  };
}

function planItem(node: PlanNode): vscode.TreeItem {
  const { plan } = node;
  return {
    id: nodeId(node),
    label: planLabel(plan),
    description: planDescription(plan),
    tooltip: planTooltip(plan),
    iconPath: toThemeIcon(planIcon(plan, isPlanRunning(plan.id))),
    contextValue: 'sftpPlan',
    collapsibleState:
      plan.items.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
  };
}

function planItemItem(node: PlanItemNode): vscode.TreeItem {
  const { item } = node;
  return {
    id: nodeId(node),
    label: planItemLabel(item),
    description: planItemDescription(item),
    tooltip: planItemTooltip(item),
    iconPath: toThemeIcon(planItemIcon(item)),
    contextValue: 'sftpPlanItem',
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    command: makeCommand(node),
  };
}

function moreItem(node: MoreNode): vscode.TreeItem {
  const left = node.total - node.shown;
  const next = Math.min(left, PLAN_ITEMS_PAGE);
  return {
    id: nodeId(node),
    label: `${left.toLocaleString()} more file(s)…`,
    description: `showing ${node.shown.toLocaleString()} of ${node.total.toLocaleString()}`,
    tooltip: `Show the next ${next.toLocaleString()} file(s) of this plan`,
    iconPath: new themeIcon('ellipsis'),
    contextValue: 'sftpPlanMore',
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    command: {
      command: COMMAND_PLAN_SHOW_MORE,
      title: 'Show More Files',
      arguments: [node],
    },
  };
}

function activityItem(entry: ActivityEntry): vscode.TreeItem {
  if (isPlaceholder(entry)) {
    return {
      label: 'No activity yet',
      contextValue: 'activity.empty',
      iconPath: new themeIcon('info'),
      collapsibleState: vscode.TreeItemCollapsibleState.None,
    };
  }

  const isRetryable = entry.status === ActivityStatus.Failed && Boolean(entry.retry);
  return {
    // a stable id keeps the selection across the full refreshes above
    id: nodeId(entry),
    label: activityLabel(entry),
    description: activityDescription(entry),
    tooltip: activityTooltip(entry),
    iconPath: toThemeIcon(activityIcon(entry)),
    contextValue: isRetryable ? 'activity.failed' : 'activity',
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    command: makeCommand(entry),
  };
}

export default class ActivityTreeDataProvider implements vscode.TreeDataProvider<ActivityTreeNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<ActivityTreeNode | undefined> =
    new vscode.EventEmitter<ActivityTreeNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<ActivityTreeNode | undefined> = this._onDidChangeTreeData
    .event;
  private _refreshTimer: any = null;
  // plan id -> items shown; absent means the first page. Grown by showMore,
  // never shrunk: a plan that was expanded stays expanded across refreshes.
  private _visibleItems = new Map<string, number>();

  /** Rebuilds the tree now. */
  refresh(): void {
    this._cancelScheduledRefresh();
    this._onDidChangeTreeData.fire();
  }

  /** Shows the next page of a plan's items and rebuilds the tree. */
  showMore(planId: string): void {
    this._visibleItems.set(planId, this._visibleItemsOf(planId) + PLAN_ITEMS_PAGE);
    this.refresh();
  }

  /** How many items of a plan the tree lists before its "more" row. */
  private _visibleItemsOf(planId: string): number {
    return this._visibleItems.get(planId) || PLAN_ITEMS_PAGE;
  }

  /**
   * Rebuilds the tree once, {@link REFRESH_DELAY_MS} after the first call of a
   * burst; calls made meanwhile are folded into that rebuild (it reads the
   * live state, so nothing is lost). A steady stream still refreshes every
   * {@link REFRESH_DELAY_MS} instead of waiting for it to end.
   */
  scheduleRefresh(): void {
    if (this._refreshTimer) {
      return;
    }
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._onDidChangeTreeData.fire();
    }, REFRESH_DELAY_MS);
    // unref'd so a pending rebuild never holds the process open
    if (typeof this._refreshTimer.unref === 'function') {
      this._refreshTimer.unref();
    }
  }

  /** Drops a pending scheduled rebuild. */
  dispose(): void {
    this._cancelScheduledRefresh();
  }

  private _cancelScheduledRefresh() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  getTreeItem(node: ActivityTreeNode): vscode.TreeItem {
    if (isGroupNode(node)) {
      return groupItem(node);
    }
    if (isPlanNode(node)) {
      return planItem(node);
    }
    if (isPlanItemNode(node)) {
      return planItemItem(node);
    }
    if (isMoreNode(node)) {
      return moreItem(node);
    }
    return activityItem(node);
  }

  getChildren(node?: ActivityTreeNode): ActivityTreeNode[] {
    // getEntries() and getPlans() are already sorted newest first
    if (!node) {
      return buildRootNodes(getEntries(), getPlans());
    }
    return buildChildNodes(node, getEntries(), getPlans(), planId => this._visibleItemsOf(planId));
  }
}
