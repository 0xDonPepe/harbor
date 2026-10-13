import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { DIGEST_A, MINIMAL_MANIFEST, writePackage } from '../unit/helpers.js';
import type { ExposureDto, InstanceSummary, NotificationsDto, TailnetAllDto } from '../../src/contracts/api.js';
import { TAILNET_ALL_SETTING, TAILNET_POLICY_ACTOR } from '../../src/lifecycle/tailnet-all.js';

// Decision 174: "Give every app a Tailscale address" — an opt-in policy the observer carries out through ordinary
// expose plans (actor tailnet-policy), one at a time, once per app and daemon start.
let h: Harness;
const ids: Record<string, string> = {};
beforeAll(async () => {
  h = await startHarness();
  writePackage(h.catalogDir, 'demo', { manifest: MINIMAL_MANIFEST, compose: `services:\n  web:\n    image: example/demo@${DIGEST_A}\n`, images: { web: `example/demo@${DIGEST_A}` } });
});
afterAll(async () => {
  await h.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const policy = () => h.api.expect<TailnetAllDto>(200, 'GET', '/v1/exposures/tailnet-all');
const tailnetOf = async () => (await h.api.expect<{ items: ExposureDto[] }>(200, 'GET', '/v1/exposures')).items.filter((e) => e.via === 'tailnet');
const policyOps = (instanceId?: string) => h.daemon.ctx.repo.listOperations(500).filter((o) => o.actor === TAILNET_POLICY_ACTOR && (!instanceId || o.instanceId === instanceId));
const appState = (p: TailnetAllDto, name: string) => p.apps.find((a) => a.name === name);
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const healthy = (name: string) => until(`${name} healthy`, async () => (await h.api.instances()).find((i: InstanceSummary) => i.name === name && i.readiness === 'healthy'));

describe('every app gets a Tailscale address (decision 174)', () => {
  it('installs five apps; removes one (kept for Reinstall)', async () => {
    for (const name of ['alpha', 'beta', 'gamma', 'delta', 'omega']) {
      const r = await h.api.run({ kind: 'install', packageId: 'demo', name });
      expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
      ids[name] = r.op.instanceId;
      // with the policy off the install plan says nothing about the tailnet
      expect(r.plan.notes.join(' ')).not.toMatch(/tailnet/);
    }
    expect((await h.api.run({ kind: 'remove', instanceId: ids['omega'] })).op.state).toBe('succeeded');
    const p = await policy();
    expect(p).toMatchObject({ enabled: false, status: 'off', except: [] });
    expect(p.apps.map((a) => a.name).sort()).toEqual(['alpha', 'beta', 'delta', 'gamma']); // a removed app is not listed
  });

  it('turning it on is refused while Tailscale has no HTTPS certificates; nothing changes', async () => {
    h.tailscale.statusValue = { ...h.tailscale.statusValue!, httpsEnabled: false };
    const err = await h.api.expectError(422, 'UNSUPPORTED_CAPABILITY', 'PUT', '/v1/exposures/tailnet-all', { enabled: true });
    expect(err.error.message).toMatch(/HTTPS certificates are off/);
    expect(err.error.nextAction).toMatch(/Enable HTTPS/);
    expect((await policy()).enabled).toBe(false);
  });

  it('on while Tailscale is not ready (it went away after): status waiting, nothing planned', async () => {
    h.daemon.ctx.repo.setSetting(TAILNET_ALL_SETTING, { enabled: true, except: [] });
    await sleep(1_500); // three observer ticks
    const p = await policy();
    expect(p).toMatchObject({ enabled: true, status: 'waiting', reason: expect.stringMatching(/HTTPS certificates are off/) });
    expect(policyOps()).toEqual([]);
    expect(await tailnetOf()).toEqual([]);
  });

  it('excluded, stopped and needs_action apps are left alone; the eligible app gets exactly one address via the policy', async () => {
    await h.api.expect(200, 'PUT', `/v1/instances/${ids['gamma']}/tailnet-all`, { included: false });
    expect((await h.api.run({ kind: 'stop', instanceId: ids['beta'] })).op.state).toBe('succeeded');
    h.daemon.ctx.repo.updateInstance(ids['delta']!, { installState: 'needs_action' });
    h.tailscale.statusValue = { ...h.tailscale.statusValue!, httpsEnabled: true };
    await until('alpha on the tailnet', async () => (await tailnetOf()).find((e) => e.instanceId === ids['alpha'] && e.state === 'active'));
    await sleep(1_500);
    const tn = await tailnetOf();
    expect(tn.map((e) => e.instanceName)).toEqual(['alpha']);
    expect(tn[0]).toMatchObject({ isPrimary: false, url: expect.stringMatching(/^https:\/\/harbor-test\.tail1234\.ts\.net:\d+\/$/) });
    const ops = policyOps();
    expect(ops.map((o) => [o.instanceId, o.kind, o.state])).toEqual([[ids['alpha'], 'expose', 'succeeded']]);
    const p = await policy();
    expect(p.status).toBe('on');
    expect(appState(p, 'alpha')).toMatchObject({ state: 'published', url: tn[0]!.url });
    expect(appState(p, 'beta')).toMatchObject({ state: 'waiting', note: expect.stringMatching(/stopped/) });
    expect(appState(p, 'gamma')?.state).toBe('excluded');
    expect(appState(p, 'delta')).toMatchObject({ state: 'waiting', note: expect.stringMatching(/needs action/) });
    expect(p.except).toEqual([ids['gamma']]);
    // the main address did not move
    expect((await h.api.instances()).find((i) => i.id === ids['alpha'])!.endpoints[0]!.primary).toBe('loopback');
  });

  it('waits its turn: nothing is planned while any operation runs, then the started app gets its address', async () => {
    const fakeOp = '0b0b0b0b-0000-4000-8000-000000000174';
    h.daemon.ctx.repo.updateInstance(ids['alpha']!, { activeOperationId: fakeOp }); // another app is busy
    expect((await h.api.run({ kind: 'start', instanceId: ids['beta'] })).op.state).toBe('succeeded');
    await healthy('beta');
    await sleep(1_500);
    expect(policyOps(ids['beta'])).toEqual([]);
    h.daemon.ctx.repo.updateInstance(ids['alpha']!, { activeOperationId: null });
    await until('beta on the tailnet', async () => (await tailnetOf()).find((e) => e.instanceId === ids['beta']));
    expect(policyOps(ids['beta'])).toHaveLength(1);
  });

  it('a new install says it gets an address after it starts', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'demo', name: 'probe' });
    expect(plan.notes.join(' ')).toMatch(/also gets an address on your tailnet once it runs/);
  });

  it('withdrawing an address by hand keeps that app off: it joins the exceptions and is not published again', async () => {
    const plan = await h.api.plan({ kind: 'unexpose', instanceId: ids['alpha'], via: 'tailnet' });
    expect(plan.notes.join(' ')).toMatch(/keeps it off the tailnet/);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state).toBe('succeeded');
    expect((await policy()).except.sort()).toEqual([ids['alpha'], ids['gamma']].sort());
    await sleep(1_500);
    expect((await tailnetOf()).map((e) => e.instanceName)).toEqual(['beta']);
    expect(appState(await policy(), 'alpha')?.state).toBe('excluded');
    expect(policyOps(ids['alpha'])).toHaveLength(1); // the original publish only
  });

  it('switching an app back on lets the policy publish it at its next check', async () => {
    const p = await h.api.expect<TailnetAllDto>(200, 'PUT', `/v1/instances/${ids['gamma']}/tailnet-all`, { included: true });
    expect(p.except).toEqual([ids['alpha']]);
    await until('gamma on the tailnet', async () => (await tailnetOf()).find((e) => e.instanceId === ids['gamma']));
  });

  it('turning it off withdraws nothing', async () => {
    const before = (await tailnetOf()).map((e) => e.instanceName).sort();
    expect(before).toEqual(['beta', 'gamma']);
    const p = await h.api.expect<TailnetAllDto>(200, 'PUT', '/v1/exposures/tailnet-all', { enabled: false });
    expect(p).toMatchObject({ enabled: false, status: 'off' });
    await sleep(1_200);
    expect((await tailnetOf()).map((e) => e.instanceName).sort()).toEqual(before);
    expect(h.daemon.ctx.repo.listOperations(500).filter((o) => o.kind === 'unexpose' && o.actor === TAILNET_POLICY_ACTOR)).toEqual([]);
  });

  it('a failing publish is tried once per start, reported once per app (no generic operation-failed row), and again after a restart', async () => {
    h.daemon.ctx.repo.updateInstance(ids['delta']!, { installState: 'installed' });
    await healthy('delta');
    h.tailscale.statusValue = { ...h.tailscale.statusValue!, online: false }; // Running with HTTPS, but serve fails
    await h.api.expect(200, 'PUT', '/v1/exposures/tailnet-all', { enabled: true });
    const failed = await until('delta failed', async () => appState(await policy(), 'delta')?.state === 'failed' && (await policy()));
    expect(appState(failed, 'delta')!.note).toMatch(/tailscale serve failed/);
    await sleep(1_500);
    expect(policyOps(ids['delta'])).toHaveLength(1);
    expect((await tailnetOf()).some((e) => e.instanceId === ids['delta'])).toBe(false); // no half-made record
    const notes = (await h.api.expect<NotificationsDto>(200, 'GET', '/v1/notifications')).items;
    expect(notes.filter((n) => n.kind === 'tailnet-all-failed' && n.instanceId === ids['delta'])).toHaveLength(1);
    expect(notes.some((n) => n.kind === 'operation-failed' && n.instanceId === ids['delta'])).toBe(false);
    expect(notes.find((n) => n.kind === 'tailnet-all-failed')!.link).toBe('#/settings/remote');
    h.tailscale.statusValue = { ...h.tailscale.statusValue!, online: true };
    await h.restart();
    await until('delta on the tailnet after a restart', async () => (await tailnetOf()).find((e) => e.instanceId === ids['delta']));
    expect(policyOps(ids['delta'])).toHaveLength(2);
    await until('failure row resolved', async () => !(await h.api.expect<NotificationsDto>(200, 'GET', '/v1/notifications')).items.some((n) => n.kind === 'tailnet-all-failed'));
  });

  it('a purged app leaves the exceptions', async () => {
    expect((await policy()).except).toEqual([ids['alpha']]);
    expect((await h.api.run({ kind: 'purge', instanceId: ids['alpha'] })).op.state).toBe('succeeded');
    expect((await policy()).except).toEqual([]);
  });
});
