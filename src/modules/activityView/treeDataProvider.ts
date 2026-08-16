import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { COMMAND_ACTIVITY_REVEAL } from '../../constants';
import { simplifyPath } from '../../helper';
import { ActivityEntry, ActivityKind, ActivityStatus, getEntries } from '../activityLog';

/**
 * Renders the activity log as a flat, newest-first list.
 *
 * The log is bounded and every change can reorder it, so the view rebuilds the
 * whole list on refresh instead of tracking per-item events.
 */

// activityLog numbers real entries from 1, so a negative id can never collide
// with one. It marks the row shown when there is nothing to display.
const PLACEHOLDER_ID = -1;

const placeholder: ActivityEntry = {
  id: PLACEHOLDER_ID,
  kind: ActivityKind.Sync,
  status: ActivityStatus.Skipped,
  startedAt: 0,
};

/** The empty-state row is a fake entry; commands must not act on it. */
export function isPlaceholder(entry: ActivityEntry): boolean {
  return Boolean(entry) && entry.id === PLACEHOLDER_ID;
}

// @types/vscode is pinned to 1.40, where ThemeIcon still has a private
// constructor and no color parameter. Both exist at runtime on every vscode
// this extension supports, so reach the real constructor through a local type.
type ThemeIconConstructor = new (id: string, color?: vscode.ThemeColor) => vscode.ThemeIcon;
const themeIcon = (vscode.ThemeIcon as unknown) as ThemeIconConstructor;

const kindIcons: { [kind in ActivityKind]: string } = {
  [ActivityKind.Upload]: 'cloud-upload',
  [ActivityKind.Download]: 'cloud-download',
  [ActivityKind.Delete]: 'trash',
  [ActivityKind.Rename]: 'arrow-right',
  [ActivityKind.Restore]: 'history',
  [ActivityKind.Sync]: 'sync',
};

function pad2(value: number): string {
  return ('00' + value).slice(-2);
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

// path.win32.basename understands both separators, so remote (posix) paths are
// handled correctly on windows too.
function targetPath(entry: ActivityEntry): string {
  return entry.localPath || entry.remotePath || '';
}

function makeLabel(entry: ActivityEntry): string {
  const target = targetPath(entry);
  if (entry.kind === ActivityKind.Rename && entry.fromPath) {
    return `${path.basename(entry.fromPath)} → ${path.basename(target)}`;
  }

  return path.basename(target) || entry.kind;
}

function makeDescription(entry: ActivityEntry): string {
  const time = formatTime(entry.startedAt);
  const location = entry.localPath ? simplifyPath(entry.localPath) : entry.remotePath;
  return location ? `${time} · ${location}` : time;
}

function makeTooltip(entry: ActivityEntry): string {
  const lines = [`${entry.kind} · ${entry.status}`];
  if (entry.fromPath) {
    lines.push(`Desde: ${entry.fromPath}`);
  }
  if (entry.localPath) {
    lines.push(`Local: ${entry.localPath}`);
  }
  if (entry.remotePath) {
    lines.push(`Remoto: ${entry.remotePath}`);
  }
  lines.push(`Perfil: ${entry.profile || '(ninguno)'}`);
  if (entry.serviceName) {
    lines.push(`Servicio: ${entry.serviceName}`);
  }
  if (entry.finishedAt !== undefined) {
    lines.push(`Duración: ${entry.finishedAt - entry.startedAt} ms`);
  }
  if (entry.error) {
    lines.push(`Error: ${entry.error}`);
  }

  return lines.join('\n');
}

function makeIcon(entry: ActivityEntry): vscode.ThemeIcon {
  switch (entry.status) {
    case ActivityStatus.Failed:
      return new themeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
    case ActivityStatus.Pending:
      return new themeIcon('loading~spin');
    case ActivityStatus.Cancelled:
      return new themeIcon('circle-slash');
    case ActivityStatus.Skipped:
      return new themeIcon('dash');
    default:
      return new themeIcon(kindIcons[entry.kind]);
  }
}

function makeCommand(entry: ActivityEntry): vscode.Command | undefined {
  // getTreeItem is synchronous, hence the sync stat; a deleted or downloaded-
  // then-removed file must not offer a click that opens an error.
  if (!entry.localPath || !fs.existsSync(entry.localPath)) {
    return undefined;
  }

  return {
    command: COMMAND_ACTIVITY_REVEAL,
    title: 'Abrir archivo local',
    arguments: [entry],
  };
}

export default class ActivityTreeDataProvider implements vscode.TreeDataProvider<ActivityEntry> {
  private _onDidChangeTreeData: vscode.EventEmitter<ActivityEntry | undefined> =
    new vscode.EventEmitter<ActivityEntry | undefined>();
  readonly onDidChangeTreeData: vscode.Event<ActivityEntry | undefined> = this._onDidChangeTreeData
    .event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(entry: ActivityEntry): vscode.TreeItem {
    if (isPlaceholder(entry)) {
      return {
        label: 'No activity yet',
        contextValue: 'activity.empty',
        iconPath: new themeIcon('info'),
        collapsibleState: vscode.TreeItemCollapsibleState.None,
      };
    }

    const isRetryable = entry.status === ActivityStatus.Failed && Boolean(entry.retry);
    return {
      // a stable id keeps the selection across the full refreshes above
      id: String(entry.id),
      label: makeLabel(entry),
      description: makeDescription(entry),
      tooltip: makeTooltip(entry),
      iconPath: makeIcon(entry),
      contextValue: isRetryable ? 'activity.failed' : 'activity',
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      command: makeCommand(entry),
    };
  }

  getChildren(entry?: ActivityEntry): ActivityEntry[] {
    // flat list: nothing but the root has children
    if (entry) {
      return [];
    }

    // getEntries() is already sorted by startedAt descending
    const entries = getEntries();
    return entries.length > 0 ? entries : [placeholder];
  }
}
