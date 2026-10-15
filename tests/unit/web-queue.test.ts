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
    expect(appActionGates(installing, [])).toEqual({ start: false, stop: false, restart: false, remove: false, purge: false, update: false });
    expect(appActionGates(installing, [op({ startedAt: 't', state: 'applying' })])).toEqual({ start: false, stop: true, restart: true, remove: true, purge: true, update: true });
  });
  it('keeps today’s gating for a free app', () => {
    expect(appActionGates(inst('installed'), [])).toEqual({ start: false, stop: true, restart: true, remove: true, purge: true, update: true });
    expect(appActionGates(inst('installed', { runtime: 'stopped', desired: 'stopped' }), [])).toEqual({ start: true, stop: false, restart: false, remove: true, purge: true, update: true });
    expect(appActionGates(inst('retained', { runtime: 'stopped' }), [])).toEqual({ start: false, stop: false, restart: false, remove: false, purge: true, update: false });
    expect(appActionGates(inst('failed'), [])).toEqual({ start: false, stop: true, restart: false, remove: true, purge: true, update: false });
  });
  it('after a waiting Remove only Uninstall completely makes sense; after an uninstall nothing does', () => {
    const removing = [op({ kind: 'remove' })];
    expect(appActionGates(inst('installed'), removing)).toEqual({ start: false, stop: false, restart: false, remove: false, purge: true, update: false });
    expect(appActionGates(inst('installed'), [op({ kind: 'purge' })])).toEqual({ start: false, stop: false, restart: false, remove: false, purge: false, update: false });
  });
});

describe('each action is offered from what the operations ahead leave behind (R8)', () => {
  const stopped = inst('installed', { runtime: 'stopped', desired: 'stopped' });
  const backup = op({ kind: 'backup', actor: 'scheduler', cancellable: false });
  it('a stopped app with a backup or a settings change ahead offers Start, never Restart', () => {
    expect(appActionGates(stopped, [backup])).toMatchObject({ start: true, restart: false });
    expect(appActionGates(stopped, [op({ kind: 'configure' })])).toMatchObject({ start: true, restart: false });
  });
  it('a running app its cold pass stopped for a moment still offers Restart (it comes back after the backup)', () => {
    expect(appActionGates(inst('installed', { runtime: 'stopped', desired: 'running' }), [op({ kind: 'backup', actor: 'scheduler', state: 'applying', startedAt: 't' })])).toMatchObject({ start: false, restart: true });
  });
  it('a waiting Stop turns Restart off and Start on; a Start ahead with no Stop after it turns Restart on', () => {
    expect(appActionGates(inst('installed'), [op({ kind: 'stop' })])).toMatchObject({ start: true, restart: false });
    expect(appActionGates(inst('installed'), [op({ kind: 'restart' }), op({ kind: 'stop' })])).toMatchObject({ start: true, restart: false });
    expect(appActionGates(stopped, [op({ kind: 'start' })])).toMatchObject({ start: false, restart: true });
    expect(appActionGates(stopped, [op({ kind: 'stop' }), op({ kind: 'start' })])).toMatchObject({ start: false, restart: true });
  });
  it('Update only for an installed or installing app, and never while an update is ahead (running or waiting)', () => {
    expect(appActionGates(inst('failed'), [backup]).update).toBe(false);
    expect(appActionGates(inst('needs_action'), [op({ kind: 'stop' })]).update).toBe(false);
    expect(appActionGates(inst('installed'), [op({ kind: 'update' })]).update).toBe(false);
    expect(appActionGates(inst('installed'), [op({ kind: 'update', state: 'applying', startedAt: 't' })]).update).toBe(false);
    expect(appActionGates(inst('installed'), [op({ kind: 'update', state: 'applying', startedAt: 't' }), op({ kind: 'stop' })]).update).toBe(false);
    expect(appActionGates(inst('installed'), [backup]).update).toBe(true);
  });
});

describe('the same action twice (C10, R6, R7)', () => {
  it('the app’s last item, of the same kind, queued by a person and still waiting, is a duplicate', () => {
    const waitingStop = op({ id: 'w', kind: 'stop', queuedAction: true });
    const active = [op({ id: 'r', kind: 'install', state: 'applying', startedAt: 't' }), waitingStop, op({ id: 'x', kind: 'stop', instanceId: 'other' })];
    expect(alreadyQueued(active, 'i1', 'stop')).toBe(waitingStop);
    expect(alreadyQueued(active, 'i1', 'restart')).toBeNull();
    expect(alreadyQueued(active, 'i1', 'install')).toBeNull(); // not the last item, and picked: it runs, it does not wait
    expect(alreadyQueued([op({ kind: 'stop', startedAt: 't' })], 'i1', 'stop')).toBeNull();
  });
  it('a Stop meant to run after a waiting Update is no duplicate of the Stop before it', () => {
    expect(alreadyQueued([op({ id: 's', kind: 'stop' }), op({ id: 'u', kind: 'update' })], 'i1', 'stop')).toBeNull();
  });
  it('an item Harbor queued itself never stands in for the operator’s own action', () => {
    expect(alreadyQueued([op({ kind: 'stop', actor: 'drive-guard', cancellable: false })], 'i1', 'stop')).toBeNull();
    expect(alreadyQueued([op({ kind: 'update', actor: 'auto-update' })], 'i1', 'update')).toBeNull();
    expect(alreadyQueued([op({ kind: 'start', actor: 'lock-guard', cancellable: false })], 'i1', 'start')).toBeNull();
  });
  it('a running Update is a duplicate of a second Update (that one would fail at its turn)', () => {
    const upd = op({ id: 'u', kind: 'update', state: 'applying', startedAt: 't', cancellable: false });
    expect(alreadyQueued([upd], 'i1', 'update')).toBe(upd);
    expect(alreadyQueued([op({ id: 'u2', kind: 'update', state: 'queued', startedAt: 't' })], 'i1', 'update')?.id).toBe('u2');
    expect(alreadyQueued([upd, op({ kind: 'stop' })], 'i1', 'update')).toBeNull(); // the update is not the last item
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

describe('what the tray keeps once an operation finishes (C12, C17, R9)', () => {
  const ok = op({ state: 'succeeded', actor: 'scheduler', kind: 'backup' });
  it('keeps a person’s operations (any outcome, any tab, after a reload), shown-once values and failures of any actor; drops background successes', () => {
    expect(keepFinished(ok)).toBe(false);
    expect(keepFinished(op({ state: 'cancelled', actor: 'auto-update' }))).toBe(false);
    expect(keepFinished(op({ state: 'succeeded', actor: 'drive-guard', kind: 'stop' }))).toBe(false);
    expect(keepFinished(op({ state: 'succeeded', actor: 'admin', kind: 'install' }))).toBe(true); // Update all, adopt, another tab, a reload
    expect(keepFinished(op({ state: 'cancelled', actor: 'admin' }))).toBe(true);
    expect(keepFinished(ok, true)).toBe(true); // accepted from this console: kept whatever the actor
    expect(keepFinished(op({ state: 'failed', actor: 'auto-update', error: { code: 'REVIEW_NEEDED', message: 'm', nextAction: 'n' } }))).toBe(true);
    expect(keepFinished(op({ state: 'needs_action', actor: 'drive-guard' }))).toBe(true);
    expect(keepFinished(op({ state: 'succeeded', actor: 'auto-update', result: { credentials: { username: 'a' } } }))).toBe(true);
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
