import * as vscode from 'vscode';
import { PlanSummary } from './uploadPlan';

// stub: replaced by the real runner at integration
//
// The activity view and the plan commands consume this contract; the module
// that executes a plan (transfers, verification, item status updates) is
// developed on a sibling branch with exactly these signatures. Nothing here
// must be relied upon beyond compiling.

export interface RunPlanOptions {
  /** subset of the plan by local path; by default every pending|stale|failed item */
  itemPaths?: string[];
}

/** Resolves always with the plan's summary; rejects only when the plan does not exist. */
export function runPlan(planId: string, options?: RunPlanOptions): Promise<PlanSummary> {
  return Promise.reject(new Error('planRunner stub'));
}

/** pending|failed|stale → skipped */
export function skipItem(planId: string, localPath: string): void {
  throw new Error('planRunner stub');
}

export function isPlanRunning(planId: string): boolean {
  return false;
}

export function onDidChangeRunning(listener: () => void): vscode.Disposable {
  return {
    dispose() {
      // stub: nothing to unsubscribe
    },
  };
}
