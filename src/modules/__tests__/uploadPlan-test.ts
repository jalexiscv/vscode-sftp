jest.mock('fs');

import * as crypto from 'crypto';
import * as path from 'path';
import { vol } from 'memfs';
import * as fingerprint from '../../core/fingerprint';
import {
  classifyAgainstIndex,
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
        assumed: 0,
        stale: 1,
        bytes: 210,
      });
    });

    test('counts items the user marked as uploaded apart from verified ones', () => {
      const plan = createPlan(draft([item('a.php'), item('b.php')]), at);
      updateItem(plan.id, local('a.php'), { status: 'assumed' });
      updateItem(plan.id, local('b.php'), { status: 'verified' });

      expect(summarize(plan)).toMatchObject({ assumed: 1, verified: 1, pending: 0 });
      // assumed is terminal: the plan is closed
      expect(plan.finishedAt).toBeDefined();
      expect(plan.items[0].finishedAt).toBeDefined();
      expect(formatSummary(summarize(plan))).toBe(
        '2 files — 1 verified, 0 failed, 0 pending, 1 assumed uploaded'
      );
      expect(formatReport(plan)).toContain('1 assumed uploaded');
      expect(formatReport(plan)).toContain(`| assumed | modified | ${local('a.php')} |`);
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
      vol.reset();
      resetSyncIndex();
      initSyncIndex({ storagePath: undefined });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const record = (name: string, size: number, mtime: number): LocalFileRecord => ({
      fsPath: local(name),
      size,
      mtime,
    });

    const toRemotePath = (fsPath: string) =>
      '/var/www/html/' + path.relative(baseDir, fsPath).split(path.sep).join('/');

    const sha1 = (content: string) => crypto.createHash('sha1').update(content).digest('hex');

    // a file on the (memfs) disk with the given content and mtime, and its scan record
    function onDisk(name: string, content: string, mtime: number): LocalFileRecord {
      vol.mkdirSync(path.dirname(local(name)), { recursive: true } as any);
      vol.writeFileSync(local(name), content);
      vol.utimesSync(local(name), new Date(mtime), new Date(mtime));
      return record(name, Buffer.byteLength(content), mtime);
    }

    test('classifies new, modified and unchanged, and reports missing files', async () => {
      const index = await getSyncIndex('k');
      index.set('same.php', { size: 10, mtime: 1700000000000, verifiedAt: 1, status: 'verified' });
      index.set('bigger.php', { size: 10, mtime: 1700000000000, verifiedAt: 1, status: 'verified' });
      index.set('newer.php', { size: 10, mtime: 1700000000000, verifiedAt: 1, status: 'verified' });
      index.set('gone/old.php', { size: 10, mtime: 1700000000000, verifiedAt: 1, status: 'verified' });

      const result = await diffAgainstIndex({
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
      expect(result.rewritten).toBe(0);
      expect(result.cancelled).toBe(false);
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

      const sameSecond = await diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [record('a.php', 10, 1700000000987)],
      });
      expect(sameSecond.items).toEqual([]);
      expect(sameSecond.unchanged).toBe(1);

      const nextSecond = await diffAgainstIndex({
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

      const result = await diffAgainstIndex({
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

      const same = await diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [record('a.php', 10, 1700000000500)],
      });
      expect(same.items).toEqual([]);
      expect(same.unchanged).toBe(1);

      const changed = await diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [record('a.php', 11, 1700000000000)],
      });
      expect(changed.items.map(i => i.reason)).toEqual(['modified']);
    });

    test('never adds entries to the index', async () => {
      const index = await getSyncIndex('k');
      index.set('gone.php', { size: 1, mtime: 1, verifiedAt: 1, status: 'verified' });

      await diffAgainstIndex({ baseDir, index, toRemotePath, scanned: [record('fresh.php', 1, 1)] });
      expect(index.size).toBe(1);
      expect(index.get('fresh.php')).toBeUndefined();
    });

    test('the same content under another mtime is unchanged (rewritten), and the entry follows the mtime', async () => {
      const t = 1700000000000;
      const index = await getSyncIndex('k');
      const touched = onDisk('touched.php', 'same bytes', t + 60000);
      const edited = onDisk('edited.php', 'new  bytes', t + 60000);
      index.set('touched.php', {
        size: 10, mtime: t, verifiedAt: 1, status: 'verified', fingerprint: sha1('same bytes'),
      });
      index.set('edited.php', {
        size: 10, mtime: t, verifiedAt: 1, status: 'verified', fingerprint: sha1('same bytes'),
      });
      const progress: number[] = [];

      const result = await diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [touched, edited],
        onProgress: compared => progress.push(compared),
      });

      expect(result.items.map(i => [path.basename(i.localPath), i.reason])).toEqual([
        ['edited.php', 'modified'],
      ]);
      expect(result.unchanged).toBe(1);
      expect(result.rewritten).toBe(1);
      expect(progress).toEqual([1, 2]);
      // the next scan will not have to read it again
      expect(index.get('touched.php')).toMatchObject({ mtime: t + 60000, fingerprint: sha1('same bytes') });
      // a modified file's entry is left for the upload to rewrite
      expect(index.get('edited.php')).toMatchObject({ mtime: t });
      expect(index.size).toBe(2);
    });

    test('a skipped version keeps its status when its file is rewritten identically', async () => {
      const t = 1700000000000;
      const index = await getSyncIndex('k');
      const touched = onDisk('declined.php', 'declined', t + 5000);
      index.set('declined.php', {
        size: 8, mtime: t, verifiedAt: 0, status: 'skipped', fingerprint: sha1('declined'),
      });

      const result = await diffAgainstIndex({ baseDir, index, toRemotePath, scanned: [touched] });

      expect(result.items).toEqual([]);
      expect(index.get('declined.php')).toMatchObject({ status: 'skipped', mtime: t + 5000 });
    });

    test('without a fingerprint to compare against, or with compareContent off, the mtime alone decides', async () => {
      const t = 1700000000000;
      const index = await getSyncIndex('k');
      const legacy = onDisk('legacy.php', 'same bytes', t + 60000);
      const withPrint = onDisk('printed.php', 'same bytes', t + 60000);
      index.set('legacy.php', { size: 10, mtime: t, verifiedAt: 1, status: 'verified' });
      index.set('printed.php', {
        size: 10, mtime: t, verifiedAt: 1, status: 'verified', fingerprint: sha1('same bytes'),
      });
      const read = jest.spyOn(fingerprint, 'fingerprintFile');

      const legacyOnly = await diffAgainstIndex({ baseDir, index, toRemotePath, scanned: [legacy] });
      expect(legacyOnly.items.map(i => i.reason)).toEqual(['modified']);
      expect(legacyOnly.rewritten).toBe(0);

      const off = await diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [withPrint],
        compareContent: false,
      });
      expect(off.items.map(i => i.reason)).toEqual(['modified']);
      expect(read).not.toHaveBeenCalled();
      // nothing was read, so nothing moved
      expect(index.get('printed.php')).toMatchObject({ mtime: t });
    });

    test('a failed entry and a different size are modified without a read', async () => {
      const t = 1700000000000;
      const index = await getSyncIndex('k');
      index.set('failed.php', {
        size: 10, mtime: t, verifiedAt: 0, status: 'failed', fingerprint: sha1('same bytes'),
      });
      index.set('grown.php', {
        size: 10, mtime: t, verifiedAt: 1, status: 'verified', fingerprint: sha1('same bytes'),
      });
      const read = jest.spyOn(fingerprint, 'fingerprintFile');

      const result = await diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [record('failed.php', 10, t + 60000), record('grown.php', 11, t + 60000)],
      });

      expect(result.items.map(i => i.reason)).toEqual(['modified', 'modified']);
      expect(read).not.toHaveBeenCalled();
    });

    test('a file above the size cap is not read; an unreadable one is modified', async () => {
      const t = 1700000000000;
      const huge = fingerprint.MAX_FINGERPRINT_SIZE + 1;
      const index = await getSyncIndex('k');
      index.set('huge.bin', { size: huge, mtime: t, verifiedAt: 1, status: 'verified', fingerprint: 'x' });
      index.set('gone.php', { size: 4, mtime: t, verifiedAt: 1, status: 'verified', fingerprint: sha1('gone') });
      const read = jest.spyOn(fingerprint, 'fingerprintFile');

      const result = await diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [record('huge.bin', huge, t + 60000), record('gone.php', 4, t + 60000)],
      });

      expect(result.items.map(i => [path.basename(i.localPath), i.reason])).toEqual([
        ['huge.bin', 'modified'],
        ['gone.php', 'modified'],
      ]);
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(local('gone.php'));
    });

    test('a cancellation stops the reads; what was not settled stays modified', async () => {
      const t = 1700000000000;
      const index = await getSyncIndex('k');
      const touched = onDisk('touched.php', 'same bytes', t + 60000);
      index.set('touched.php', {
        size: 10, mtime: t, verifiedAt: 1, status: 'verified', fingerprint: sha1('same bytes'),
      });

      const result = await diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [touched, record('fresh.php', 1, t)],
        isCancelled: () => true,
      });

      expect(result.cancelled).toBe(true);
      expect(result.items.map(i => i.reason)).toEqual(['modified', 'new']);
      expect(index.get('touched.php')).toMatchObject({ mtime: t });
    });

    test('nested paths are matched by their "/" relative form', async () => {
      const index = await getSyncIndex('k');
      index.set('src/deep/a.php', { size: 10, mtime: 1700000000000, verifiedAt: 1, status: 'verified' });

      const result = await diffAgainstIndex({
        baseDir,
        index,
        toRemotePath,
        scanned: [record(path.join('src', 'deep', 'a.php'), 10, 1700000000000)],
      });
      expect(result.unchanged).toBe(1);
      expect(result.missingLocally).toEqual([]);
    });
  });

  describe('classifyAgainstIndex', () => {
    beforeEach(() => {
      vol.reset();
      resetSyncIndex();
      initSyncIndex({ storagePath: undefined });
    });

    const sha1 = (content: string) => crypto.createHash('sha1').update(content).digest('hex');
    const t = 1700000000000;

    function onDisk(name: string, content: string, mtime: number) {
      vol.mkdirSync(baseDir, { recursive: true } as any);
      vol.writeFileSync(local(name), content);
      vol.utimesSync(local(name), new Date(mtime), new Date(mtime));
      return { fsPath: local(name), size: Buffer.byteLength(content), mtime };
    }

    test('new, unchanged and modified by stat alone', async () => {
      const index = await getSyncIndex('k');
      index.set('a.php', { size: 3, mtime: t, verifiedAt: 1, status: 'verified', fingerprint: sha1('abc') });

      expect(
        await classifyAgainstIndex({ index, relPath: 'fresh.php', fsPath: local('fresh.php'), size: 1, mtime: t })
      ).toEqual({ verdict: 'new', byContent: false });
      expect(
        await classifyAgainstIndex({ index, relPath: 'a.php', fsPath: local('a.php'), size: 3, mtime: t + 999 })
      ).toEqual({ verdict: 'unchanged', byContent: false });
      expect(
        await classifyAgainstIndex({ index, relPath: 'a.php', fsPath: local('a.php'), size: 4, mtime: t })
      ).toEqual({ verdict: 'modified', byContent: false });
    });

    test('the same size under another mtime is settled by the content', async () => {
      const index = await getSyncIndex('k');
      const touched = onDisk('a.php', 'abc', t + 60000);
      index.set('a.php', { size: 3, mtime: t, verifiedAt: 1, status: 'verified', fingerprint: sha1('abc') });

      expect(await classifyAgainstIndex({ index, relPath: 'a.php', ...touched })).toEqual({
        verdict: 'unchanged',
        byContent: true,
      });
      expect(index.get('a.php')!.mtime).toBe(t + 60000);

      const edited = onDisk('a.php', 'abd', t + 120000);
      expect(await classifyAgainstIndex({ index, relPath: 'a.php', ...edited })).toEqual({
        verdict: 'modified',
        byContent: true,
      });
      expect(index.get('a.php')!.mtime).toBe(t + 60000);
    });

    test('compareContent off keeps the old rule', async () => {
      const index = await getSyncIndex('k');
      const touched = onDisk('a.php', 'abc', t + 60000);
      index.set('a.php', { size: 3, mtime: t, verifiedAt: 1, status: 'verified', fingerprint: sha1('abc') });

      expect(
        await classifyAgainstIndex({ index, relPath: 'a.php', ...touched, compareContent: false })
      ).toEqual({ verdict: 'modified', byContent: false });
    });

    test('an entry replaced while the file was being read is not refreshed', async () => {
      const index = await getSyncIndex('k');
      const touched = onDisk('a.php', 'abc', t + 60000);
      index.set('a.php', { size: 3, mtime: t, verifiedAt: 1, status: 'verified', fingerprint: sha1('abc') });
      // a verified upload of another version lands mid-read
      const replaced = { size: 3, mtime: t + 90000, verifiedAt: 2, status: 'verified' as const, fingerprint: sha1('xyz') };
      jest.spyOn(fingerprint, 'fingerprintFile').mockImplementation(async () => {
        index.set('a.php', replaced);
        return sha1('abc');
      });

      const result = await classifyAgainstIndex({ index, relPath: 'a.php', ...touched });

      expect(result).toEqual({ verdict: 'unchanged', byContent: true });
      expect(index.get('a.php')).toEqual(replaced);
      jest.restoreAllMocks();
    });
  });
});
