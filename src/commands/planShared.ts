import { showInformationMessage, showQuickPick } from '../host';
import { isPlanItemNode, isPlanNode } from '../modules/activityView/nodes';
import {
  formatSummary,
  getLatestPlan,
  getPlan,
  getPlans,
  summarize,
  UploadPlan,
  UploadPlanItem,
} from '../modules/uploadPlan';
import { formatTime, planLabel } from '../modules/activityView/format';

/**
 * How the plan commands find the plan they act on.
 *
 * From the activity view's context menu the command receives the tree node it
 * was invoked on; from the palette or the view title it receives nothing and
 * has to ask. The node may predate an update of the registry, so the live plan
 * is always looked up by id.
 */

export interface ResolvedPlanItem {
  plan: UploadPlan;
  item: UploadPlanItem;
}

/** The live plan behind a plan or plan-item node; undefined for anything else. */
export function planFromArg(arg: unknown): UploadPlan | undefined {
  if (isPlanNode(arg as any) || isPlanItemNode(arg as any)) {
    return getPlan((arg as { plan: UploadPlan }).plan.id);
  }
  return undefined;
}

/** The live plan and item behind a plan-item node; undefined for anything else. */
export function planItemFromArg(arg: unknown): ResolvedPlanItem | undefined {
  if (!isPlanItemNode(arg as any)) {
    return undefined;
  }

  const node = arg as { plan: UploadPlan; item: UploadPlanItem };
  const plan = getPlan(node.plan.id);
  if (!plan) {
    return undefined;
  }

  const localPath = node.item.localPath;
  const item = plan.items.find(candidate => candidate.localPath === localPath);
  return item ? { plan, item } : undefined;
}

interface PlanPickItem {
  label: string;
  description: string;
  detail: string;
  plan: UploadPlan;
}

/**
 * The plan a command should act on: the one behind `arg` when it is a node,
 * the only one when there is a single plan, a QuickPick when there are
 * several, and an information message (resolving undefined) when there are
 * none.
 */
export async function pickPlan(arg: unknown, placeHolder: string): Promise<UploadPlan | undefined> {
  const fromArg = planFromArg(arg);
  if (fromArg) {
    return fromArg;
  }

  const plans = getPlans();
  if (plans.length === 0) {
    showInformationMessage('SFTP: there is no upload plan yet. Run "SFTP: Preview Upload (Dry Run)" to create one.');
    return undefined;
  }
  if (plans.length === 1) {
    return getLatestPlan();
  }

  const items: PlanPickItem[] = plans.map(plan => ({
    label: planLabel(plan),
    description: formatSummary(summarize(plan)),
    detail: `${plan.id} · created ${formatTime(plan.createdAt)}`,
    plan,
  }));

  const picked = await showQuickPick(items, { placeHolder, matchOnDescription: true });
  return picked ? picked.plan : undefined;
}
