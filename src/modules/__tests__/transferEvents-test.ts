import {
  emitTransferStart,
  emitTransferDone,
  onDidStartTransfer,
  onDidFinishTransfer,
  TransferOutcome,
  __resetForTest,
} from '../transferEvents';

/**
 * The bus that re-broadcasts the service hooks: listeners get every event,
 * can unsubscribe, and one that throws cannot silence its neighbours.
 */

const service = { name: 'staging', baseDir: '/ws' } as any;
const task = { localFsPath: '/ws/a.txt' } as any;

describe('transferEvents', () => {
  beforeEach(() => {
    __resetForTest();
  });

  test('start and done reach their own listeners with the payload', () => {
    const started = jest.fn();
    const finished = jest.fn();
    onDidStartTransfer(started);
    onDidFinishTransfer(finished);

    emitTransferStart({ service, task, profile: 'prod' });
    const outcome: TransferOutcome = { service, task, error: null, profile: 'prod' };
    emitTransferDone(outcome);

    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith({ service, task, profile: 'prod' });
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith(outcome);
  });

  test('disposing a subscription stops the events', () => {
    const listener = jest.fn();
    const subscription = onDidFinishTransfer(listener);

    emitTransferDone({ service, task, error: null, profile: null });
    subscription.dispose();
    emitTransferDone({ service, task, error: new Error('boom'), profile: null });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('a listener that throws does not stop the others', () => {
    const second = jest.fn();
    onDidFinishTransfer(() => {
      throw new Error('listener bug');
    });
    onDidFinishTransfer(second);

    expect(() => emitTransferDone({ service, task, error: null, profile: null })).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('a listener that disposes itself mid-emit does not skip its neighbour', () => {
    const second = jest.fn();
    const first = onDidStartTransfer(() => first.dispose());
    onDidStartTransfer(second);

    emitTransferStart({ service, task, profile: null });

    expect(second).toHaveBeenCalledTimes(1);
  });

  test('reset drops every listener', () => {
    const listener = jest.fn();
    onDidStartTransfer(listener);
    onDidFinishTransfer(listener);

    __resetForTest();
    emitTransferStart({ service, task, profile: null });
    emitTransferDone({ service, task, error: null, profile: null });

    expect(listener).not.toHaveBeenCalled();
  });
});
