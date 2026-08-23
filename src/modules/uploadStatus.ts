import * as vscode from 'vscode';
import app from '../app';
import logger from '../logger';
import { pendingCount, onDidChangePending } from './changeCollector';
import { UploadPlan, getPlans, onDidChange as onDidChangePlans } from './uploadPlan';

/**
 * Pushes the "what is still to upload / what failed" counters into the status
 * bar.
 *
 * Two sources feed them: the change collector's queue (changes seen, not yet
 * planned) and the upload plans (items pending, uploading or stale; items
 * failed). `ui/` must not import from `modules/`, so this module subscribes to
 * both and tells the status bar what to show, the same way the pause state is
 * pushed in from extension.ts. Updates are coalesced: a burst of watcher
 * events or a 400-item plan would otherwise re-render the item per event.
 *
 * Key lifecycle methods:
 * - {@link init} subscribes; {@link destroy} unsubscribes.
 * - {@link computeCounters} is the pure rule, kept separate for tests.
 */

export interface UploadCounters {
  /** changes queued plus plan items still to be uploaded */
  pending: number;
  /** plan items that failed and were not retried or skipped */
  failed: number;
}

// long enough to fold a burst of events into one render, short enough that
// the bar still feels live
const REFRESH_DELAY_MS = 50;

const subscriptions: vscode.Disposable[] = [];
let refreshTimer: any = null;

/**
 * `queued` is the collector's pending count; `plans` every plan in the
 * registry. Stale items count as pending (they are due again) even though
 * their plan may read as finished; failed items count until the user retries
 * or skips them, which is what makes the `$(error)N` hint actionable.
 */
export function computeCounters(queued: number, plans: UploadPlan[]): UploadCounters {
  const counters: UploadCounters = { pending: Math.max(0, queued), failed: 0 };
  plans.forEach(plan => {
    plan.items.forEach(item => {
      switch (item.status) {
        case 'pending':
        case 'uploading':
        case 'stale':
          counters.pending++;
          break;
        case 'failed':
          counters.failed++;
          break;
        default:
        // verified and skipped are settled
      }
    });
  });
  return counters;
}

/** Recomputes the counters and pushes them to the status bar right away. */
export function refreshNow(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  try {
    const counters = computeCounters(pendingCount(), getPlans());
    app.sftpBarItem.setPendingUploads(counters.pending);
    app.sftpBarItem.setFailedUploads(counters.failed);
  } catch (error) {
    logger.error(error, 'upload status');
  }
}

function scheduleRefresh() {
  if (refreshTimer) {
    return;
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshNow();
  }, REFRESH_DELAY_MS);
  // unref'd so a pending refresh never holds the process open (jest would
  // otherwise report a worker that failed to exit)
  if (typeof refreshTimer.unref === 'function') {
    refreshTimer.unref();
  }
}

export function init(): void {
  if (subscriptions.length > 0) {
    return;
  }
  subscriptions.push(onDidChangePending(scheduleRefresh));
  subscriptions.push(onDidChangePlans(scheduleRefresh));
  refreshNow();
}

export function destroy(): void {
  subscriptions.forEach(subscription => subscription.dispose());
  subscriptions.length = 0;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

export default {
  init,
  destroy,
};
