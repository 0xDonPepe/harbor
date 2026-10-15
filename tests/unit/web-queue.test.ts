// Decision 183, the console side of the queue (web/src/app/queue.ts, pure): which actions a busy app still offers,
// a second click on an action that already waits, when a review keeps its typed values instead of queueing, what the
// tray keeps once an operation finishes, how often the console polls, and the tray's quiet "why" lines.
import { describe, expect, it } from 'vitest';
import type { InstanceSummary, OperationDto } from '../../src/contracts/api.js';
import { REFRESH_MS, alreadyQueued, appActionGates, clearFinished, keepFinished, notCancellableReason, queuePollMs, reviewHasValues } from '../../web/src/app/queue.js';

const inst = (installState: InstanceSummary['installState'], extra: Partial<InstanceSummary> = {}): InstanceSummary =>
  ({ id: 'i1', name: 'immich', packageId: 'immich', packageName: 'Immich', installState, runtime: 'running', desired: 'running', displayName: null, ...extra }) as unknown as InstanceSummary;
const op = (extra: Partial<OperationDto> = {}): OperationDto =>
  ({ id: 'o1', instanceId: 'i1', kind: 'install', actor: 'admin', state: 'queued', phase: 'queued', startedAt: null, queuedAction: false, cancellable: true, result: null, error: null, events: [], ...extra }) as unknown as OperationDto;

describe('a busy app still offers what makes sense after its operation (C9)', () => {
  it('an installing app offers Stop, Restart, Remove, Uninstall completely and Update through the queue', () => {
    const installing = inst('installing', { runtime: 'starting' });
    // not busy (no operation listed yet): today's gating
    expect(appActionGates(installing, [])).toEqual({ stop: false, restart: false, remove: false, purge: false, update: false });
    expect(appActionGates(installing, [op({ startedAt: 't', state: 'applying' })])).toEqual({ stop: true, restart: true, remove: true, purge: true, update: true });
  });
  it('keeps today’s gating for a free app', () => {
    expect(appActionGates(inst('installed'), [])).toEqual({ stop: true, restart: true, remove: true, purge: true, update: true });
    expect(appActionGates(inst('installed', { runtime: 'stopped', desired: 'stopped' }), [])).toEqual({ stop: false, restart: false, remove: true, purge: true, update: true });
    expect(appActionGates(inst('retained', { runtime: 'stopped' }), [])).toEqual({ stop: false, restart: false, remove: false, purge: true, update: false });
    expect(appActionGates(inst('failed'), [])).toEqual({ stop: true, restart: false, remove: true, purge: true, update: false });
  });
  it('after a waiting Remove only Uninstall completely makes sense; after an uninstall nothing does', () => {
    const removing = [op({ kind: 'remove' })];
    expect(appActionGates(inst('installed'), removing)).toEqual({ stop: false, restart: false, remove: false, purge: true, update: false });
    expect(appActionGates(inst('installed'), [op({ kind: 'purge' })])).toEqual({ stop: false, restart: false, remove: false, purge: false, update: false });
  });
});

describe('the same action twice (C10)', () => {
  it('finds a waiting operation of the same kind for the same app; a running one or another kind is no duplicate', () => {
    const waitingStop = op({ id: 'w', kind: 'stop', queuedAction: true });
    const active = [op({ id: 'r', kind: 'install', state: 'applying', startedAt: 't' }), waitingStop, op({ id: 'x', kind: 'stop', instanceId: 'other' })];
    expect(alreadyQueued(active, 'i1', 'stop')).toBe(waitingStop);
    expect(alreadyQueued(active, 'i1', 'restart')).toBeNull();
    expect(alreadyQueued(active, 'i1', 'install')).toBeNull(); // picked: it runs, it does not wait
    expect(alreadyQueued([op({ kind: 'stop', startedAt: 't' })], 'i1', 'stop')).toBeNull();
  });
});

describe('approve hits BUSY (C11)', () => {
  it('a review with typed secrets, accepted permissions or changed settings waits and is reviewed again; an empty one may queue', () => {
    expect(reviewHasValues({ acceptPermissions: false })).toBe(false);
    expect(reviewHasValues({ acceptPermissions: false, secrets: {}, settings: {} })).toBe(false);
    expect(reviewHasValues({ acceptPermissions: true })).toBe(true);
    expect(reviewHasValues({ acceptPermissions: false, secrets: { DB: 'x' } })).toBe(true);
    expect(reviewHasValues({ acceptPermissions: false, settings: { model: 'llama' } })).toBe(true);
  });
});

describe('what the tray keeps once an operation finishes (C12, C17)', () => {
  const ok = op({ state: 'succeeded', actor: 'scheduler', kind: 'backup' });
  it('keeps what this console accepted (any outcome), shown-once values and failures of any actor; drops background successes', () => {
    expect(keepFinished(ok, false)).toBe(false);
    expect(keepFinished(op({ state: 'cancelled', actor: 'auto-update' }), false)).toBe(false);
    expect(keepFinished(ok, true)).toBe(true);
    expect(keepFinished(op({ state: 'failed', actor: 'auto-update', error: { code: 'REVIEW_NEEDED', message: 'm', nextAction: 'n' } }), false)).toBe(true);
    expect(keepFinished(op({ state: 'needs_action', actor: 'drive-guard' }), false)).toBe(true);
    expect(keepFinished(op({ state: 'succeeded', actor: 'auto-update', result: { credentials: { username: 'a' } } }), false)).toBe(true);
  });
  it('Clear finished leaves only the items whose values are shown once', () => {
    const words = op({ id: 'w', state: 'succeeded', result: { recoveryKey: 'x y z' } });
    const failed = op({ id: 'f', state: 'failed' });
    expect(clearFinished([op({ id: 's', state: 'succeeded' }), words, failed])).toEqual([words]);
  });
});

describe('polling (C13)', () => {
  it('the full refresh stays at 10 s; only the queue is polled every 2 s while anything is active', () => {
    expect(REFRESH_MS).toBe(10_000);
    expect(queuePollMs(true)).toBe(2000);
    expect(queuePollMs(false)).toBe(10_000);
  });
});

describe('why a waiting item has no Cancel (C14)', () => {
  it('a backup cold pass is part of a backup run, scheduled or started by hand', () => {
    expect(notCancellableReason({ actor: 'scheduler', kind: 'backup' })).toBe('Part of a backup run; it cannot be cancelled.');
  });
});
