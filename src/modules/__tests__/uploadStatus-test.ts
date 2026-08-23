// the collector drags the whole transfer layer in; the status only needs its
// count and its change event
jest.mock('../changeCollector', () => {
  const listeners: Array<() => void> = [];
  return {
    __queued: { value: 0 },
    __emit: () => listeners.forEach(listener => listener()),
    pendingCount: () => (require('../changeCollector') as any).__queued.value,
    onDidChangePending: (listener: () => void) => {
      listeners.push(listener);
      return {
        dispose() {
          const index = listeners.indexOf(listener);
          if (index !== -1) {
            listeners.splice(index, 1);
          }
        },
      };
    },
  };
});

import app from '../../app';
import StatusBarItem from '../../ui/statusBarItem';
import * as collector from '../changeCollector';
import { createPlan, updateItem, UploadPlan, __resetForTest as resetPlans } from '../uploadPlan';
import { computeCounters, init, destroy, refreshNow } from '../uploadStatus';

/**
 * The `$(arrow-up)N` / `$(error)N` hints: what counts as pending and failed,
 * and that the status bar receives the numbers (pushed, since ui/ cannot
 * import modules/).
 */

const queued = (collector as any).__queued as { value: number };
const emitQueueChange = (collector as any).__emit as () => void;

function plan(statuses: string[], source: any = 'scan'): UploadPlan {
  return createPlan({
    serviceName: 'staging',
    profile: null,
    source,
    items: statuses.map((status, index) => ({
      localPath: `/ws/${index}.ts`,
      remotePath: `/remote/${index}.ts`,
      reason: 'modified' as const,
      localSize: 1,
      localMtime: 1,
      status: status as any,
    })),
  });
}

describe('computeCounters', () => {
  beforeEach(() => resetPlans());

  test('the queue alone', () => {
    expect(computeCounters(3, [])).toEqual({ pending: 3, failed: 0 });
  });

  test('pending, uploading and stale items count as pending; failed as failed', () => {
    const p = plan(['pending', 'uploading', 'stale', 'failed', 'verified', 'skipped']);

    expect(computeCounters(0, [p])).toEqual({ pending: 3, failed: 1 });
  });

  test('adds up across plans and the queue', () => {
    const a = plan(['pending', 'failed']);
    const b = plan(['failed', 'verified']);

    expect(computeCounters(2, [a, b])).toEqual({ pending: 3, failed: 2 });
  });

  test('a negative queue count is clamped', () => {
    expect(computeCounters(-1, [])).toEqual({ pending: 0, failed: 0 });
  });
});

describe('status bar rendering', () => {
  test('shows the hints only when non-zero', () => {
    const bar = new StatusBarItem('SFTP', 'tooltip', 'cmd');

    bar.setPendingUploads(3);
    expect(bar.getText()).toBe('SFTP $(arrow-up)3');

    bar.setFailedUploads(2);
    expect(bar.getText()).toBe('SFTP $(arrow-up)3 $(error)2');

    bar.setPendingUploads(0);
    expect(bar.getText()).toBe('SFTP $(error)2');

    bar.setFailedUploads(0);
    expect(bar.getText()).toBe('SFTP');
  });

  test('sits next to the queue size and the pause icon', () => {
    const bar = new StatusBarItem('SFTP', 'tooltip', 'cmd');

    bar.setQueueSize(1);
    bar.setPendingUploads(4);
    bar.setFailedUploads(1);
    bar.setPausedState(true);

    expect(bar.getText()).toBe('SFTP (1) $(arrow-up)4 $(error)1 $(debug-pause)');
  });
});

describe('init', () => {
  let setPending: jest.SpyInstance;
  let setFailed: jest.SpyInstance;

  beforeEach(() => {
    resetPlans();
    queued.value = 0;
    setPending = jest.spyOn(app.sftpBarItem, 'setPendingUploads').mockImplementation(() => undefined);
    setFailed = jest.spyOn(app.sftpBarItem, 'setFailedUploads').mockImplementation(() => undefined);
  });

  afterEach(() => {
    destroy();
    setPending.mockRestore();
    setFailed.mockRestore();
  });

  test('pushes the counters on init and when the queue or a plan changes', async () => {
    init();
    expect(setPending).toHaveBeenLastCalledWith(0);
    expect(setFailed).toHaveBeenLastCalledWith(0);

    queued.value = 2;
    emitQueueChange();
    const p = plan(['pending', 'pending']);
    // coalesced: one render for the burst
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(setPending).toHaveBeenLastCalledWith(4);

    updateItem(p.id, '/ws/0.ts', { status: 'failed', error: 'boom' });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(setPending).toHaveBeenLastCalledWith(3);
    expect(setFailed).toHaveBeenLastCalledWith(1);
  });

  test('refreshNow pushes without waiting; destroy stops the updates', async () => {
    init();
    queued.value = 5;
    refreshNow();
    expect(setPending).toHaveBeenLastCalledWith(5);

    destroy();
    queued.value = 9;
    emitQueueChange();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(setPending).toHaveBeenLastCalledWith(5);
  });
});
