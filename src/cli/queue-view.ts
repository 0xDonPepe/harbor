import type { OperationDto, OperationQueueDto } from '../contracts/api.js';

// Decision 183: how `harbor queue` and the busy-app question word the queue. Pure (unit-tested).

export function queueStatus(o: OperationDto): string {
  if (o.state === 'queued') return o.startedAt ? 'running' : 'waiting';
  if (o.state === 'applying' || o.state === 'verifying') return 'running';
  return `finished: ${o.state === 'needs_action' ? 'needs action' : o.error?.code === 'REVIEW_NEEDED' ? 'needs your review' : o.state}`;
}

function textTable(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ')).join('\n');
}

export function queueText(q: OperationQueueDto): string {
  const row = (o: OperationDto, n: string) => [n, queueStatus(o), o.kind, o.instanceName || o.instanceId, o.state === 'queued' || o.state === 'applying' || o.state === 'verifying' ? o.phase : (o.finishedAt ?? ''), o.actor, o.cancellable ? 'yes' : '-', o.id];
  const lines: string[] = [];
  if (q.active.length) lines.push(textTable([['#', 'STATE', 'ACTION', 'APP', 'PHASE', 'BY', 'CANCEL', 'ID'], ...q.active.map((o, i) => row(o, String(i + 1)))]));
  else lines.push('Nothing is running or waiting.');
  if (q.recent.length) lines.push('', 'Finished:', textTable([['#', 'STATE', 'ACTION', 'APP', 'FINISHED', 'BY', 'CANCEL', 'ID'], ...q.recent.map((o) => row(o, '-'))]));
  if (q.active.some((o) => o.cancellable)) lines.push('', 'Cancel a waiting item with: harbor queue cancel <id>');
  return lines.join('\n');
}

// "<app> is busy (<kind> running|waiting). Queue <kind> to run after it? …"
export function busyQuestion(app: string, kind: string, busy: Pick<OperationDto, 'kind' | 'state' | 'startedAt'>): string {
  const how = busy.state === 'queued' && !busy.startedAt ? 'waiting' : 'running';
  return `${app} is busy (${busy.kind} ${how}). Queue ${kind} to run after it? Harbor plans it when its turn comes.`;
}

// One line for `harbor status`: what runs and how many wait.
export function queueStatusLine(q: OperationQueueDto): string {
  const running = q.active.find((o) => queueStatus(o) === 'running');
  const waiting = q.active.filter((o) => queueStatus(o) === 'waiting').length;
  if (!running && !waiting) return 'Queue: idle';
  return `Queue: ${running ? `${running.kind} of ${running.instanceName || running.instanceId} running (${running.phase})` : 'nothing running'}${waiting ? `, ${waiting} waiting` : ''}`;
}
