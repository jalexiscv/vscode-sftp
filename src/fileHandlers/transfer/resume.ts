import {
  FileSystem,
  TransferTask,
  TransferResult,
  TransferFailure,
  TransferFailedError,
} from '../../core';
import {
  CERTIFICATE_HINT,
  ConnectionGate,
  connectionFailureReason,
  isCertificateError,
  isConnectionLostError,
  markConnectionLost,
} from '../../core/connectionHealth';
import { markReported, simplifyPath } from '../../helper';
import { showWarningMessage } from '../../host';
import logger from '../../logger';
import app from '../../app';
import { FileHandlerContext } from '../createFileHandler';

/**
 * Runs a transfer command (`Upload Folder`, `Sync…`, a single file) so that a
 * lost connection puts it on hold instead of ending it.
 *
 * The recovery cannot happen inside the folder walk: the file system object a
 * handler receives is bound to one client, and when the connection drops the
 * keep-alive layer ends that client for good, so every later call on it fails
 * with "Client is closed". Only a new `getRemoteFileSystem()` reconnects.
 * This module therefore wraps the whole attempt — connection, walk, queue —
 * and repeats it: it waits for the connection gate (the `recovered` event, or
 * the gate's hold, never less than {@link MIN_RESUME_DELAY_MS}), asks for a
 * live file system and walks the same target again, up to
 * {@link MAX_RESUMES} times, as the plan runner does with a plan on hold.
 *
 * Between attempts the files already verified are remembered and skipped
 * through the handler's `ignore` option, so `Upload Folder` does not send the
 * whole tree again (a sync compares size and mtime, but an FTP server without
 * `MFMT` keeps its own mtime and would re-transfer everything). A file that is
 * in flight every time the connection goes — one the server answers by
 * dropping the session — is given up after {@link MAX_FILE_INTERRUPTIONS}
 * interruptions and reported with the rest, so the command gets past it.
 *
 * The user is told once per server and outage (`SFTP: connection to host lost
 * … on hold and will resume when it is back`); the output channel logs every
 * hold and resume. When the resumes run out, the aggregate error of 1.28.0
 * is thrown, flagged as a loss of the connection so a command running several
 * selections reports it once.
 */

export type TransferAction = 'upload' | 'download' | 'sync';

// a command interrupted by a lost connection is resumed this many times (each
// following the connection gate's hold, so about ten minutes at its ceiling)
export const MAX_RESUMES = 10;
// a resume never comes sooner than this after the loss, whatever the gate says
export const MIN_RESUME_DELAY_MS = 5 * 1000;
// a file interrupted this many times in a row is given up and reported
export const MAX_FILE_INTERRUPTIONS = 3;

// the delay actually used; only setResumeDelayForTest() moves it
let minResumeDelayMs = MIN_RESUME_DELAY_MS;

/**
 * Test hook: shortens the minimum delay before a resume, or restores the
 * default when called without a value. The resume tests drive real streams
 * over memfs, which do not tolerate fake timers. Production code never calls
 * it.
 */
export function setResumeDelayForTest(ms: number = MIN_RESUME_DELAY_MS): void {
  minResumeDelayMs = ms;
}

export interface IgnoreOption {
  ignore?: ((fsPath: string, isDirectory?: boolean) => boolean) | null;
}

export interface ResumableRun<O extends IgnoreOption> {
  ctx: FileHandlerContext;
  action: TransferAction;
  option: O;
  /**
   * One attempt: walks the target over `remoteFs` and hands every task to
   * `collect`. Called again, with a fresh `remoteFs` and an `option` whose
   * `ignore` skips what already went through, after each lost connection.
   */
  walk: (remoteFs: FileSystem, option: O, collect: (task: TransferTask) => void) => Promise<void>;
}

const ACTION_GERUND: { [action in TransferAction]: string } = {
  upload: 'uploading',
  download: 'downloading',
  sync: 'syncing',
};

// servers whose outage was already announced, with the subscription that
// forgets them when they come back
const outageNotified = new Map<ConnectionGate, () => void>();

function notifyOutage(gate: ConnectionGate, action: TransferAction, label: string, lost: Error) {
  if (outageNotified.has(gate)) {
    return;
  }
  const unsubscribe = gate.on('recovered', () => {
    unsubscribe();
    outageNotified.delete(gate);
  });
  outageNotified.set(gate, unsubscribe);
  const reason = connectionFailureReason(lost);
  if (isCertificateError(lost)) {
    // not an outage: nothing comes back on its own, the user has to act
    showWarningMessage(
      `SFTP: ${gate.label}: ${reason}. The ${action} of ${label} is on hold until the ` +
        `certificate or the configuration is fixed. ${CERTIFICATE_HINT}`
    );
    return;
  }
  showWarningMessage(
    `SFTP: connection to ${gate.label} lost (${reason}). The ${action} of ${label} ` +
      'is on hold and will resume when it is back.'
  );
}

/**
 * Resolves when `gate` reports its connection back, or after `delay` ms,
 * whichever comes first.
 */
function waitForConnection(gate: ConnectionGate, delay: number): Promise<void> {
  return new Promise(resolve => {
    let timer: NodeJS.Timer | undefined;
    const unsubscribe = gate.on('recovered', () => {
      if (timer) {
        clearTimeout(timer);
      }
      unsubscribe();
      resolve();
    });
    timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, delay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

/**
 * The path a walk consults `ignore` with for `task`: its source side (the
 * local path of an upload, the remote path of a download).
 */
function sourcePathOf(task: TransferTask): string {
  return task.srcFsPath;
}

/**
 * The option of a resumed attempt: `ignore` also skips the files in `skipped`
 * (never a directory: a directory's entries are judged one by one).
 */
function withSkipped<O extends IgnoreOption>(option: O, skipped: Set<string>): O {
  const original = option.ignore;
  return {
    ...option,
    ignore: (fsPath: string, isDirectory?: boolean) =>
      (!isDirectory && skipped.has(fsPath)) || (original ? original(fsPath, isDirectory) : false),
  };
}

/**
 * Turns a batch with failures into a rejection, so a handler can no longer
 * resolve after a failed put. Cancelled tasks are not failures.
 *
 * A task that failed on a live connection was already reported by the
 * service's `afterTransfer` hook, so an aggregate made only of those is
 * flagged as reported: callers log it, they do not show it again. The hook
 * stays quiet for a lost connection (every task in flight fails with it), so
 * an aggregate with an interrupted or given-up file is the one notice the
 * user gets and is not flagged.
 */
export function assertTransferSucceeded(
  result: TransferResult,
  action: TransferAction,
  resumes: number = 0
) {
  // checked first: a connection lost before any task ran (in ensureDir or
  // list) has no failed task to show, and must still be a failure
  if (result.failed.length === 0 && !result.connectionLost) {
    return;
  }

  const total = result.succeeded.length + result.failed.length + result.cancelled.length;
  const error = new TransferFailedError(result.failed, total, action);
  if (result.connectionLost) {
    // not flagged as reported, and it says the rest was not tried
    const outcome =
      `${result.succeeded.length} done, ${result.failed.length} interrupted; ` +
      'the remaining files were not attempted' +
      (resumes > 0 ? `, after ${resumes} attempt(s) to resume` : '');
    const reason = connectionFailureReason(result.connectionLost);
    error.message = isCertificateError(result.connectionLost)
      ? `Could not ${action} (${reason}): ${outcome}. ${CERTIFICATE_HINT}`
      : `Connection lost while trying to ${action} (${reason}): ${outcome}. ` +
        'Run the command again once the server is back.';
    // flagged as a loss too, so a command over several selections reports
    // one outage, not one dialog per selection
    throw markConnectionLost(error);
  }
  if (result.failed.some(failure => isConnectionLostError(failure.error))) {
    throw error;
  }
  throw markReported(error);
}

/**
 * Runs `run.walk` until it goes through, holding and resuming on every lost
 * connection as described above. Rejects as the handlers always did: with a
 * reported {@link TransferFailedError} when files failed on a live
 * connection, with the connection-lost aggregate when the resumes run out,
 * and with the original error when something other than the connection
 * broke before any task ran.
 */
export async function runResumable<O extends IgnoreOption>(run: ResumableRun<O>): Promise<void> {
  const { ctx, action } = run;
  const label = simplifyPath(ctx.target.localFsPath);
  // source paths not to walk again: verified in an earlier attempt, or given up
  const skipped = new Set<string>();
  const succeeded: TransferTask[] = [];
  // failures on a live connection, each reported by the per-file hook already
  const failed: TransferFailure[] = [];
  // files that kept interrupting the connection; reported with the rest
  const givenUp: TransferFailure[] = [];
  const interruptions = new Map<string, number>();
  let resumes = 0;

  while (true) {
    const option = skipped.size > 0 ? withSkipped(run.option, skipped) : run.option;
    let lost: Error | undefined;
    let result: TransferResult = { succeeded: [], failed: [], cancelled: [] };

    try {
      const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);
      const scheduler = ctx.fileService.createTransferScheduler(ctx.config.concurrency);
      try {
        await run.walk(remoteFs, option, task => scheduler.add(task));
      } catch (error) {
        // the collected tasks would fail the same way, one at a time
        scheduler.stop();
        if (!isConnectionLostError(error)) {
          throw error;
        }
        lost = error;
      }
      result = await scheduler.run();
    } catch (error) {
      // a wrong password, a cancelled prompt, an unreadable source: not a
      // loss, and not something a wait would fix
      if (!isConnectionLostError(error)) {
        throw error;
      }
      // the connection could not be re-established (or is on hold)
      lost = error;
    }

    succeeded.push(...result.succeeded);
    result.succeeded.forEach(task => skipped.add(sourcePathOf(task)));
    const interrupted: TransferFailure[] = [];
    for (const failure of result.failed) {
      if (!isConnectionLostError(failure.error)) {
        failed.push(failure);
        continue;
      }
      if (!lost) {
        lost = failure.error;
      }
      const source = sourcePathOf(failure.task);
      const count = (interruptions.get(source) || 0) + 1;
      interruptions.set(source, count);
      if (count < MAX_FILE_INTERRUPTIONS) {
        interrupted.push(failure);
        continue;
      }
      // in flight every time the connection went: the file itself is the
      // likely reason, and the rest of the command must get past it
      skipped.add(source);
      const message =
        `connection lost ${count} times while ${ACTION_GERUND[action]} this file: ` +
        failure.error.message;
      logger.warn(`[${action}] ${failure.task.localFsPath} given up: ${message}`);
      givenUp.push({
        task: failure.task,
        error: Object.assign(new Error(message), { code: (failure.error as any).code }),
      });
    }
    if (!lost && result.connectionLost) {
      lost = result.connectionLost;
    }

    // a cancellation is the user's choice; the resumes have a ceiling
    const cancelled = result.cancelled.length > 0;
    if (!lost || cancelled || resumes >= MAX_RESUMES) {
      if (lost && !cancelled) {
        logger.warn(
          `[${action}] ${label} not resumed any more after ${resumes} attempt(s): ${lost.message}`
        );
      }
      assertTransferSucceeded(
        {
          succeeded,
          failed: failed.concat(givenUp, lost && !cancelled ? interrupted : []),
          cancelled: result.cancelled,
          connectionLost: lost && !cancelled ? lost : undefined,
        },
        action,
        resumes
      );
      return;
    }

    resumes += 1;
    const gate = ctx.fileService.getConnectionGate(ctx.config);
    const delay = Math.max(minResumeDelayMs, gate.retryAfter());
    logger.warn(
      `[${action}] ${label} on hold: ${connectionFailureReason(lost)}; resuming in ${Math.ceil(delay / 1000)} s ` +
        `(${resumes}/${MAX_RESUMES}, ${succeeded.length} file(s) done so far)`
    );
    app.sftpBarItem.showMsg(`${action} on hold: ${label}`, label, delay);
    notifyOutage(gate, action, label, lost);
    await waitForConnection(gate, delay);
    logger.info(`[${action}] ${label}: resuming (${resumes}/${MAX_RESUMES})`);
  }
}

// test seam: the outage notices are process-wide
export function __resetResumeStateForTest(): void {
  outageNotified.forEach(unsubscribe => unsubscribe());
  outageNotified.clear();
}
