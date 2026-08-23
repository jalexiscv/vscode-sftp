import * as path from 'path';
import { simplifyPath } from '../../helper';
import { ActivityEntry, ActivityKind, ActivityStatus } from '../activityLog';
import {
  formatBytes,
  formatSummary,
  summarize,
  UploadPlan,
  UploadPlanItem,
  PlanItemStatus,
} from '../uploadPlan';

/**
 * Labels, descriptions, tooltips and icons of the activity tree, as plain
 * strings and icon ids.
 *
 * Kept apart from the tree data provider so the presentation rules — what a
 * failed plan looks like, how an item describes itself — can be unit tested
 * without a vscode runtime; the provider only wraps these into TreeItems.
 */

/** A codicon id plus an optional theme colour id; the provider builds the ThemeIcon. */
export interface IconSpec {
  id: string;
  color?: string;
}

const ERROR_COLOR = 'problemsErrorIcon.foreground';
const WARNING_COLOR = 'problemsWarningIcon.foreground';
const PASSED_COLOR = 'testing.iconPassed';

const kindIcons: { [kind in ActivityKind]: string } = {
  [ActivityKind.Upload]: 'cloud-upload',
  [ActivityKind.Download]: 'cloud-download',
  [ActivityKind.Delete]: 'trash',
  [ActivityKind.Rename]: 'arrow-right',
  [ActivityKind.Restore]: 'history',
  [ActivityKind.Sync]: 'sync',
};

const planItemIcons: { [status in PlanItemStatus]: IconSpec } = {
  pending: { id: 'circle-outline' },
  uploading: { id: 'loading~spin' },
  verified: { id: 'check', color: PASSED_COLOR },
  failed: { id: 'error', color: ERROR_COLOR },
  skipped: { id: 'dash' },
  stale: { id: 'warning', color: WARNING_COLOR },
};

function pad2(value: number): string {
  return ('00' + value).slice(-2);
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    formatTime(timestamp)
  );
}

// ---------------------------------------------------------------------------
// activity entries

// path.basename understands both separators on windows, so remote (posix)
// paths are handled correctly there too.
function targetPath(entry: ActivityEntry): string {
  return entry.localPath || entry.remotePath || '';
}

export function activityLabel(entry: ActivityEntry): string {
  const target = targetPath(entry);
  if (entry.kind === ActivityKind.Rename && entry.fromPath) {
    return `${path.basename(entry.fromPath)} → ${path.basename(target)}`;
  }

  return path.basename(target) || entry.kind;
}

export function activityDescription(entry: ActivityEntry): string {
  const time = formatTime(entry.startedAt);
  const location = entry.localPath ? simplifyPath(entry.localPath) : entry.remotePath;
  return location ? `${time} · ${location}` : time;
}

export function activityTooltip(entry: ActivityEntry): string {
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

export function activityIcon(entry: ActivityEntry): IconSpec {
  switch (entry.status) {
    case ActivityStatus.Failed:
      return { id: 'error', color: ERROR_COLOR };
    case ActivityStatus.Pending:
      return { id: 'loading~spin' };
    case ActivityStatus.Cancelled:
      return { id: 'circle-slash' };
    case ActivityStatus.Skipped:
      return { id: 'dash' };
    default:
      return { id: kindIcons[entry.kind] };
  }
}

// ---------------------------------------------------------------------------
// plans

/** `HH:mm:ss · <source> · <service>` — when, why, where. */
export function planLabel(plan: UploadPlan): string {
  const parts = [formatTime(plan.createdAt), plan.source];
  if (plan.serviceName) {
    parts.push(plan.serviceName);
  }
  return parts.join(' · ');
}

export function planDescription(plan: UploadPlan): string {
  return formatSummary(summarize(plan));
}

export function planTooltip(plan: UploadPlan): string {
  const summary = summarize(plan);
  const lines = [`Upload plan ${plan.id}`];
  lines.push(`Service: ${plan.serviceName || '(unnamed)'}`);
  lines.push(`Profile: ${plan.profile || '(none)'}`);
  lines.push(`Source: ${plan.source}`);
  lines.push(`Created: ${formatDateTime(plan.createdAt)}`);
  lines.push(`Finished: ${plan.finishedAt ? formatDateTime(plan.finishedAt) : '(in progress)'}`);
  lines.push(`Items: ${formatSummary(summary)}`);
  lines.push(`Size: ${formatBytes(summary.bytes)}`);
  return lines.join('\n');
}

/**
 * Running beats everything (the spinner says "wait"); a failure beats the
 * rest (it needs a decision); work still to do shows a clock; otherwise the
 * plan is done.
 */
export function planIcon(plan: UploadPlan, isRunning: boolean): IconSpec {
  if (isRunning) {
    return { id: 'loading~spin' };
  }

  const summary = summarize(plan);
  if (summary.failed > 0) {
    return { id: 'error', color: ERROR_COLOR };
  }
  if (summary.pending + summary.uploading + summary.stale > 0) {
    return { id: 'clock' };
  }
  return { id: 'pass', color: PASSED_COLOR };
}

// ---------------------------------------------------------------------------
// plan items

export function planItemLabel(item: UploadPlanItem): string {
  return path.basename(item.localPath) || item.localPath;
}

/** `<status> · <reason> · <workspace-relative path>` */
export function planItemDescription(item: UploadPlanItem): string {
  const parts: string[] = [item.status, item.reason];
  const location = simplifyPath(item.localPath);
  if (location) {
    parts.push(location);
  }
  return parts.join(' · ');
}

export function planItemTooltip(item: UploadPlanItem): string {
  const lines = [`${item.status} · ${item.reason}`];
  lines.push(`Local: ${item.localPath}`);
  lines.push(`Remote: ${item.remotePath}`);
  lines.push(`Size: ${formatBytes(item.localSize || 0)}`);
  lines.push(`Attempts: ${item.attempts}`);
  if (item.startedAt !== undefined && item.finishedAt !== undefined) {
    lines.push(`Duration: ${item.finishedAt - item.startedAt} ms`);
  }
  if (item.error) {
    lines.push(`Error: ${item.error}`);
  }
  return lines.join('\n');
}

export function planItemIcon(item: UploadPlanItem): IconSpec {
  return planItemIcons[item.status] || planItemIcons.pending;
}
