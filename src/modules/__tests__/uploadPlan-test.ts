import * as path from 'path';
import {
  createPlan,
  getPlans,
  getPlan,
  getLatestPlan,
  updateItem,
  summarize,
  formatReport,
  onDidChange,
  clearPlans,
  removePlan,
  formatSummary,
  formatBytes,
  diffAgainstIndex,
  UploadPlanItemDraft,
  __resetForTest,
} from '../uploadPlan';
import {
  initSyncIndex,
  getSyncIndex,
  __resetForTest as resetSyncIndex,
} from '../syncIndex';
import { LocalFileRecord } from '../localScanner';

const baseDir = path.resolve(path.sep, 'projects', 'site');
const local = (...segments: string[]) => path.join(baseDir, ...segments);

const item = (name: string, overrides: Partial<UploadPlanItemDraft> = {}): UploadPlanItemDraft => ({
  localPath: local(name),
  remotePath: '/var/www/html/' + name,
  reason: 'modified',
  localSize: 100,
  localMtime: 1700000000000,
  ...overrides,
});

const draft = (items: UploadPlanItemDraft[]) => ({
  serviceName: 'site',
  profile: 'prod',
  source: 'scan' as const,
  items,
});

const at = new Date(2026, 7, 22, 15, 30, 12);

describe('uploadPlan', () => {
  beforeEach(() => {
    __resetForTest();
  });

  describe('createPlan', () => {
    test('stamps the id with the date and a session counter', () => {
      const first = createPlan(draft([item('a.php')]), at);
      const second = createPlan(draft([]), at);

      expect(first.id).toBe('20260822-153012-1');
      expect(second.id).toBe('20260822-153012-2');
      expect(first.createdAt).toBe(at.getTime());
    });

    test('items default to pending with zero attempts, and keep an explicit status', () => {
      const plan = createPlan(
        draft([item('a.php'), item('b.php', { status: 'skipped', attempts: 2 })]),
        at
      );

      expect(plan.items[0].status).toBe('pending');
      expect(plan.items[0].attempts).toBe(0);
      expect(plan.items[1].status).toBe('skipped');
      expect(plan.items[1].attempts).toBe(2);
      expect(plan.finishedAt).toBeUndefined();
    });

    test('copies the service, profile and source', () => {
      const plan = createPlan(draft([]), at);
      expect(plan.serviceName).toBe('site');
      expect(plan.profile).toBe('prod');
      expect(plan.source).toBe('scan');
    });

    test('__resetForTest rewinds the counter', () => {
      createPlan(draft([]), at);
      __resetForTest();
      expect(createPlan(draft([]), at).id).toBe('20260822-153012-1');
    });
  });

  describe('registry', () => {
    test('getPlans lists newest first, getLatestPlan is the head', () => {
      const first = createPlan(draft([]), at);
      const second = createPlan(draft([]), at);

      expect(getPlans().map(p => p.id)).toEqual([second.id, first.id]);
      expect(getLatestPlan()).toBe(second);
      expect(getPlan(first.id)).toBe(first);
      expect(getPlan('nope')).toBeUndefined();
    });

    test('keeps at most 20 plans and drops the oldest', () => {
      for (let i = 0; i < 25; i++) {
        createPlan(draft([]), at);
      }

      const plans = getPlans();
      expect(plans).toHaveLength(20);
      expect(plans[0].id).toBe('20260822-153012-25');
      expect(plans[19].id).toBe('20260822-153012-6');
      expect(getPlan('20260822-153012-5')).toBeUndefined();
    });

    test('getPlans hands out a copy of the list', () => {
      createPlan(draft([]), at);
      getPlans().length = 0;
      expect(getPlans()).toHaveLength(1);
    });

    test('getLatestPlan is undefined when empty', () => {
      expect(getLatestPlan()).toBeUndefined();
    });

    test('clearPlans empties the registry', () => {
      createPlan(draft([]), at);
      clearPlans();
      expect(getPlans()).toEqual([]);
    });

    test('removePlan drops just that plan and notifies', () => {
      const first = createPlan(draft([]), at);
      const second = createPlan(draft([]), at);
      const third = createPlan(draft([]), at);
      const listener = jest.fn();
      onDidChange(listener);

      expect(removePlan(second.id)).toBe(true);
      expect(getPlans().map(p => p.id)).toEqual([third.id, first.id]);
      expect(getPlan(second.id)).toBeUndefined();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    test('removePlan of an unknown id is a no-op that says so', () => {
      createPlan(draft([]), at);
      const listener = jest.fn();
      onDidChange(listener);

      expect(removePlan('nope')).toBe(false);
      expect(getPlans()).toHaveLength(1);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('updateItem', () => {
    test('stamps startedAt on uploading and finishedAt on a terminal status', () => {
      const plan = createPlan(draft([item('a.php'), item('b.php')]), at);
      const before = Date.now();

      updateItem(plan.id, local('a.php'), { status: 'uploading', attempts: 1 });
      const a = plan.items[0];
      expect(a.status).toBe('uploading');
      expect(a.attempts).toBe(1);
      expect(a.startedAt).toBeGreaterThanOrEqual(before);
      expect(a.finishedAt).toBeUndefined();
      expect(plan.finishedAt).toBeUndefined();

      updateItem(plan.id, local('a.php'), { status: 'verified' });
      expect(a.finishedAt).toBeGreaterThanOrEqual(a.startedAt!);
      // b.php is still pending
      expect(plan.finishedAt).toBeUndefined();
    });

    test('closes the plan once nothing is pending or uploading', () => {
      const plan = createPlan(draft([item('a.php'), item('b.php'), item('c.php')]), at);

      updateItem(plan.id, local('a.php'), { status: 'verified' });
      updateItem(plan.id, local('b.php'), { status: 'failed', error: 'size mismatch' });
      expect(plan.finishedAt).toBeUndefined();

      updateItem(plan.id, local('c.php'), { status: 'skipped' });
      expect(plan.finishedAt).toBeDefined();
      expect(plan.items[1].error).toBe('size mismatch');
    });

    test('a stale item does not keep the plan open', () => {
      const plan = createPlan(draft([item('a.php')]), at);
      updateItem(plan.id, local('a.php'), { status: 'stale' });
      expect(plan.items[0].finishedAt).toBeUndefined();
      expect(plan.finishedAt).toBeDefined();
    });

    test('re-queuing an item reopens the plan', () => {
      const plan = createPlan(draft([item('a.php')]), at);
      updateItem(plan.id, local('a.php'), { status: 'failed' });
      expect(plan.finishedAt).toBeDefined();

      updateItem(plan.id, local('a.php'), { status: 'pending', finishedAt: undefined });
      expect(plan.finishedAt).toBeUndefined();
      expect(plan.items[0].finishedAt).toBeUndefined();
    });

    test('ignores an unknown plan or path', () => {
      const plan = createPlan(draft([item('a.php')]), at);
      updateItem('nope', local('a.php'), { status: 'verified' });
      updateItem(plan.id, local('zzz.php'), { status: 'verified' });
      expect(plan.items[0].status).toBe('pending');
    });

    if (process.platform === 'win32' || process.platform === 'darwin') {
      test('matches the local path case-insensitively where the filesystem is', () => {
        const plan = createPlan(draft([item('Dir/File.php')]), at);
        updateItem(plan.id, local('dir', 'file.php'), { status: 'verified' });
        expect(plan.items[0].status).toBe('verified');
      });
    }
  });

  describe('summarize', () => {
    test('counts every status and sums the bytes', () => {
      const plan = createPlan(
        draft([
          item('a.php', { localSize: 10 }),
          item('b.php', { localSize: 20 }),
          item('c.php', { localSize: 30 }),
          item('d.php', { localSize: 40 }),
          item('e.php', { localSize: 50 }),
          item('f.php', { localSize: 60 }),
        ]),
        at
      );
      updateItem(plan.id, local('a.php'), { status: 'uploading' });
      updateItem(plan.id, local('b.php'), { status: 'verified' });
      updateItem(plan.id, local('c.php'), { status: 'failed' });
      updateItem(plan.id, local('d.php'), { status: 'skipped' });
      updateItem(plan.id, local('e.php'), { status: 'stale' });

      expect(summarize(plan)).toEqual({
        total: 6,
        pending: 1,
        uploading: 1,
        verified: 1,
        failed: 1,
        skipped: 1,
        stale: 1,
        bytes: 210,
      });
    });
  });

  describe('formatSummary', () => {
    test('always shows verified, failed and pending, the rest only when non-zero', () => {
      const plan = createPlan(draft([item('a.php'), item('b.php'), item('c.php')]), at);
      expect(formatSummary(summarize(plan))).toBe('3 files — 0 verified, 0 failed, 3 pending');

      updateItem(plan.id, local('a.php'), { status: 'verified' });
      updateItem(plan.id, local('b.php'), { status: 'uploading' });
      updateItem(plan.id, local('c.php'), { status: 'skipped' });
      expect(formatSummary(summarize(plan))).toBe(
        '3 files — 1 verified, 0 failed, 0 pending, 1 uploading, 1 skipped'
      );

      updateItem(plan.id, local('b.php'), { status: 'stale' });
      expect(formatSummary(summarize(plan))).toBe(
        '3 files — 1 verified, 0 failed, 0 pending, 1 skipped, 1 stale'
      );
    });

    test('uses the singular for one file', () => {
      const plan = createPlan(draft([item('a.php')]), at);
      expect(formatSummary(summarize(plan))).toBe('1 file — 0 verified, 0 failed, 1 pending');
    });
  });

  describe('formatBytes', () => {
    test('picks the unit and the precision', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(1023)).toBe('1023 B');
      expect(formatBytes(1024)).toBe('1.0 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(100 * 1024)).toBe('100 KB');
      expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
      expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
    });
  });

  describe('formatReport', () => {
    test('has a header with the plan facts and one row per item', () => {
      const plan = createPlan(
        draft([
          item('a.php', { localSize: 2048 }),
          item('b.php', { reason: 'new', localSize: 5 }),
        ]),
        at
      );
      updateItem(plan.id, local('a.php'), { status: 'verified' });
      updateItem(plan.id, local('b.php'), { status: 'failed', error: 'not found | after upload' });

      const report = formatReport(plan);

      expect(report).toContain('# Upload plan 20260822-153012-1');
      expect(report).toContain('- Service: site');
      expect(report).toContain('- Profile: prod');
      expect(report).toContain('- Source: scan');
      expect(report).toContain('- Created: 2026-08-22 15:30:12');
      expect(report).toMatch(/- Finished: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      expect(report).toContain('2 item(s), 2.0 KB');
      expect(report).toContain('1 verified, 1 failed');

      expect(report).toContain('| Status | Reason | Local | Remote | Size | Attempts | Error |');
      expect(report).toContain(`| verified | modified | ${local('a.php')} | /var/www/html/a.php | 2.0 KB | 0 |  |`);
      // a pipe in the error must not break the table
      expect(report).toContain('| failed | new |');
      expect(report).toContain('not found \\| after upload');
    });

    test('says so when the plan is still running and has no profile', () => {
      const plan = createPlan({ ...draft([item('a.php')]), profile: null }, at);
      const report = formatReport(plan);
      expect(report).toContain('- Profile: (none)');
      expect(report).toContain('- Finished: (in progress)');
    });
  });

  describe('onDidChange', () => {
    test('fires on create, update and clear', () => {
      const listener = jest.fn();
      onDidChange(listener);

      const plan = createPlan(draft([item('a.php')]), at);
      expect(listener).toHaveBeenCalledTimes(1);

      updateItem(plan.id, local('a.php'), { status: 'verified' });
      expect(listener).toHaveBeenCalledTimes(2);

      clearPlans();
      expect(listener).toHaveBeenCalledTimes(3);
    });

    test('dispose unsubscribes', () => {
      const listener = jest.fn();
      onDidChange(listener).dispose();
      createPlan(draft([]), at);
      expect(listener).not.toHaveBeenCalled();
    });

    test('a throwing listener does not break the others', () => {
      const listener = jest.fn();
      onDidChange(() => {
        throw new Error('boom');
      });
      onDidChange(listener);

      createPlan(draft([]), at);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('diffAgainstIndex', () => {
    beforeEach(() => {
      resetSyncIndex();
      initSyncIndex({ storagePath: undefined });
    });

    const record = (name: string, size: number, mtime: number): LocalFileRecord => ({
      fsPath: local(name),
      size,
      mtime,
    });

    const toRemotePath = (fsPath: string) =>
      '/var/www/html/' + path.relative(baseDir, fsPath).split(path.sep).join('/');

    test('classifies new, modified and unchanged, and reports missing files', async () => {
      const index = await getSyncIndex('k');
      index.set('same.php', { size: 10, mtime: 1700000000000, verifiedAt: 1, status: 'verified' });
      index.set('bigger.php', { size: 10, mtime: 1700000000000, verifiedAt: 1, status: 'verified' });
      index.set('newer.php', { size: 10, mtime: 1700000000000, verifiedAt: 1, status: 'verified' });
      index.set('gone/old.php', { size: 10, mtime: 1700000000000, verifiedAt: 1, status: 'verified' });

      const result = diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [
          record('same.php', 10, 1700000000000),
          record('bigger.php', 11, 1700000000000),
          record('newer.php', 10, 1700000005000),
          record('fresh.php', 3, 1700000000000),
        ],
      });

      expect(result.unchanged).toBe(1);
      expect(result.items.map(i => [path.basename(i.localPath), i.reason])).toEqual([
        ['bigger.php', 'modified'],
        ['newer.php', 'modified'],
        ['fresh.php', 'new'],
      ]);
      expect(result.items[2]).toEqual({
        localPath: local('fresh.php'),
        remotePath: '/var/www/html/fresh.php',
        reason: 'new',
        localSize: 3,
        localMtime: 1700000000000,
      });
      expect(result.missingLocally).toEqual(['gone/old.php']);
    });

    test('compares mtime in whole seconds, like the transfer layer', async () => {
      const index = await getSyncIndex('k');
      index.set('a.php', { size: 10, mtime: 1700000000123, verifiedAt: 1, status: 'verified' });

      const sameSecond = diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [record('a.php', 10, 1700000000987)],
      });
      expect(sameSecond.items).toEqual([]);
      expect(sameSecond.unchanged).toBe(1);

      const nextSecond = diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [record('a.php', 10, 1700000001000)],
      });
      expect(nextSecond.items.map(i => i.reason)).toEqual(['modified']);
    });

    test('a failed entry is due again even when size and mtime match', async () => {
      const index = await getSyncIndex('k');
      index.set('a.php', { size: 10, mtime: 1700000000000, verifiedAt: 1, status: 'failed' });

      const result = diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [record('a.php', 10, 1700000000000)],
      });
      expect(result.items.map(i => i.reason)).toEqual(['modified']);
    });

    test('a skipped entry is unchanged while the file keeps its size and mtime, modified once it moves', async () => {
      const index = await getSyncIndex('k');
      index.set('a.php', { size: 10, mtime: 1700000000000, verifiedAt: 0, status: 'skipped' });

      const same = diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [record('a.php', 10, 1700000000500)],
      });
      expect(same.items).toEqual([]);
      expect(same.unchanged).toBe(1);

      const changed = diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [record('a.php', 11, 1700000000000)],
      });
      expect(changed.items.map(i => i.reason)).toEqual(['modified']);
    });

    test('does not mutate the index', async () => {
      const index = await getSyncIndex('k');
      index.set('gone.php', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });

      diffAgainstIndex({ baseDir, index, toRemotePath, scanned: [record('fresh.php', 1, 1)] });
      expect(index.size).toBe(1);
      expect(index.get('fresh.php')).toBeUndefined();
    });

    test('nested paths are matched by their "/" relative form', async () => {
      const index = await getSyncIndex('k');
      index.set('src/deep/a.php', { size: 10, mtime: 1700000000000, verifiedAt: 1, status: 'verified' });

      const result = diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [record(path.join('src', 'deep', 'a.php'), 10, 1700000000000)],
      });
      expect(result.unchanged).toBe(1);
      expect(result.missingLocally).toEqual([]);
    });
  });
});
