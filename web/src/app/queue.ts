import { QUEUEABLE_KINDS, type InstanceSummary, type OperationDto, type QueueableKind } from '../../../src/contracts/api';

// Decision 183: the words the queue speaks in (tray, Home tiles, the queue-mode review). Pure: no DOM, no relative imports.

export const isFinal = (op: Pick<OperationDto, 'state'>) => op.state === 'succeeded' || op.state === 'failed' || op.state === 'needs_action' || op.state === 'cancelled';

export const isQueueable = (kind: string): kind is QueueableKind => (QUEUEABLE_KINDS as readonly string[]).includes(kind);

// "Installing Immich…"
export const DOING: Record<string, string> = { install: 'Installing', start: 'Starting', stop: 'Stopping', remove: 'Removing', reinstall: 'Reinstalling', purge: 'Uninstalling', update: 'Updating', expose: 'Publishing', unexpose: 'Withdrawing the address of', reconfigure: 'Switching the address of', restart: 'Restarting', configure: 'Applying new settings to', seal: 'Encrypting', move: 'Moving', backup: 'Backing up', restore: 'Restoring', relink: 'Securing the links of' };
// "Immich is ready"
export const DONE: Record<string, string> = { install: 'is ready', start: 'is running again', stop: 'is stopped', remove: 'was removed (data kept)', reinstall: 'is back', purge: 'was uninstalled completely', update: 'is up to date', expose: 'is published', unexpose: 'address withdrawn', reconfigure: 'address switched', restart: 'restarted', configure: 'settings applied', seal: 'is encrypted', move: 'moved', backup: 'is backed up', restore: 'is restored', relink: 'links secured' };
export const PHASE: Record<string, string> = { rollback: 'putting the previous version back', purging: 'deleting its data', queued: 'waiting for its turn', preparing: 'preparing', pulling: 'downloading the app', starting: 'starting containers', checking: 'waiting until it answers', stopping: 'stopping', removing: 'cleaning up', reconfiguring: 'applying the new address', verifying: 'checking the result', exposing: 'setting up the address', unexposing: 'removing the address', 'backing-up': 'sending the last changes', restoring: 'restoring its data', copying: 'copying its data', planning: 'planning it now' };
// The bare verb: "Cancel update Immich", "Queue update", "Update Immich"
export const VERB: Record<string, string> = { install: 'install', start: 'start', stop: 'stop', remove: 'remove', reinstall: 'reinstall', purge: 'uninstall', update: 'update', expose: 'publish', unexpose: 'withdraw', reconfigure: 'switch the address of', restart: 'restart', configure: 'apply settings to', seal: 'encrypt', move: 'move', backup: 'back up', restore: 'restore', relink: 'secure the links of' };
// Tiles: "Updating…" while it runs
const TILE: Record<string, string> = { install: 'Installing…', start: 'Starting…', stop: 'Stopping…', remove: 'Removing…', reinstall: 'Reinstalling…', purge: 'Uninstalling…', update: 'Updating…', expose: 'Publishing…', unexpose: 'Withdrawing…', reconfigure: 'Switching address…', restart: 'Restarting…', configure: 'Applying settings…', seal: 'Encrypting…', move: 'Moving…', backup: 'Backing up…', restore: 'Restoring…', relink: 'Securing links…' };

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Running = picked by the runner (it has started); waiting = still queued for its turn.
export const isRunning = (op: Pick<OperationDto, 'state' | 'startedAt'>) => op.state === 'applying' || op.state === 'verifying' || (op.state === 'queued' && op.startedAt !== null);

// A Home tile's line while the app has an operation of its own.
export function tileStatus(op: OperationDto): { label: string; tone: 'busy' } {
  return { label: isRunning(op) ? (TILE[op.kind] ?? 'Working…') : 'Waiting…', tone: 'busy' };
}

// The tray's sentence for one operation.
export function opTitle(op: Pick<OperationDto, 'kind' | 'state' | 'startedAt' | 'error'>, who: string): string {
  if (op.state === 'succeeded') return op.kind === 'unexpose' || op.kind === 'reconfigure' || op.kind === 'configure' || op.kind === 'relink' ? `${who}: ${DONE[op.kind]}` : `${who} ${DONE[op.kind] ?? 'done'}`;
  if (op.state === 'failed') return op.error?.code === 'REVIEW_NEEDED' ? `${capitalize(VERB[op.kind] ?? op.kind)} ${who} needs your review` : `${DOING[op.kind] ?? op.kind} ${who} failed`;
  if (op.state === 'needs_action') return `${who} needs your attention`;
  if (op.state === 'cancelled') return `${capitalize(VERB[op.kind] ?? op.kind)} ${who} was cancelled`;
  if (isRunning(op)) return `${DOING[op.kind] ?? op.kind} ${who}…`;
  return `${capitalize(VERB[op.kind] ?? op.kind)} ${who}`;
}

// Why a waiting item has no Cancel (decision 183: Harbor queued it to protect something).
export function notCancellableReason(op: Pick<OperationDto, 'actor' | 'kind'>): string {
  switch (op.actor) {
    case 'drive-guard':
      return 'Harbor queued this because a drive went away; it cannot be cancelled.';
    case 'link-guard':
      return 'Harbor queued this to keep a link between apps safe; it cannot be cancelled.';
    case 'lock-guard':
      return 'Harbor queued this to start the app once its key is back; it cannot be cancelled.';
    case 'scheduler':
      return 'Part of a scheduled backup; it cannot be cancelled.';
    default:
      return op.kind === 'backup' ? 'Part of a backup run; it cannot be cancelled.' : 'Harbor queued this itself; it cannot be cancelled.';
  }
}

// Values a finished operation shows once: the tray keeps such an item until it is dismissed.
export function hasShownOnce(op: Pick<OperationDto, 'result'>): boolean {
  const r = op.result;
  if (!r) return false;
  return Boolean(r['credentials'] || (Array.isArray(r['shownOnce']) && r['shownOnce'].length) || r['recoveryKey'] || r['installationRecoveryKey']);
}

// "Queue · 1 running, 2 waiting"
export function queueSummary(running: number, waiting: number, finished: number): string {
  const parts = [running ? `${running} running` : '', waiting ? `${waiting} waiting` : '', finished ? `${finished} done` : ''].filter(Boolean);
  return `Queue · ${parts.join(', ') || 'empty'}`;
}

// The name the tray and the queue review use for an app ("Immich", "Immich (immich-2)", or its own display name).
export function whoOf(inst: Pick<InstanceSummary, 'displayName' | 'name' | 'packageId' | 'packageName'> | undefined, fallback: string): string {
  if (!inst) return fallback || 'the app';
  return inst.displayName ?? (inst.name === inst.packageId ? inst.packageName : `${inst.packageName} (${inst.name})`);
}

// The app page's quiet line while the app is busy: "Installing… · Update waiting".
export function appQueueLine(ops: OperationDto[]): string {
  return ops.map((op) => (isRunning(op) ? tileStatus(op).label : `${capitalize(VERB[op.kind] ?? op.kind)} waiting`)).join(' · ');
}
