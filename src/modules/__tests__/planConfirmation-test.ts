jest.mock('../../host', () => ({
  ...jest.requireActual('../../host'),
  showChoiceMessage: jest.fn(),
  executeCommand: jest.fn(() => Promise.resolve()),
}));
// simplifyPath goes through the vscode workspace, which the default mock
// answers with nothing; the message must show the paths
jest.mock('../../helper', () => ({
  ...jest.requireActual('../../helper'),
  simplifyPath: (fsPath: string) => fsPath,
}));
jest.mock('../planRunner', () => ({
  runPlan: jest.fn(),
}));

import { showChoiceMessage, executeCommand } from '../../host';
import { runPlan } from '../planRunner';
import { createPlan, summarize, UploadPlan, __resetForTest as resetPlans } from '../uploadPlan';
import {
  needsConfirmation,
  buildConfirmationMessage,
  confirmAndRunPlan,
} from '../planConfirmation';

/**
 * The gate shared by the collector and the scanner: small batches run, large
 * or git-driven ones ask, and each answer leaves the plan in the right state.
 */

const showChoiceMessageMock = showChoiceMessage as jest.Mock;
const executeCommandMock = executeCommand as jest.Mock;
const runPlanMock = runPlan as jest.Mock;

function plan(count: number, source: any = 'scan'): UploadPlan {
  const items = Array.from({ length: count }, (_, index) => ({
    localPath: `/ws/file-${index}.ts`,
    remotePath: `/remote/file-${index}.ts`,
    reason: 'modified' as const,
    localSize: 1,
    localMtime: 1,
  }));
  return createPlan({ serviceName: 'staging', profile: null, source, items });
}

const options = { serviceName: 'staging', host: 'example.test', confirmThreshold: 20 };

beforeEach(() => {
  resetPlans();
  showChoiceMessageMock.mockReset();
  executeCommandMock.mockClear();
  runPlanMock.mockReset();
  runPlanMock.mockImplementation((id: string) =>
    Promise.resolve(summarize(require('../uploadPlan').getPlan(id)))
  );
});

describe('needsConfirmation', () => {
  test('below or at the threshold, not git: no', () => {
    expect(needsConfirmation(plan(20), 20)).toBe(false);
    expect(needsConfirmation(plan(1), 20)).toBe(false);
  });

  test('above the threshold: yes', () => {
    expect(needsConfirmation(plan(21), 20)).toBe(true);
  });

  test('git-driven: always', () => {
    expect(needsConfirmation(plan(1, 'git'), 20)).toBe(true);
  });

  test('threshold 0 always asks', () => {
    expect(needsConfirmation(plan(1), 0)).toBe(true);
  });
});

describe('buildConfirmationMessage', () => {
  test('names the count, the origin and the target, and lists the paths', () => {
    const message = buildConfirmationMessage(plan(3), options);

    expect(message).toContain('SFTP: 3 local file(s) changed outside the editor.');
    expect(message).toContain('Upload them to staging - example.test?');
    expect(message).toContain('  • /ws/file-0.ts');
    expect(message).toContain('  • /ws/file-2.ts');
    expect(message).not.toContain('more');
  });

  test('git and saves get their own wording', () => {
    expect(buildConfirmationMessage(plan(1, 'git'), options)).toContain(
      'changed — a git operation moved HEAD'
    );
    expect(buildConfirmationMessage(plan(1, 'command'), options)).toContain('were saved');
  });

  test('lists at most 12 paths and counts the rest', () => {
    const message = buildConfirmationMessage(plan(30), options);

    expect(message).toContain('  • /ws/file-11.ts');
    expect(message).not.toContain('  • /ws/file-12.ts');
    expect(message).toContain('… and 18 more');
  });

  test('falls back to "the server" without a name or host', () => {
    expect(
      buildConfirmationMessage(plan(1), { serviceName: '', confirmThreshold: 20 })
    ).toContain('Upload them to the server?');
  });
});

describe('confirmAndRunPlan', () => {
  test('below the threshold it runs without asking', async () => {
    const p = plan(2);

    const outcome = await confirmAndRunPlan(p, options);

    expect(showChoiceMessageMock).not.toHaveBeenCalled();
    expect(runPlanMock).toHaveBeenCalledWith(p.id);
    expect(outcome.decision).toBe('run');
  });

  test('"Upload N file(s)" runs the plan', async () => {
    showChoiceMessageMock.mockResolvedValue('Upload 25 file(s)');
    const p = plan(25);

    const outcome = await confirmAndRunPlan(p, options);

    expect(showChoiceMessageMock).toHaveBeenCalledTimes(1);
    const [message, buttons, modal] = showChoiceMessageMock.mock.calls[0];
    expect(message).toContain('25 local file(s)');
    expect(buttons).toEqual(['Upload 25 file(s)', 'Review plan', 'Skip']);
    expect(modal).toEqual({ modal: true });
    expect(runPlanMock).toHaveBeenCalledWith(p.id);
    expect(outcome.decision).toBe('run');
  });

  test('"Skip" marks every pending item skipped and runs nothing', async () => {
    showChoiceMessageMock.mockResolvedValue('Skip');
    const p = plan(25);

    const outcome = await confirmAndRunPlan(p, options);

    expect(runPlanMock).not.toHaveBeenCalled();
    expect(outcome.decision).toBe('skip');
    expect(p.items.every(item => item.status === 'skipped')).toBe(true);
    expect(p.items[0].error).toBe('skipped by user');
    expect(outcome.summary.skipped).toBe(25);
    expect(p.finishedAt).toBeDefined();
  });

  test('"Review plan" leaves the plan pending and focuses the activity view', async () => {
    showChoiceMessageMock.mockResolvedValue('Review plan');
    const p = plan(25);

    const outcome = await confirmAndRunPlan(p, options);

    expect(runPlanMock).not.toHaveBeenCalled();
    expect(outcome.decision).toBe('review');
    expect(p.items.every(item => item.status === 'pending')).toBe(true);
    expect(executeCommandMock).toHaveBeenCalledWith('sftpActivity.focus');
  });

  test('a dismissed dialog leaves the plan pending without stealing focus', async () => {
    showChoiceMessageMock.mockResolvedValue(undefined);
    const p = plan(25);

    const outcome = await confirmAndRunPlan(p, options);

    expect(outcome.decision).toBe('review');
    expect(p.items.every(item => item.status === 'pending')).toBe(true);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  test('a git-driven batch asks whatever its size', async () => {
    showChoiceMessageMock.mockResolvedValue('Skip');

    await confirmAndRunPlan(plan(1, 'git'), options);

    expect(showChoiceMessageMock).toHaveBeenCalledTimes(1);
  });

  test('awaitRun: false returns as soon as the plan is handed to the runner', async () => {
    let release: () => void = () => undefined;
    runPlanMock.mockImplementation(() => new Promise<void>(resolve => (release = resolve)));
    const p = plan(2);

    const outcome = await confirmAndRunPlan(p, { ...options, awaitRun: false });

    expect(runPlanMock).toHaveBeenCalledWith(p.id);
    expect(outcome.decision).toBe('run');
    release();
  });

  test('a runner rejection under awaitRun: false is logged, not thrown', async () => {
    runPlanMock.mockImplementation(() => Promise.reject(new Error('runner down')));

    await expect(confirmAndRunPlan(plan(1), { ...options, awaitRun: false })).resolves.toMatchObject({
      decision: 'run',
    });
  });
});
