import logger from '../logger';
import { simplifyPath } from '../helper';
import { FileService } from '../core';
import { executeCommand, showChoiceMessage } from '../host';
import { VIEW_ACTIVITY } from '../constants';
import { UploadPlan, PlanSource, PlanSummary, updateItem, summarize } from './uploadPlan';
import { runPlan } from './planRunner';
import { rememberSkipped, rememberAssumedUploaded } from './syncIndexFeeder';

/**
 * The gate between "a plan exists" and "it runs": the confirmation threshold
 * shared by the change collector and the external-change scanner.
 *
 * Small batches upload on their own. A batch larger than
 * `externalChanges.confirmThreshold`, one caused by a git operation whatever
 * its size, or a scan/poll batch that contains files the sync index does not
 * know (`new`: they may be stale local copies of something newer on the
 * server) is shown to the user first — a `git checkout` that touches 400
 * files should never reach the server by accident. The user can review it in
 * the Activity view (the default answer), upload it, mark it as uploaded
 * already, or skip it. A skip is remembered in the index so the same files
 * are not asked about again until they change; "mark as uploaded" records
 * them as verified (flagged as assumed) without transferring anything — the
 * answer for a tree that is known to be on the server already, when a scan
 * of thousands of files would otherwise choke the connection.
 *
 * Key lifecycle methods:
 * - {@link needsConfirmation} is the rule.
 * - {@link confirmAndRunPlan} applies it and runs the plan when allowed.
 */

export type PlanDecision = 'run' | 'review' | 'skip' | 'assume';

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
  /**
   * false: never open the dialog; a plan that would need it is left pending
   * (decision `review`) without focusing the view. Used while the host is
   * shutting down, when a modal could not be answered anyway. Defaults to true.
   */
  prompt?: boolean;
  /**
   * The service the plan belongs to. When given, a "Skip" (and the items it
   * covers) is remembered in the service's sync index, so the same versions
   * are not planned again by the next scan; a "Mark as uploaded" records them
   * there as verified.
   */
  service?: FileService;
}

// the scanner's sources: what they report was not seen happening, so a file
// the index does not know may as well be an older copy of what the server has
const RECONCILIATION_SOURCES: PlanSource[] = ['scan', 'poll'];

export interface PlanRunOutcome {
  decision: PlanDecision;
  /** the plan's summary when the call returned (final only if the run was awaited) */
  summary: PlanSummary;
}

// how many paths the confirmation lists before "and N more"
const PREVIEW_LINES = 12;

const REVIEW_LABEL = 'Review plan';
const SKIP_LABEL = 'Skip';
const ASSUME_LABEL = 'Mark as uploaded';

/**
 * Git-driven plans and plans above the threshold always ask. So does a scan or
 * poll plan with a `new` item, whatever its size: the index never saw that
 * file, so uploading it unasked could overwrite a newer copy on the server.
 * Saves and watcher batches keep the threshold alone — the user is creating
 * those files right now, and a dialog on every new file would make the
 * mirror unusable.
 */
export function needsConfirmation(plan: UploadPlan, confirmThreshold: number): boolean {
  if (plan.source === 'git' || plan.items.length > confirmThreshold) {
    return true;
  }
  return (
    RECONCILIATION_SOURCES.indexOf(plan.source) !== -1 &&
    plan.items.some(item => item.reason === 'new')
  );
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
  // "Review plan" first: it is the button Enter picks, and the one answer that
  // neither uploads nor discards anything when the dialog is answered blindly
  const choice = await showChoiceMessage(
    buildConfirmationMessage(plan, options),
    [REVIEW_LABEL, uploadLabel, ASSUME_LABEL, SKIP_LABEL],
    { modal: true }
  );

  if (choice === uploadLabel) {
    return 'run';
  }
  if (choice === ASSUME_LABEL) {
    return 'assume';
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
 * leaves it pending and focuses the Activity view, skips every item (and
 * remembers the skip in the index when the service is known), or settles
 * every item as `assumed` uploaded (recorded as verified in the index when
 * the service is known).
 */
export async function confirmAndRunPlan(
  plan: UploadPlan,
  options: ConfirmPlanOptions
): Promise<PlanRunOutcome> {
  let answer: Answer = 'run';
  if (needsConfirmation(plan, options.confirmThreshold)) {
    if (options.prompt === false) {
      // nobody can answer a dialog while the window closes; the plan stays
      // pending and the next scan will find the same files again
      logger.info(
        `[plan ${plan.id}] ${plan.items.length} file(s) from ${plan.source} need confirmation; ` +
          'left pending (no prompt while draining)'
      );
      answer = 'dismissed';
    } else {
      answer = await ask(plan, options);
      logger.info(
        `[plan ${plan.id}] ${plan.items.length} file(s) from ${plan.source}: user chose "${answer}"`
      );
    }
  }
  const decision: PlanDecision = answer === 'dismissed' ? 'review' : answer;

  switch (answer) {
    case 'skip': {
      const skipped = plan.items.filter(item => item.status === 'pending');
      skipped.forEach(item =>
        updateItem(plan.id, item.localPath, { status: 'skipped', error: 'skipped by user' })
      );
      if (options.service) {
        await rememberSkipped(options.service, skipped);
      }
      break;
    }
    case 'assume': {
      const assumed = plan.items.filter(item => item.status === 'pending');
      assumed.forEach(item => updateItem(plan.id, item.localPath, { status: 'assumed' }));
      if (options.service) {
        await rememberAssumedUploaded(options.service, assumed);
      }
      break;
    }
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
