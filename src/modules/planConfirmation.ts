import logger from '../logger';
import { simplifyPath } from '../helper';
import { executeCommand, showChoiceMessage } from '../host';
import { VIEW_ACTIVITY } from '../constants';
import { UploadPlan, PlanSummary, updateItem, summarize } from './uploadPlan';
import { runPlan } from './planRunner';

/**
 * The gate between "a plan exists" and "it runs": the confirmation threshold
 * shared by the change collector and the external-change scanner.
 *
 * Small batches upload on their own. A batch larger than
 * `externalChanges.confirmThreshold`, or one caused by a git operation
 * whatever its size, is shown to the user first — a `git checkout` that
 * touches 400 files should never reach the server by accident. The user can
 * upload it, leave it pending in the Activity view to trim it there, or skip
 * it altogether.
 *
 * Key lifecycle methods:
 * - {@link needsConfirmation} is the rule.
 * - {@link confirmAndRunPlan} applies it and runs the plan when allowed.
 */

export type PlanDecision = 'run' | 'review' | 'skip';

export interface ConfirmPlanOptions {
  serviceName: string;
  host?: string;
  /** batches above this many files ask first; 0 always asks */
  confirmThreshold: number;
  /**
   * false: hand the plan to the runner and return without waiting for the
   * uploads (the collector must not hold its next batch behind a long run).
   * Defaults to true.
   */
  awaitRun?: boolean;
}

export interface PlanRunOutcome {
  decision: PlanDecision;
  /** the plan's summary when the call returned (final only if the run was awaited) */
  summary: PlanSummary;
}

// how many paths the confirmation lists before "and N more"
const PREVIEW_LINES = 12;

const REVIEW_LABEL = 'Review plan';
const SKIP_LABEL = 'Skip';

export function needsConfirmation(plan: UploadPlan, confirmThreshold: number): boolean {
  return plan.source === 'git' || plan.items.length > confirmThreshold;
}

function describeOrigin(plan: UploadPlan): string {
  switch (plan.source) {
    case 'git':
      return 'changed — a git operation moved HEAD';
    case 'command':
      return 'were saved';
    default:
      return 'changed outside the editor';
  }
}

export function buildConfirmationMessage(plan: UploadPlan, options: ConfirmPlanOptions): string {
  const count = plan.items.length;
  const target = [options.serviceName, options.host].filter(part => Boolean(part)).join(' - ');
  const preview = plan.items
    .slice(0, PREVIEW_LINES)
    .map(item => `  • ${simplifyPath(item.localPath)}`)
    .join('\n');
  const more = count > PREVIEW_LINES ? `\n  … and ${count - PREVIEW_LINES} more` : '';

  return (
    `SFTP: ${count} local file(s) ${describeOrigin(plan)}. ` +
    `Upload them to ${target || 'the server'}?\n\n${preview}${more}`
  );
}

type Answer = PlanDecision | 'dismissed';

async function ask(plan: UploadPlan, options: ConfirmPlanOptions): Promise<Answer> {
  const uploadLabel = `Upload ${plan.items.length} file(s)`;
  const choice = await showChoiceMessage(
    buildConfirmationMessage(plan, options),
    [uploadLabel, REVIEW_LABEL, SKIP_LABEL],
    { modal: true }
  );

  if (choice === uploadLabel) {
    return 'run';
  }
  if (choice === SKIP_LABEL) {
    return 'skip';
  }
  if (choice === REVIEW_LABEL) {
    return 'review';
  }
  // the dialog dismissed: nothing is uploaded, nothing is lost — the plan
  // stays pending where the view and the status bar show it
  return 'dismissed';
}

/**
 * Applies the confirmation rule to `plan` and acts on the answer: runs it,
 * leaves it pending and focuses the Activity view, or skips every item.
 */
export async function confirmAndRunPlan(
  plan: UploadPlan,
  options: ConfirmPlanOptions
): Promise<PlanRunOutcome> {
  let answer: Answer = 'run';
  if (needsConfirmation(plan, options.confirmThreshold)) {
    answer = await ask(plan, options);
    logger.info(
      `[plan ${plan.id}] ${plan.items.length} file(s) from ${plan.source}: user chose "${answer}"`
    );
  }
  const decision: PlanDecision = answer === 'dismissed' ? 'review' : answer;

  switch (answer) {
    case 'skip':
      plan.items.forEach(item => {
        if (item.status === 'pending') {
          updateItem(plan.id, item.localPath, { status: 'skipped', error: 'skipped by user' });
        }
      });
      break;
    case 'review':
      // the view lists the plan with per-item upload/skip; focusing it is a
      // courtesy, not a requirement
      Promise.resolve(executeCommand(`${VIEW_ACTIVITY}.focus`)).then(undefined, error =>
        logger.debug(`[plan ${plan.id}] cannot focus the activity view: ${error.message}`)
      );
      break;
    case 'dismissed':
      break;
    default:
      if (options.awaitRun === false) {
        runPlan(plan.id).catch(error => logger.error(error, `plan ${plan.id}`));
      } else {
        await runPlan(plan.id);
      }
  }

  return { decision, summary: summarize(plan) };
}
