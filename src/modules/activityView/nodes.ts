import { ActivityEntry, ActivityKind, ActivityStatus } from '../activityLog';
import { UploadPlan, UploadPlanItem } from '../uploadPlan';

/**
 * The element model of the activity tree, and the pure functions that build it.
 *
 * The tree has two kinds of roots once an upload plan exists — "Upload plans"
 * with one node per plan and its items underneath, and "Activity" with the
 * flat log — and falls back to the flat log alone while there are no plans, so
 * the view keeps looking as it always did until a plan shows up. Everything
 * here is data in, data out: no vscode, no module state, which is what lets
 * the grouping and the guards be unit tested and the commands unwrap the
 * argument the tree hands them.
 *
 * An activity entry is its own node (the log's object, so a retry looks up the
 * live entry by id); the other nodes carry a `nodeType` discriminator.
 */

export interface GroupNode {
  nodeType: 'group';
  group: 'plans' | 'activity';
}

export interface PlanNode {
  nodeType: 'plan';
  plan: UploadPlan;
}

export interface PlanItemNode {
  nodeType: 'planItem';
  plan: UploadPlan;
  item: UploadPlanItem;
}

export type ActivityTreeNode = GroupNode | PlanNode | PlanItemNode | ActivityEntry;

// activityLog numbers real entries from 1, so a negative id can never collide
// with one. It marks the row shown when there is nothing to display.
const PLACEHOLDER_ID = -1;

export const placeholder: ActivityEntry = {
  id: PLACEHOLDER_ID,
  kind: ActivityKind.Sync,
  status: ActivityStatus.Skipped,
  startedAt: 0,
};

export function isGroupNode(node: ActivityTreeNode | undefined): node is GroupNode {
  return Boolean(node) && (node as GroupNode).nodeType === 'group';
}

export function isPlanNode(node: ActivityTreeNode | undefined): node is PlanNode {
  return Boolean(node) && (node as PlanNode).nodeType === 'plan';
}

export function isPlanItemNode(node: ActivityTreeNode | undefined): node is PlanItemNode {
  return Boolean(node) && (node as PlanItemNode).nodeType === 'planItem';
}

export function isActivityEntry(node: ActivityTreeNode | undefined): node is ActivityEntry {
  return Boolean(node) && !('nodeType' in (node as object)) && typeof (node as ActivityEntry).id === 'number';
}

/** The empty-state row is a fake entry; commands must not act on it. */
export function isPlaceholder(node: ActivityTreeNode | undefined): boolean {
  return isActivityEntry(node) && node.id === PLACEHOLDER_ID;
}

/** The local file a node stands for, when it has one; what a click opens. */
export function localPathOf(node: ActivityTreeNode | undefined): string | undefined {
  if (isPlanItemNode(node)) {
    return node.item.localPath;
  }
  if (isActivityEntry(node) && !isPlaceholder(node)) {
    return node.localPath;
  }
  return undefined;
}

/**
 * A stable identity per node, so selection and expansion survive the full
 * refreshes the provider does. Activity ids are bare numbers; the prefixes keep
 * the other kinds out of their way.
 */
export function nodeId(node: ActivityTreeNode): string {
  if (isGroupNode(node)) {
    return `group:${node.group}`;
  }
  if (isPlanNode(node)) {
    return `plan:${node.plan.id}`;
  }
  if (isPlanItemNode(node)) {
    return `plan:${node.plan.id}:${node.item.localPath}`;
  }
  return String(node.id);
}

/**
 * The roots: both groups when there is at least one plan, the flat log (or
 * its placeholder) otherwise.
 */
export function buildRootNodes(entries: ActivityEntry[], plans: UploadPlan[]): ActivityTreeNode[] {
  if (plans.length === 0) {
    return activityRows(entries);
  }

  return [
    { nodeType: 'group', group: 'plans' },
    { nodeType: 'group', group: 'activity' },
  ];
}

export function buildChildNodes(
  node: ActivityTreeNode,
  entries: ActivityEntry[],
  plans: UploadPlan[]
): ActivityTreeNode[] {
  if (isGroupNode(node)) {
    return node.group === 'plans' ? plans.map(planNode) : activityRows(entries);
  }
  if (isPlanNode(node)) {
    return node.plan.items.map(item => planItemNode(node.plan, item));
  }
  // plan items and activity entries are leaves
  return [];
}

export function planNode(plan: UploadPlan): PlanNode {
  return { nodeType: 'plan', plan };
}

export function planItemNode(plan: UploadPlan, item: UploadPlanItem): PlanItemNode {
  return { nodeType: 'planItem', plan, item };
}

function activityRows(entries: ActivityEntry[]): ActivityTreeNode[] {
  // entries come newest first already
  return entries.length > 0 ? entries : [placeholder];
}
