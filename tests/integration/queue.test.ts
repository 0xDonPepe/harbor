// Decision 183: the operation queue. Approvals for a free app wait their turn behind another app's operation;
// start/stop/restart/update/remove/reinstall/purge on a busy app are queued WITHOUT a plan and planned when their
// turn comes; a waiting item can be cancelled (never a running one, never one Harbor queued to protect something);
// a restart cancels what never ran and marks what was running needs_action (no replay either way).
import { createSocket } from 'node:dgram';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppBackupsDto, BackupTargetDto, InstanceSummary, OperationDto, OperationQueueDto, PackageImportResultDto } from '../../src/contracts/api.js';
import { FakeBackupEngine } from '../../src/backups/engine.js';
import { writeZip } from '../../src/packages/zip.js';
import { startHarness, type Harness } from './harness.js';

const engine = new FakeBackupEngine();
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ overrides: { backupEngine: engine } });
});
afterAll(async () => h.close());

const manifest = (id: string, rev: string, extra = '') => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: ${id.charAt(0).toUpperCase()}${id.slice(1)}
  description: A tiny web page
release:
  revision: "${rev}"
  version: "1.${rev}.0"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 60
ui:
  primaryEndpoint: web
storage:
  - id: data
    composeVolume: data
    purpose: Data
    retention: retain
${extra}`;
const compose = (image = 'nginx:1.27-alpine') => `services:\n  web:\n    image: ${image}\n    volumes:\n      - {type: volume, source: data, target: /data}\nvolumes:\n  data: {}\n`;
const upload = (id: string, rev: string, extra = '', image?: string, single = false) =>
  h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: `${id}-${rev}.zip`, dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': single ? manifest(id, rev, extra).replace('multiInstance: true', 'multiInstance: false') : manifest(id, rev, extra), 'compose.yaml': compose(image) }).toString('base64')}` });

// a UDP port nothing listens on
async function freeUdpPort(): Promise<number> {
  const s = createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '0.0.0.0', () => r()));
  const port = s.address().port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const key = () => `q-${Math.random().toString(36).slice(2, 14)}`;
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name) as InstanceSummary;
const op = (id: string) => h.api.expect<OperationDto>(200, 'GET', `/v1/operations/${id}`);
const queue = (recent?: number) => h.api.expect<OperationQueueDto>(200, 'GET', `/v1/operations${recent === undefined ? '' : `?recent=${recent}`}`);
const queueAction = (kind: string, instanceId: string, k = key()) => h.api.expect<{ operationId: string; created: boolean; operation: OperationDto }>(202, 'POST', '/v1/operations', { action: { kind, instanceId } }, { 'idempotency-key': k });
const cancel = (id: string) => h.api.json<OperationDto & { error?: { code: string; message: string } }>('POST', `/v1/operations/${id}/cancel`, {});
const generation = (id: string) => h.daemon.ctx.repo.instance(id)!.generation;
const hold = (how: 503 | 'hang' = 503) => {
  h.fake.behaviour.respond = () => how;
};
const release = () => {
  delete h.fake.behaviour.respond;
};
// the operation is running and waits in its readiness check (held there by hold())
async function waitChecking(id: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if ((await op(id)).phase === 'checking') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`operation ${id} never reached its readiness check`);
}
async function waitFor(fn: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}
// install and wait (the app free)
async function installed(id: string, name: string): Promise<InstanceSummary> {
  const r = await h.api.run({ kind: 'install', packageId: id, name });
  expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
  return byName(name);
}
// start an install and leave it running in its readiness check
async function heldInstall(id: string, name: string): Promise<string> {
  hold();
  const plan = await h.api.plan({ kind: 'install', packageId: id, name });
  const sub = await h.api.submit(plan.id);
  await waitChecking(sub.operationId);
  return sub.operationId;
}

describe('the operation queue (decision 183)', () => {
  it('setup: test apps', async () => {
    for (const id of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) await upload(id, '1');
  });

  it('a reviewed plan for a free app is accepted while another app works, waits its turn and runs after it', async () => {
    const first = await heldInstall('alpha', 'a1');
    const plan = await h.api.plan({ kind: 'install', packageId: 'beta', name: 'b1' });
    const second = await h.api.submit(plan.id);
    expect(second.operation).toMatchObject({ state: 'queued', startedAt: null, cancellable: true, queuedAction: false, instanceName: 'b1', actor: 'admin', planId: plan.id });
    const q = await queue();
    expect(q.active.map((o) => o.id)).toEqual([first, second.operationId]);
    expect(q.active[0]).toMatchObject({ state: 'verifying', cancellable: false, instanceName: 'a1', events: [] });
    expect(q.active[0]!.startedAt).not.toBeNull();
    release();
    const a = await h.api.waitOperation(first);
    const b = await h.api.waitOperation(second.operationId);
    expect([a.state, b.state]).toEqual(['succeeded', 'succeeded']);
    expect(b.startedAt! >= a.finishedAt!).toBe(true);
    // the finished ones are listed newest first; recent=1 keeps only the last
    const after = await queue();
    expect(after.active).toEqual([]);
    expect(after.recent.slice(0, 2).map((o) => o.id)).toEqual([second.operationId, first]);
    expect((await queue(1)).recent.map((o) => o.id)).toEqual([second.operationId]);
    expect((await queue(0)).recent).toEqual([]);
    await h.api.expectError(422, 'INVALID_REQUEST', 'GET', '/v1/operations?recent=51');
  });

  it('an action on a busy app is queued without a plan and planned at its turn against the app as it is then', async () => {
    const install = await heldInstall('alpha', 'a2');
    const inst = await byName('a2');
    expect(inst.installState).toBe('installing');
    // a reviewed plan for a busy app still waits for it (decision 173)
    await h.api.expectError(409, 'BUSY', 'POST', '/v1/plans', { kind: 'stop', instanceId: inst.id });
    // a Stop queued now would be refused as a plan (the app is still installing); it is planned only after the install
    const k = key();
    const q = await queueAction('stop', inst.id, k);
    expect(q.created).toBe(true);
    expect(q.operation).toMatchObject({ kind: 'stop', state: 'queued', planId: null, queuedAction: true, cancellable: true, instanceName: 'a2' });
    expect(q.operation.events.map((e) => e.message)).toContain('stop queued for a2; planned when its turn comes');
    // idempotent: the same key and action is the same item; the same key for something else is refused
    const again = await queueAction('stop', inst.id, k);
    expect([again.created, again.operationId]).toEqual([false, q.operationId]);
    await h.api.expectError(409, 'IDEMPOTENCY_CONFLICT', 'POST', '/v1/operations', { action: { kind: 'restart', instanceId: inst.id } }, { 'idempotency-key': k });
    // only the queueable kinds, and only existing apps
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/operations', { action: { kind: 'seal', instanceId: inst.id } }, { 'idempotency-key': key() });
    expect(() => h.daemon.service.queueAction(inst.id, 'seal', 'admin', key())).toThrow(/cannot be queued/);
    await h.api.expectError(404, 'NOT_FOUND', 'POST', '/v1/operations', { action: { kind: 'stop', instanceId: '00000000-0000-4000-8000-000000000000' } }, { 'idempotency-key': key() });
    // the app's active operation stays the running install, then moves to the waiting stop
    expect((await byName('a2')).operationId).toBe(install);
    release();
    expect((await h.api.waitOperation(install)).state).toBe('succeeded');
    const stopped = await h.api.waitOperation(q.operationId);
    expect(stopped.state, JSON.stringify(stopped.error)).toBe('succeeded');
    expect(stopped.planId).not.toBeNull();
    expect(stopped.queuedAction).toBe(false);
    expect(stopped.events.some((e) => e.message.startsWith('stop planned at its turn for a2'))).toBe(true);
    const after = await byName('a2');
    expect(after).toMatchObject({ desired: 'stopped', installState: 'installed', operationId: q.operationId });
    // the plan made at its turn is consumed: it is not left open
    expect(h.daemon.ctx.repo.openPlans(new Date().toISOString()).some((p) => p.id === stopped.planId)).toBe(false);
  });

  it('a queued action that needs something only a person can give stops as REVIEW_NEEDED and changes nothing', async () => {
    const secretApp = await installed('gamma', 'a3');
    await upload('gamma', '2', `secrets:\n  - id: api-token\n    source: operator\n    prompt: Access token of the service this app talks to\n    minLength: 8\n    retention: retain\n    bindings:\n      - {service: web, environment: API_TOKEN}\n`);
    const gen = generation(secretApp.id);
    const q = await queueAction('update', secretApp.id);
    const done = await h.api.waitOperation(q.operationId);
    expect(done.state).toBe('failed');
    expect(done.error?.code).toBe('REVIEW_NEEDED');
    expect(done.error?.message).toMatch(/^Update a3 needs your review: .*Access token/);
    expect(done.error?.nextAction).toBe('Open a3 and choose Update to review it.');
    const after = await byName('a3');
    expect(after).toMatchObject({ revision: '1', installState: 'installed', runtime: 'running' });
    expect(generation(secretApp.id)).toBe(gen);
    expect(h.daemon.ctx.repo.instance(secretApp.id)!.activeOperationId).toBeNull();

    // a new permission (decision 163) is never accepted by a queued item either
    const permApp = await installed('delta', 'b2');
    await upload('delta', '2', 'permissions:\n  web: [net-admin]\n');
    const p = await queueAction('update', permApp.id);
    const refused = await h.api.waitOperation(p.operationId);
    expect([refused.state, refused.error?.code]).toEqual(['failed', 'REVIEW_NEEDED']);
    expect(refused.error?.message).toMatch(/permissions you have not accepted: web net-admin/);
    expect((await byName('b2')).revision).toBe('1');
    // any other planning error fails the item with that error (Start of a running app)
    const s = await queueAction('start', permApp.id);
    const st = await h.api.waitOperation(s.operationId);
    expect([st.state, st.error?.code]).toEqual(['failed', 'INVALID_STATE']);
    expect(st.error?.message).toMatch(/already running/);
  });

  it('cancelling a waiting install frees its name and ports and cancels what waited for it', async () => {
    const running = await heldInstall('alpha', 'a4');
    const plan = await h.api.plan({ kind: 'install', packageId: 'beta', name: 'b3' });
    const waiting = await h.api.submit(plan.id);
    const inst = await byName('b3');
    expect(inst.installState).toBe('installing');
    const claimed = () => h.daemon.ctx.repo.claimedPorts().filter((c) => c.instanceId === inst.id);
    expect(claimed().length).toBeGreaterThan(0);
    const followUp = await queueAction('restart', inst.id);
    // a running item cannot be cancelled
    const r = await cancel(running);
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('NOT_CANCELLABLE');
    expect(r.body.error?.message).toMatch(/already running; a running step cannot be stopped safely/);
    // the waiting install can
    const c = await cancel(waiting.operationId);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ state: 'cancelled', cancellable: false, instanceName: 'b3', error: { code: 'CANCELLED', message: 'Cancelled by you before it started; nothing was changed.' } });
    const f = await op(followUp.operationId);
    expect([f.state, f.error?.code]).toEqual(['cancelled', 'CANCELLED']);
    expect(await byName('b3')).toBeUndefined();
    expect(claimed()).toEqual([]);
    // finished: not cancellable any more
    const twice = await cancel(waiting.operationId);
    expect([twice.status, twice.body.error?.code]).toEqual([409, 'NOT_CANCELLABLE']);
    expect(twice.body.error?.message).toMatch(/has finished/);
    // the name is free again
    const again = await h.api.plan({ kind: 'install', packageId: 'beta', name: 'b3' });
    expect(again.name).toBe('b3');
    release();
    expect((await h.api.waitOperation(running)).state).toBe('succeeded');
    expect((await queue()).active).toEqual([]);
  });

  it('operations Harbor queued to protect something are not cancellable', async () => {
    const guarded = await installed('beta', 'b4');
    const running = await heldInstall('alpha', 'a5');
    const plan = await h.daemon.service.createPlan({ kind: 'stop', instanceId: guarded.id }, 'drive-guard');
    const sub = h.daemon.service.submit(plan.id, key(), 'drive-guard');
    const dto = await op(sub.operation.id);
    expect(dto).toMatchObject({ state: 'queued', actor: 'drive-guard', cancellable: false });
    const r = await cancel(sub.operation.id);
    expect([r.status, r.body.error?.code]).toEqual([409, 'NOT_CANCELLABLE']);
    expect(r.body.error?.message).toMatch(/drive went away/);
    release();
    expect((await h.api.waitOperation(running)).state).toBe('succeeded');
    expect((await h.api.waitOperation(sub.operation.id)).state).toBe('succeeded');
  });

  it('Update all queues an update for a busy app instead of skipping it', async () => {
    await upload('beta', '2');
    const app = await byName('b4'); // stopped by the guard above (desired stays running)
    expect((await h.api.run({ kind: 'start', instanceId: app.id })).op.state).toBe('succeeded');
    // keep it busy with a restart held in its readiness check
    hold();
    const rs = await h.api.submit((await h.api.plan({ kind: 'restart', instanceId: app.id })).id);
    await waitChecking(rs.operationId);
    const all = await h.api.expect<{ started: { name: string; operationId: string }[]; skipped: { name: string; reason: string }[] }>(200, 'POST', '/v1/updates/apply-all', {});
    const mine = all.started.find((s) => s.name === 'b4');
    expect(mine, JSON.stringify(all)).toBeDefined();
    const queued = await op(mine!.operationId);
    expect(queued).toMatchObject({ kind: 'update', planId: null, queuedAction: true });
    // clicked twice: the update already waiting is not queued again
    const twice = await h.api.expect<{ skipped: { name: string; reason: string }[] }>(200, 'POST', '/v1/updates/apply-all', {});
    expect(twice.skipped.find((s) => s.name === 'b4')?.reason).toBe('an update is already queued');
    release();
    expect((await h.api.waitOperation(rs.operationId)).state).toBe('succeeded');
    const u = await h.api.waitOperation(mine!.operationId);
    expect(u.state, JSON.stringify(u.error)).toBe('succeeded');
    expect((await byName('b4')).revision).toBe('2');
  });

  it('a backup cold pass that waited is cancelled by a restart: its run fails, the app is untouched; the scheduler item itself is not cancellable', async () => {
    const target = (await h.api.expect<{ target: BackupTargetDto }>(200, 'POST', '/v1/backups/targets', { packageId: 'folder', name: 'USB backup', values: { path: '/mnt/backup/harbor' } })).target;
    const r = await h.api.run({ kind: 'install', packageId: 'epsilon', name: 'b5', location: { dir: path.join(h.userDataDir, 'harbor-apps', 'epsilon') } });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    const app = await byName('b5');
    await h.api.expect(200, 'PUT', `/v1/instances/${app.id}/backups`, { enabled: true, targets: [target.id] });
    const running = await heldInstall('alpha', 'a6');
    await h.api.expect(202, 'POST', `/v1/instances/${app.id}/backups/run`, {});
    let coldId = '';
    await waitFor(() => {
      coldId = h.daemon.ctx.repo.backupRuns({ instanceId: app.id, kind: 'backup', limit: 1 })[0]?.operationId ?? '';
      return coldId !== '';
    });
    const cold = await op(coldId);
    expect(cold).toMatchObject({ kind: 'backup', actor: 'scheduler', state: 'queued', cancellable: false });
    const refused = await cancel(coldId);
    expect([refused.status, refused.body.error?.code]).toEqual([409, 'NOT_CANCELLABLE']);
    const gen = generation(app.id);
    // the real path: Harbor restarts while the cold pass waits behind the other app's install
    await h.restart();
    release();
    expect(await op(coldId)).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED', message: 'Harbor restarted before this ran; nothing was changed.' } });
    expect((await op(running)).state).toBe('needs_action');
    const runs = (await h.api.expect<AppBackupsDto>(200, 'GET', `/v1/instances/${app.id}/backups`)).runs;
    expect(runs[0]).toMatchObject({ kind: 'backup', state: 'failed' });
    expect(runs[0]!.message).toMatch(/the daemon restarted while this run was in flight/);
    expect(await byName('b5')).toMatchObject({ desired: 'running', installState: 'installed' });
    expect(generation(app.id)).toBe(gen);
    expect(h.daemon.ctx.repo.instance(app.id)!.activeOperationId).toBeNull();
    expect((await queue()).active).toEqual([]);
  });

  it('a restart cancels what never ran (the app untouched, a waiting install freed) and marks what ran needs_action', async () => {
    const untouched = await byName('a1');
    const gen = generation(untouched.id);
    hold('hang');
    const plan = await h.api.plan({ kind: 'install', packageId: 'alpha', name: 'a7' });
    const picked = await h.api.submit(plan.id);
    await waitChecking(picked.operationId);
    const neverRan = await queueAction('stop', untouched.id);
    const waitingInstall = await h.api.submit((await h.api.plan({ kind: 'install', packageId: 'beta', name: 'b6' })).id);
    await h.restart();
    release();
    const p = await op(picked.operationId);
    expect(p.state).toBe('needs_action');
    const n = await op(neverRan.operationId);
    expect(n).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED', message: 'Harbor restarted before this ran; nothing was changed.', nextAction: 'Queue it again.' } });
    expect(await byName('a1')).toMatchObject({ installState: 'installed', desired: 'running' });
    expect(generation(untouched.id)).toBe(gen);
    expect(h.daemon.ctx.repo.instance(untouched.id)!.activeOperationId).toBeNull();
    expect((await op(waitingInstall.operationId)).state).toBe('cancelled');
    expect(await byName('b6')).toBeUndefined();
    expect((await queue()).active).toEqual([]);
  });

  it('the same action queued again while one already waits is that waiting item, not a duplicate that fails at its turn', async () => {
    const app = await installed('beta', 'b7');
    const running = await heldInstall('alpha', 'a8');
    const first = await queueAction('restart', app.id);
    const again = await queueAction('restart', app.id);
    expect([again.created, again.operationId]).toEqual([false, first.operationId]);
    // another kind still joins the queue, and then a restart behind it is a new item again
    const stop = await queueAction('stop', app.id);
    expect(stop.created).toBe(true);
    expect((await queue()).active.filter((o) => o.instanceId === app.id).map((o) => o.id)).toEqual([first.operationId, stop.operationId]);
    release();
    expect((await h.api.waitOperation(running)).state).toBe('succeeded');
    expect((await h.api.waitOperation(first.operationId)).state).toBe('succeeded');
    expect((await h.api.waitOperation(stop.operationId)).state).toBe('succeeded');
  });

  it('a reviewed plan whose app changed after it was accepted is refused at its turn and changes nothing', async () => {
    const app = await installed('beta', 'b8');
    const running = await heldInstall('alpha', 'a9');
    const sub = await h.api.submit((await h.api.plan({ kind: 'restart', instanceId: app.id })).id);
    // something ran for the app between accept and turn (what a reordered queue would do)
    h.daemon.ctx.repo.bumpGeneration(app.id);
    const gen = generation(app.id);
    release();
    expect((await h.api.waitOperation(running)).state).toBe('succeeded');
    const done = await h.api.waitOperation(sub.operationId);
    expect([done.state, done.error?.code]).toEqual(['failed', 'STATE_CHANGED']);
    expect(done.error?.message).toMatch(/changed since this plan was reviewed; nothing was changed/);
    expect(done.events.some((e) => e.phase === 'restarting' || e.phase === 'stopping')).toBe(false);
    expect(generation(app.id)).toBe(gen);
    expect(await byName('b8')).toMatchObject({ installState: 'installed', runtime: 'running', desired: 'running' });
    expect(h.daemon.ctx.repo.instance(app.id)!.activeOperationId).toBeNull();
  });

  it('a shutdown while a queued action is being planned cancels it: nothing ran, the app stays as it was', async () => {
    const app = await installed('beta', 'b9');
    const gen = generation(app.id);
    const svc = h.daemon.service;
    const plan = svc.planQueuedAction.bind(svc);
    let stopped: Promise<void> | null = null;
    svc.planQueuedAction = async (o) => {
      stopped = h.daemon.runner.shutdown(); // self-update / systemctl stop while createPlan awaits
      return plan(o);
    };
    const q = await queueAction('restart', app.id);
    await waitFor(() => stopped !== null);
    await stopped;
    const row = h.daemon.ctx.repo.operation(q.operationId)!;
    expect(row).toMatchObject({ state: 'cancelled', errorCode: 'CANCELLED', errorMessage: 'Harbor stopped before this ran; nothing was changed.' });
    expect(row.planId).not.toBeNull(); // it was planned and accepted, then let go before its first step
    expect(h.daemon.ctx.repo.instance(app.id)!.activeOperationId).toBeNull();
    await h.restart();
    expect((await op(q.operationId)).state).toBe('cancelled');
    expect(await byName('b9')).toMatchObject({ installState: 'installed', desired: 'running' });
    expect(generation(app.id)).toBe(gen);
  });

  it('a restart after the runner picked an item but before its first step treats it as never run', async () => {
    const app = await byName('b9');
    const gen = generation(app.id);
    const other = await heldInstall('alpha', 'a10');
    const q = await queueAction('stop', app.id);
    // what a crash right after the runner picked it (while planning it) leaves: started, still queued
    expect(h.daemon.ctx.repo.claimHead()!.id).toBe(q.operationId);
    await h.restart();
    release();
    expect(await op(q.operationId)).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED', message: 'Harbor restarted before this ran; nothing was changed.' } });
    expect(await byName('b9')).toMatchObject({ installState: 'installed', desired: 'running' });
    expect(generation(app.id)).toBe(gen);
    expect((await op(other)).state).toBe('needs_action'); // it had reached its readiness check
  });

  it('a waiting reviewed update gives back the fixed port it claimed when a restart (or a person) cancels it', async () => {
    const port = await freeUdpPort();
    await upload('zeta', '1', '', undefined, true);
    const app = await installed('zeta', 'z1');
    await upload('zeta', '2', `ports:\n  tunnel:\n    service: web\n    containerPort: 51820\n    hostPort: ${port}\n    protocol: udp\n    purpose: VPN tunnels\n`, undefined, true);
    const claim = () => h.daemon.ctx.repo.claimedPorts().filter((c) => c.port === port);
    const waitingUpdate = async () => {
      const plan = await h.api.plan({ kind: 'update', instanceId: app.id });
      expect(plan.ports.map((p) => p.hostPort)).toEqual([port]);
      const sub = await h.api.expect<{ operationId: string }>(202, 'POST', '/v1/operations', { planId: plan.id, acceptPermissions: true }, { 'idempotency-key': key() });
      expect((await op(sub.operationId)).state).toBe('queued');
      expect(claim().map((c) => c.instanceId)).toEqual([app.id]);
      return sub.operationId;
    };
    const first = await heldInstall('alpha', 'a11');
    const u = await waitingUpdate();
    await h.restart();
    release();
    expect((await op(u)).state).toBe('cancelled');
    expect((await op(first)).state).toBe('needs_action');
    expect(claim()).toEqual([]);
    expect((await byName('z1')).revision).toBe('1');
    // the same through a person's cancel
    const second = await heldInstall('alpha', 'a12');
    const u2 = await waitingUpdate();
    expect((await cancel(u2)).status).toBe(200);
    expect(claim()).toEqual([]);
    release();
    expect((await h.api.waitOperation(second)).state).toBe('succeeded');
    expect((await byName('z1')).revision).toBe('1');
  });

  // The dedupe rule (decision 183 review R1/R3/R7): a queued action is the existing item X only when X is the app's
  // last not-final item, of the same kind, not Harbor's own (an internal actor), and still waiting; an update that
  // already runs counts too.
  it("a person's stop never merges into a waiting drive-guard stop: it is its own item and desired ends stopped", async () => {
    await upload('eta', '1');
    const app = await installed('eta', 'd1');
    const running = await heldInstall('alpha', 'a13');
    const guard = h.daemon.service.submit((await h.daemon.service.createPlan({ kind: 'stop', instanceId: app.id }, 'drive-guard')).id, key(), 'drive-guard');
    expect(guard.operation).toMatchObject({ state: 'queued', actor: 'drive-guard' });
    const mine = await queueAction('stop', app.id);
    expect(mine.created).toBe(true);
    expect(mine.operationId).not.toBe(guard.operation.id);
    expect(mine.operation).toMatchObject({ actor: 'admin', cancellable: true });
    expect((await queue()).active.filter((o) => o.instanceId === app.id).map((o) => o.id)).toEqual([guard.operation.id, mine.operationId]);
    release();
    expect((await h.api.waitOperation(running)).state).toBe('succeeded');
    expect((await h.api.waitOperation(guard.operation.id)).state).toBe('succeeded');
    const stopped = await h.api.waitOperation(mine.operationId);
    expect(stopped.state, JSON.stringify(stopped.error)).toBe('succeeded');
    expect(await byName('d1')).toMatchObject({ desired: 'stopped' });
  });

  it('a stop queued behind [stop, start] is a third item: the last request wins', async () => {
    await upload('theta', '1');
    const app = await installed('theta', 'd2');
    const running = await heldInstall('alpha', 'a14');
    const stop1 = await queueAction('stop', app.id);
    const start = await queueAction('start', app.id);    const stop2 = await queueAction('stop', app.id);
    expect([stop1.created, start.created, stop2.created]).toEqual([true, true, true]);
    expect((await queue()).active.filter((o) => o.instanceId === app.id).map((o) => o.id)).toEqual([stop1.operationId, start.operationId, stop2.operationId]);
    // and a stop right behind the last stop is that stop
    const again = await queueAction('stop', app.id);
    expect([again.created, again.operationId]).toEqual([false, stop2.operationId]);
    release();
    expect((await h.api.waitOperation(running)).state).toBe('succeeded');
    for (const id of [stop1.operationId, start.operationId, stop2.operationId]) expect((await h.api.waitOperation(id)).state).toBe('succeeded');
    expect(await byName('d2')).toMatchObject({ desired: 'stopped' });
  });

  it('an update queued while the same app is already updating is that running update; a retry with the same key stays it', async () => {
    const app = await installed('epsilon', 'e1');
    await upload('epsilon', '2');
    hold();
    const update = await h.api.submit((await h.api.plan({ kind: 'update', instanceId: app.id })).id);
    await waitChecking(update.operationId);
    const k = key();
    const q = await queueAction('update', app.id, k);
    expect([q.created, q.operationId]).toEqual([false, update.operationId]);
    // a stop is not deduped against a running item: it waits behind the update
    const stop = await queueAction('stop', app.id);
    expect(stop.created).toBe(true);
    release();
    expect((await h.api.waitOperation(update.operationId)).state).toBe('succeeded');
    expect((await h.api.waitOperation(stop.operationId)).state).toBe('succeeded');
    // the reply was lost and the console retries with the same key after the update finished: still that operation
    const retry = await queueAction('update', app.id, k);
    expect([retry.created, retry.operationId]).toEqual([false, update.operationId]);
    // the same key for something else is refused
    await h.api.expectError(409, 'IDEMPOTENCY_CONFLICT', 'POST', '/v1/operations', { action: { kind: 'restart', instanceId: app.id } }, { 'idempotency-key': k });
    expect((await byName('e1')).revision).toBe('2');
  });
});
