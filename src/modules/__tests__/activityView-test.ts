jest.mock('fs');
// The default vscode mock answers every lookup with "Nothing", which cannot be
// `new`-ed. The tree data provider builds ThemeIcons, ThemeColors and an
// EventEmitter, so give it minimal real classes and keep "Nothing" for the
// rest.
jest.mock('vscode', () => {
  const Nothing = jest.requireActual('../../../__mocks__/vscode.js');
  class Uri {
    static file(fsPath: string) {
      return new Uri(fsPath);
    }
    readonly scheme = 'file';
    constructor(readonly fsPath: string) {}
  }
  class ThemeIcon {
    constructor(readonly id: string, readonly color?: any) {}
  }
  class ThemeColor {
    constructor(readonly id: string) {}
  }
  class EventEmitter {
    event = () => ({ dispose() {} });
    fire() {}
  }
  const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
  const target = { Uri, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState };
  return new Proxy(target, { get: (t, key) => (key in t ? t[key] : Nothing) });
});
// the log rebuilds retries through the file handlers; nothing here transfers
jest.mock('../../fileHandlers', () => ({
  uploadFile: jest.fn(() => Promise.resolve()),
  downloadFile: jest.fn(() => Promise.resolve()),
}));
// the runner is developed on a sibling branch; the view only asks it whether a
// plan is running and subscribes to changes
jest.mock('../planRunner', () => ({
  isPlanRunning: jest.fn(() => false),
  onDidChangeRunning: jest.fn(() => ({ dispose() {} })),
}));
// simplifyPath goes through vscode.workspace.asRelativePath; make it the
// identity so descriptions are predictable
jest.mock('../../host', () => ({
  ...jest.requireActual('../../host'),
  pathRelativeToWorkspace: (p: string) => p,
}));

import * as path from 'path';
import { vol } from 'memfs';
import * as activityLog from '../activityLog';
import { createPlan, updateItem, UploadPlan, __resetForTest as resetPlans } from '../uploadPlan';
import { isPlanRunning } from '../planRunner';
import {
  buildRootNodes,
  buildChildNodes,
  isGroupNode,
  isPlanNode,
  isPlanItemNode,
  isActivityEntry,
  isPlaceholder,
  localPathOf,
  nodeId,
  placeholder,
  planNode,
  planItemNode,
  GroupNode,
  PlanNode,
  PlanItemNode,
  MoreNode,
  PLAN_ITEMS_PAGE,
  isMoreNode,
  moreNode,
} from '../activityView/nodes';
import {
  activityLabel,
  activityDescription,
  activityIcon,
  planLabel,
  planDescription,
  planTooltip,
  planIcon,
  planItemLabel,
  planItemDescription,
  planItemTooltip,
  planItemIcon,
  formatTime,
} from '../activityView/format';
import ActivityTreeDataProvider from '../activityView/treeDataProvider';

const { ActivityKind, ActivityStatus } = activityLog;

const baseDir = path.resolve(path.sep, 'projects', 'site');
const local = (...segments: string[]) => path.join(baseDir, ...segments);
const at = new Date(2026, 7, 22, 15, 30, 12);

function makePlan(
  names: string[],
  overrides: Partial<Pick<UploadPlan, 'serviceName' | 'profile' | 'source'>> = {}
): UploadPlan {
  return createPlan(
    {
      serviceName: 'site',
      profile: 'prod',
      source: 'scan',
      ...overrides,
      items: names.map(name => ({
        localPath: local(name),
        remotePath: '/var/www/html/' + name,
        reason: 'modified' as const,
        localSize: 1024,
        localMtime: at.getTime(),
      })),
    },
    at
  );
}

function entry(overrides: Partial<activityLog.ActivityEntry> = {}): activityLog.ActivityEntry {
  return {
    id: 7,
    kind: ActivityKind.Upload,
    status: ActivityStatus.Success,
    localPath: local('a.php'),
    remotePath: '/var/www/html/a.php',
    startedAt: at.getTime(),
    ...overrides,
  };
}

describe('activityView nodes', () => {
  beforeEach(() => {
    activityLog.__resetForTest();
    resetPlans();
  });

  describe('guards', () => {
    test('tell the four kinds of node apart', () => {
      const plan = makePlan(['a.php']);
      const group: GroupNode = { nodeType: 'group', group: 'plans' };
      const pNode = planNode(plan);
      const iNode = planItemNode(plan, plan.items[0]);
      const e = entry();

      expect(isGroupNode(group)).toBe(true);
      expect(isPlanNode(pNode)).toBe(true);
      expect(isPlanItemNode(iNode)).toBe(true);
      expect(isActivityEntry(e)).toBe(true);

      expect(isGroupNode(e)).toBe(false);
      expect(isPlanNode(e)).toBe(false);
      expect(isPlanItemNode(e)).toBe(false);
      expect(isActivityEntry(pNode)).toBe(false);
      expect(isActivityEntry(iNode)).toBe(false);
      expect(isActivityEntry(group)).toBe(false);
      expect(isActivityEntry(undefined)).toBe(false);
    });

    test('the placeholder is an activity entry that commands must ignore', () => {
      expect(isActivityEntry(placeholder)).toBe(true);
      expect(isPlaceholder(placeholder)).toBe(true);
      expect(isPlaceholder(entry())).toBe(false);
      expect(isPlaceholder(planNode(makePlan([])))).toBe(false);
      expect(isPlaceholder(undefined)).toBe(false);
    });
  });

  describe('localPathOf', () => {
    test('a plan item and an activity entry open their local file', () => {
      const plan = makePlan(['a.php']);
      expect(localPathOf(planItemNode(plan, plan.items[0]))).toBe(local('a.php'));
      expect(localPathOf(entry({ localPath: local('b.php') }))).toBe(local('b.php'));
    });

    test('groups, plans, the placeholder and remote-only entries have none', () => {
      const plan = makePlan(['a.php']);
      expect(localPathOf({ nodeType: 'group', group: 'plans' })).toBeUndefined();
      expect(localPathOf(planNode(plan))).toBeUndefined();
      expect(localPathOf(placeholder)).toBeUndefined();
      expect(localPathOf(entry({ localPath: undefined }))).toBeUndefined();
    });
  });

  describe('nodeId', () => {
    test('is stable and cannot collide across kinds', () => {
      const plan = makePlan(['a.php']);
      expect(nodeId({ nodeType: 'group', group: 'plans' })).toBe('group:plans');
      expect(nodeId({ nodeType: 'group', group: 'activity' })).toBe('group:activity');
      expect(nodeId(planNode(plan))).toBe(`plan:${plan.id}`);
      expect(nodeId(planItemNode(plan, plan.items[0]))).toBe(`plan:${plan.id}:${local('a.php')}`);
      expect(nodeId(entry({ id: 42 }))).toBe('42');
    });
  });

  describe('buildRootNodes', () => {
    test('without plans the root is the flat log, newest first', () => {
      const first = entry({ id: 1 });
      const second = entry({ id: 2 });
      expect(buildRootNodes([second, first], [])).toEqual([second, first]);
    });

    test('without plans and without entries the root is the placeholder', () => {
      expect(buildRootNodes([], [])).toEqual([placeholder]);
    });

    test('with a plan the root becomes the two groups, plans first', () => {
      const roots = buildRootNodes([entry()], [makePlan([])]);
      expect(roots.map(node => (node as GroupNode).group)).toEqual(['plans', 'activity']);
      expect(roots.every(isGroupNode)).toBe(true);
    });
  });

  describe('buildChildNodes', () => {
    test('the plans group lists one node per plan in the given order', () => {
      const older = makePlan(['a.php']);
      const newer = makePlan(['b.php']);
      const children = buildChildNodes({ nodeType: 'group', group: 'plans' }, [], [newer, older]);
      expect(children.map(node => (node as PlanNode).plan.id)).toEqual([newer.id, older.id]);
    });

    test('the activity group lists the entries, or the placeholder', () => {
      const e = entry();
      expect(buildChildNodes({ nodeType: 'group', group: 'activity' }, [e], [])).toEqual([e]);
      expect(buildChildNodes({ nodeType: 'group', group: 'activity' }, [], [])).toEqual([placeholder]);
    });

    test('a plan lists its items, each bound to the plan', () => {
      const plan = makePlan(['a.php', 'b.php']);
      const children = buildChildNodes(planNode(plan), [], [plan]) as PlanItemNode[];
      expect(children.map(node => path.basename(node.item.localPath))).toEqual(['a.php', 'b.php']);
      expect(children.every(node => node.plan === plan)).toBe(true);
    });

    test('items and entries are leaves', () => {
      const plan = makePlan(['a.php']);
      expect(buildChildNodes(planItemNode(plan, plan.items[0]), [], [plan])).toEqual([]);
      expect(buildChildNodes(entry(), [], [plan])).toEqual([]);
    });

    test('a plan longer than a page lists the first page and a "more" row', () => {
      const names = Array.from({ length: PLAN_ITEMS_PAGE + 5 }, (_, i) => `f${i}.php`);
      const plan = makePlan(names);

      const children = buildChildNodes(planNode(plan), [], [plan]);

      expect(children.length).toBe(PLAN_ITEMS_PAGE + 1);
      expect(children.slice(0, -1).every(node => isPlanItemNode(node))).toBe(true);
      const last = children[children.length - 1];
      expect(isMoreNode(last)).toBe(true);
      expect(last as MoreNode).toMatchObject({
        plan,
        shown: PLAN_ITEMS_PAGE,
        total: PLAN_ITEMS_PAGE + 5,
      });

      // the caller says how many items are visible; enough shows them all
      const grown = buildChildNodes(planNode(plan), [], [plan], () => PLAN_ITEMS_PAGE * 2);
      expect(grown.length).toBe(PLAN_ITEMS_PAGE + 5);
      expect(grown.every(node => isPlanItemNode(node))).toBe(true);
    });

    test('a plan that fits in a page has no "more" row; the row is a leaf with a stable id', () => {
      const plan = makePlan(['a.php']);
      expect(buildChildNodes(planNode(plan), [], [plan]).every(node => isPlanItemNode(node))).toBe(
        true
      );

      const more = moreNode(plan, 1);
      expect(buildChildNodes(more, [], [plan])).toEqual([]);
      expect(nodeId(more)).toBe(`plan:${plan.id}:`);
      expect(localPathOf(more)).toBeUndefined();
      expect(isPlanItemNode(more)).toBe(false);
    });
  });
});

describe('activityView format', () => {
  beforeEach(() => {
    resetPlans();
  });

  describe('activity entries', () => {
    test('label is the basename, or the rename arrow', () => {
      expect(activityLabel(entry())).toBe('a.php');
      expect(
        activityLabel(
          entry({ kind: ActivityKind.Rename, fromPath: local('old.php'), localPath: local('new.php') })
        )
      ).toBe('old.php → new.php');
      expect(activityLabel(entry({ localPath: undefined, remotePath: '/var/www/html/r.php' }))).toBe(
        'r.php'
      );
    });

    test('description is time and location', () => {
      expect(activityDescription(entry())).toBe(`15:30:12 · ${local('a.php')}`);
      expect(activityDescription(entry({ localPath: undefined, remotePath: '/r.php' }))).toBe(
        '15:30:12 · /r.php'
      );
      expect(activityDescription(entry({ localPath: undefined, remotePath: undefined }))).toBe(
        '15:30:12'
      );
    });

    test('icon follows the status first and the kind otherwise', () => {
      expect(activityIcon(entry({ status: ActivityStatus.Failed }))).toEqual({
        id: 'error',
        color: 'problemsErrorIcon.foreground',
      });
      expect(activityIcon(entry({ status: ActivityStatus.Pending })).id).toBe('loading~spin');
      expect(activityIcon(entry({ status: ActivityStatus.Cancelled })).id).toBe('circle-slash');
      expect(activityIcon(entry({ status: ActivityStatus.Skipped })).id).toBe('dash');
      expect(activityIcon(entry({ kind: ActivityKind.Upload })).id).toBe('cloud-upload');
      expect(activityIcon(entry({ kind: ActivityKind.Download })).id).toBe('cloud-download');
      expect(activityIcon(entry({ kind: ActivityKind.Delete })).id).toBe('trash');
    });
  });

  describe('plans', () => {
    test('label is time, source and service', () => {
      expect(planLabel(makePlan([]))).toBe('15:30:12 · scan · site');
      expect(planLabel(makePlan([], { serviceName: '', source: 'command' }))).toBe('15:30:12 · command');
    });

    test('description is the summary line', () => {
      const plan = makePlan(['a.php', 'b.php', 'c.php']);
      updateItem(plan.id, local('a.php'), { status: 'verified' });
      updateItem(plan.id, local('b.php'), { status: 'failed' });
      expect(planDescription(plan)).toBe('3 files — 1 verified, 1 failed, 1 pending');
    });

    test('tooltip names the plan, its facts and its size', () => {
      const plan = makePlan(['a.php', 'b.php']);
      const tooltip = planTooltip(plan);
      expect(tooltip).toContain(`Upload plan ${plan.id}`);
      expect(tooltip).toContain('Service: site');
      expect(tooltip).toContain('Profile: prod');
      expect(tooltip).toContain('Source: scan');
      expect(tooltip).toContain('Created: 2026-08-22 15:30:12');
      expect(tooltip).toContain('Finished: (in progress)');
      expect(tooltip).toContain('Items: 2 files — 0 verified, 0 failed, 2 pending');
      expect(tooltip).toContain('Size: 2.0 KB');
    });

    test('icon: running > failed > pending > done', () => {
      const plan = makePlan(['a.php', 'b.php']);
      expect(planIcon(plan, true).id).toBe('loading~spin');
      expect(planIcon(plan, false).id).toBe('clock');

      updateItem(plan.id, local('a.php'), { status: 'failed' });
      expect(planIcon(plan, false)).toEqual({ id: 'error', color: 'problemsErrorIcon.foreground' });
      // running still wins over a failure
      expect(planIcon(plan, true).id).toBe('loading~spin');

      updateItem(plan.id, local('a.php'), { status: 'verified' });
      updateItem(plan.id, local('b.php'), { status: 'stale' });
      expect(planIcon(plan, false).id).toBe('clock');

      updateItem(plan.id, local('b.php'), { status: 'skipped' });
      expect(planIcon(plan, false)).toEqual({ id: 'pass', color: 'testing.iconPassed' });
    });
  });

  describe('plan items', () => {
    test('label, description and tooltip', () => {
      const plan = makePlan(['src/deep/a.php']);
      const item = plan.items[0];
      expect(planItemLabel(item)).toBe('a.php');
      expect(planItemDescription(item)).toBe(`pending · modified · ${local('src/deep/a.php')}`);

      updateItem(plan.id, item.localPath, { status: 'failed', attempts: 3, error: 'size mismatch' });
      const tooltip = planItemTooltip(item);
      expect(tooltip).toContain('failed · modified');
      expect(tooltip).toContain(`Local: ${local('src/deep/a.php')}`);
      expect(tooltip).toContain('Remote: /var/www/html/src/deep/a.php');
      expect(tooltip).toContain('Size: 1.0 KB');
      expect(tooltip).toContain('Attempts: 3');
      expect(tooltip).toContain('Error: size mismatch');
    });

    test('icon by status', () => {
      const plan = makePlan(['a.php']);
      const item = plan.items[0];
      const iconFor = (status: any) => {
        item.status = status;
        return planItemIcon(item);
      };
      expect(iconFor('pending').id).toBe('circle-outline');
      expect(iconFor('uploading').id).toBe('loading~spin');
      expect(iconFor('verified')).toEqual({ id: 'check', color: 'testing.iconPassed' });
      expect(iconFor('failed')).toEqual({ id: 'error', color: 'problemsErrorIcon.foreground' });
      expect(iconFor('skipped').id).toBe('dash');
      // a plain check: settled by the user, not by a verification
      expect(iconFor('assumed')).toEqual({ id: 'check' });
      expect(iconFor('stale')).toEqual({ id: 'warning', color: 'problemsWarningIcon.foreground' });
    });
  });

  test('formatTime zero-pads', () => {
    expect(formatTime(new Date(2026, 0, 1, 9, 5, 3).getTime())).toBe('09:05:03');
  });
});

describe('ActivityTreeDataProvider', () => {
  let provider: ActivityTreeDataProvider;

  beforeEach(() => {
    activityLog.__resetForTest();
    resetPlans();
    vol.reset();
    (isPlanRunning as jest.Mock).mockReturnValue(false);
    provider = new ActivityTreeDataProvider();
  });

  test('renders the flat log while there is no plan', () => {
    activityLog.record({ kind: ActivityKind.Upload, localPath: local('a.php') });
    const roots = provider.getChildren();
    expect(roots).toHaveLength(1);
    expect(isActivityEntry(roots[0])).toBe(true);

    const item = provider.getTreeItem(roots[0]);
    expect(item.label).toBe('a.php');
    expect(item.id).toBe('1');
    expect(item.contextValue).toBe('activity');
    expect((item.iconPath as any).id).toBe('loading~spin');
  });

  test('renders the placeholder when there is nothing at all', () => {
    const roots = provider.getChildren();
    const item = provider.getTreeItem(roots[0]);
    expect(item.label).toBe('No activity yet');
    expect(item.contextValue).toBe('activity.empty');
  });

  test('renders the groups, the plans and their items once a plan exists', () => {
    activityLog.record({ kind: ActivityKind.Upload, localPath: local('a.php') });
    const plan = makePlan(['a.php', 'b.php']);
    updateItem(plan.id, local('a.php'), { status: 'verified' });

    const roots = provider.getChildren();
    expect(roots.map(node => provider.getTreeItem(node).label)).toEqual(['Upload plans', 'Activity']);
    const [plansGroup, activityGroup] = roots;
    expect(provider.getTreeItem(plansGroup).description).toBe('1');
    expect(provider.getTreeItem(activityGroup).description).toBe('1');

    const [pNode] = provider.getChildren(plansGroup);
    const planItem = provider.getTreeItem(pNode);
    expect(planItem.id).toBe(`plan:${plan.id}`);
    expect(planItem.label).toBe('15:30:12 · scan · site');
    expect(planItem.description).toBe('2 files — 1 verified, 0 failed, 1 pending');
    expect(planItem.contextValue).toBe('sftpPlan');
    expect((planItem.iconPath as any).id).toBe('clock');

    const items = provider.getChildren(pNode);
    expect(items).toHaveLength(2);
    const first = provider.getTreeItem(items[0]);
    expect(first.label).toBe('a.php');
    expect(first.contextValue).toBe('sftpPlanItem');
    expect((first.iconPath as any).id).toBe('check');
    expect(provider.getChildren(items[0])).toEqual([]);

    const [activityEntry] = provider.getChildren(activityGroup);
    expect(provider.getTreeItem(activityEntry).label).toBe('a.php');
  });

  test('a running plan spins', () => {
    const plan = makePlan(['a.php']);
    (isPlanRunning as jest.Mock).mockImplementation((id: string) => id === plan.id);
    const [plansGroup] = provider.getChildren();
    const [pNode] = provider.getChildren(plansGroup);
    expect((provider.getTreeItem(pNode).iconPath as any).id).toBe('loading~spin');
  });

  test('a plan item always offers a click; the reveal command copes with a missing file', () => {
    const plan = makePlan(['exists.php', 'gone.php']);
    vol.fromJSON({ [local('exists.php')]: '<?php' });

    const [plansGroup] = provider.getChildren();
    const [pNode] = provider.getChildren(plansGroup);
    const [exists, gone] = provider.getChildren(pNode);

    const existsItem = provider.getTreeItem(exists);
    expect(existsItem.command).toBeDefined();
    expect(existsItem.command!.command).toBe('sftp.activity.reveal');
    expect(existsItem.command!.arguments).toEqual([exists]);
    // no stat per node on every rebuild: the command is offered regardless
    expect(provider.getTreeItem(gone).command).toBeDefined();
    expect(provider.getTreeItem(gone).command!.arguments).toEqual([gone]);
    // the group row has no local path and no command
    expect(provider.getTreeItem(plansGroup).command).toBeUndefined();
  });

  describe('scheduleRefresh', () => {
    let fire: jest.SpyInstance;

    beforeAll(() => {
      jest.useFakeTimers({ legacyFakeTimers: true } as any);
    });

    afterAll(() => {
      jest.useRealTimers();
    });

    beforeEach(() => {
      fire = jest.spyOn((provider as any)._onDidChangeTreeData, 'fire');
    });

    afterEach(() => {
      provider.dispose();
      fire.mockRestore();
    });

    test('folds a burst of events into one rebuild, 100 ms after the first', () => {
      for (let i = 0; i < 5; i++) {
        provider.scheduleRefresh();
      }
      expect(fire).not.toHaveBeenCalled();

      jest.advanceTimersByTime(99);
      expect(fire).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(fire).toHaveBeenCalledTimes(1);

      // a steady stream still refreshes once per window, not once per event
      for (let i = 0; i < 3; i++) {
        provider.scheduleRefresh();
        jest.advanceTimersByTime(30);
      }
      jest.advanceTimersByTime(100);
      expect(fire).toHaveBeenCalledTimes(2);
    });

    test('refresh() rebuilds at once and drops the pending rebuild; dispose() drops it too', () => {
      provider.scheduleRefresh();
      provider.refresh();
      expect(fire).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(200);
      expect(fire).toHaveBeenCalledTimes(1);

      provider.scheduleRefresh();
      provider.dispose();
      jest.advanceTimersByTime(200);
      expect(fire).toHaveBeenCalledTimes(1);
    });
  });

  test('a failed entry with a retry is marked as retryable', () => {
    const id = activityLog.record({
      kind: ActivityKind.Upload,
      localPath: local('a.php'),
      retry: () => Promise.resolve(),
    });
    activityLog.fail(id, 'boom');
    const [node] = provider.getChildren();
    expect(provider.getTreeItem(node).contextValue).toBe('activity.failed');
  });
});

describe('ActivityTreeDataProvider: paginated plan items', () => {
  beforeEach(() => {
    resetPlans();
  });

  test('showMore reveals the next page of a plan, page by page', () => {
    const provider = new ActivityTreeDataProvider();
    const total = PLAN_ITEMS_PAGE * 2 + 1;
    const plan = makePlan(Array.from({ length: total }, (_, i) => `f${i}.php`));
    const [plansGroup] = provider.getChildren();
    const [node] = provider.getChildren(plansGroup);

    let children = provider.getChildren(node);
    expect(children.length).toBe(PLAN_ITEMS_PAGE + 1);
    const more = children[children.length - 1] as MoreNode;
    expect(isMoreNode(more)).toBe(true);
    const row = provider.getTreeItem(more);
    expect(row.label).toBe(`${PLAN_ITEMS_PAGE + 1} more file(s)…`);
    expect(row.contextValue).toBe('sftpPlanMore');
    expect(row.command!.command).toBe('sftp.plan.showMore');
    expect(row.command!.arguments).toEqual([more]);

    provider.showMore(plan.id);
    children = provider.getChildren(node);
    expect(children.length).toBe(PLAN_ITEMS_PAGE * 2 + 1);
    expect((children[children.length - 1] as MoreNode).shown).toBe(PLAN_ITEMS_PAGE * 2);

    provider.showMore(plan.id);
    children = provider.getChildren(node);
    expect(children.length).toBe(total);
    expect(children.every(child => isPlanItemNode(child))).toBe(true);
    provider.dispose();
  });
});
