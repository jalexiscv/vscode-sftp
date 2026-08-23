import * as vscode from 'vscode';
import logger from '../logger';
import { FileService, TransferTask } from '../core';

/**
 * Process-wide bus for the start and the outcome of every transfer task.
 *
 * The per-service `beforeTransfer`/`afterTransfer` hooks are installed by
 * serviceManager and already drive the status bar and the Activity view; this
 * module re-broadcasts them as plain events so other modules (the sync index
 * feeder, the upload status) can observe transfers without being wired into
 * serviceManager and without serviceManager having to know about them.
 *
 * Listeners are isolated from each other: one that throws is logged and the
 * rest still run, as in activityLog.
 *
 * Key lifecycle methods:
 * - {@link emitTransferStart} / {@link emitTransferDone} are called from the
 *   service hooks.
 * - {@link onDidStartTransfer} / {@link onDidFinishTransfer} subscribe; the
 *   returned disposable unsubscribes.
 */

export interface TransferOutcome {
  service: FileService;
  task: TransferTask;
  /** null when the task completed; the error (or abort) otherwise */
  error: Error | null;
  /** active profile when the transfer ran */
  profile: string | null;
}

export type TransferStart = Omit<TransferOutcome, 'error'>;

const startListeners: Array<(start: TransferStart) => void> = [];
const doneListeners: Array<(outcome: TransferOutcome) => void> = [];

function emit<T>(listeners: Array<(event: T) => void>, event: T, label: string) {
  // a copy, so a listener that disposes itself mid-emit can't skip its neighbour
  listeners.slice().forEach(listener => {
    try {
      listener(event);
    } catch (error) {
      logger.error(error, `transferEvents ${label} listener`);
    }
  });
}

function subscribe<T>(
  listeners: Array<(event: T) => void>,
  listener: (event: T) => void
): vscode.Disposable {
  listeners.push(listener);
  return {
    dispose() {
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    },
  };
}

export function emitTransferStart(start: TransferStart): void {
  emit(startListeners, start, 'start');
}

export function emitTransferDone(outcome: TransferOutcome): void {
  emit(doneListeners, outcome, 'done');
}

export function onDidStartTransfer(listener: (start: TransferStart) => void): vscode.Disposable {
  return subscribe(startListeners, listener);
}

export function onDidFinishTransfer(
  listener: (outcome: TransferOutcome) => void
): vscode.Disposable {
  return subscribe(doneListeners, listener);
}

// test seam: the module keeps process-wide state
export function __resetForTest() {
  startListeners.length = 0;
  doneListeners.length = 0;
}
