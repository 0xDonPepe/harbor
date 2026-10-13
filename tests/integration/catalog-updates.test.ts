import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json as fakeJson } from '../../src/appearance/fetcher.js';
import type { CatalogItemDto, CatalogStatusDto, InstanceSummary, NotificationsDto, OperationDto } from '../../src/contracts/api.js';
import { buildBundle, bumpRevision, catalogFiles, TEST_KEYS, TEST_SIGNER, type TestBundle } from '../unit/bundle-helpers.js';
import { signDetached } from '../../src/signing.js';
import { REPO_CATALOG, startHarness, type Harness } from './harness.js';

// Decision 158: the daemon swaps in a newer catalog from the catalog repository's releases.
// The "server" is the harness's fake fetcher, shaped like GitHub releases (decision 168: releases/latest
// redirects to tag c<serial>, files come from releases/download/c<serial>/, catalog.json.sig signed by a
// throwaway key the daemon is given instead of the pinned ones). The config still lists a (deprecated, ignored)
// publicKeys entry, like a hand-edited config from before 0.28.0: the daemon starts and ignores it.

const RELEASES = 'https://catalog.example.test/releases';
const URL_BASE = `${RELEASES}/latest/download`;
// the bundle releases/latest names; `sig: null` publishes it without catalog.json.sig
let bundle: TestBundle | null = null;
let sigOverride: Buffer | null | undefined;
let h: Harness;

beforeAll(async () => {
  h = await startHarness({ config: { catalog: { url: URL_BASE, publicKeys: ['FIXTURE-IGNORED-KEY'] } }, overrides: { releaseKeys: TEST_KEYS } });
  const bin = (b: Buffer | string) => ({ status: 200, contentType: 'application/octet-stream', body: Buffer.from(b) });
  h.fetcher.on(`${RELEASES}/latest`, () => ({ status: 302, contentType: 'text/html', body: Buffer.from(''), location: bundle ? `${RELEASES}/tag/c${bundle.serial}` : RELEASES }));
  h.fetcher.on(`${RELEASES}/download/`, (url) => {
    if (!bundle || !url.includes(`/download/c${bundle.serial}/`)) return fakeJson({}, 404);
    if (url.endsWith('/catalog.json')) return bin(bundle.meta);
    if (url.endsWith('/catalog.zip')) return bin(bundle.zip);
    if (url.endsWith('/catalog.json.sig')) return sigOverride === null ? fakeJson({}, 404) : bin(sigOverride ?? bundle.sig);
    return fakeJson({}, 404);
  });
});
afterAll(async () => h.close());

const status = () => h.api.expect<CatalogStatusDto>(200, 'GET', '/v1/catalog/status');
const refresh = () => h.api.expect<CatalogStatusDto>(200, 'POST', '/v1/catalog/refresh', {});
const catalogItem = async (id: string) => (await h.api.expect<{ items: CatalogItemDto[] }>(200, 'GET', '/v1/catalog')).items.find((i) => i.id === id);
const waitFor = async (fn: () => Promise<boolean>, ms = 15_000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe('official catalog updates (decision 158)', () => {
  let manual: InstanceSummary;
  let auto: InstanceSummary;

  it('reports the bundled seed and refuses unauthenticated calls', async () => {
    expect(await status()).toMatchObject({ source: URL_BASE, serial: 0, origin: 'bundled', commit: null, checkedAt: null, error: null });
    const anon = await h.api.raw('GET', '/v1/catalog/status', undefined, { authorization: '' });
    expect(anon.status).toBe(401);
    const anonRefresh = await h.api.raw('POST', '/v1/catalog/refresh', {}, { authorization: '' });
    expect(anonRefresh.status).toBe(401);
  });

  it('a check with nothing published reports the error and keeps the seed', async () => {
    const s = await refresh();
    expect(s).toMatchObject({ origin: 'bundled', serial: 0, error: `could not resolve the latest catalog release from ${RELEASES}/latest (Location: "${RELEASES}")` });
    expect(s.checkedAt).not.toBeNull();
  });

  it('installed apps get an update from a newer catalog, without a restart', async () => {
    expect((await h.api.run({ kind: 'install', packageId: 'excalidraw' })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'install', packageId: 'excalidraw' })).op.state).toBe('succeeded');
    const mine = (await h.api.instances()).filter((i) => i.packageId === 'excalidraw').sort((a, b) => a.name.localeCompare(b.name));
    [manual, auto] = [mine[0]!, mine[1]!];
    await h.api.expect(200, 'PUT', `/v1/instances/${auto.id}/auto-update`, { enabled: true });
    expect(manual.revision).toBe('1');

    bundle = buildBundle(bumpRevision(catalogFiles(REPO_CATALOG), 'excalidraw', '2'), { serial: 1_760_000_000, commit: '0123456789abcdef0123456789abcdef01234567' });
    const s = await refresh();
    expect(s).toMatchObject({ source: URL_BASE, serial: 1_760_000_000, origin: 'downloaded', commit: '0123456789abcdef0123456789abcdef01234567', error: null });
    expect(existsSync(path.join(h.stateDir, 'catalog', '1760000000', 'index.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(h.stateDir, 'catalog', 'current.json'), 'utf8'))).toEqual({ serial: 1_760_000_000 });
    expect(await catalogItem('excalidraw')).toMatchObject({ revision: '2', origin: 'bundled', availability: 'available' });

    // the observer's next tick: an update-available notification for the manual app
    await waitFor(async () => {
      const n = await h.api.expect<NotificationsDto>(200, 'GET', '/v1/notifications');
      return n.items.some((x) => x.kind === 'update-available' && x.instanceId === manual.id);
    });
    expect((await h.api.instances()).find((i) => i.id === manual.id)?.updateAvailable?.revision).toBe('2');

    // existing behaviour, unchanged: an app with automatic updates on follows the official catalog too
    await waitFor(async () => (await h.api.instances()).find((i) => i.id === auto.id)?.revision === '2');

    // the manual update installs from the downloaded catalog
    const { op } = await h.api.run({ kind: 'update', instanceId: manual.id });
    expect(op.state).toBe('succeeded');
    expect((await h.api.instances()).find((i) => i.id === manual.id)?.revision).toBe('2');
  });

  it('a replayed or older bundle is a no-op; the downloaded catalog survives a restart', async () => {
    expect(await refresh()).toMatchObject({ serial: 1_760_000_000, origin: 'downloaded', error: null });
    bundle = buildBundle(bumpRevision(catalogFiles(REPO_CATALOG), 'excalidraw', '9'), { serial: 1_700_000_000 });
    expect(await refresh()).toMatchObject({ serial: 1_760_000_000, error: null });
    expect((await catalogItem('excalidraw'))?.revision).toBe('2');
    await h.restart();
    expect(await status()).toMatchObject({ serial: 1_760_000_000, origin: 'downloaded', checkedAt: null });
    expect((await catalogItem('excalidraw'))?.revision).toBe('2');
  });

  it('an archive that does not match its catalog.json is refused and changes nothing', async () => {
    const good = buildBundle(bumpRevision(catalogFiles(REPO_CATALOG), 'excalidraw', '3'), { serial: 1_780_000_000 });
    const zip = Buffer.from(good.zip);
    zip[zip.length - 30] = zip[zip.length - 30]! ^ 0xff;
    bundle = { ...good, zip };
    expect(await refresh()).toMatchObject({ serial: 1_760_000_000, error: 'the app catalog archive does not match its catalog.json checksum' });
    expect((await catalogItem('excalidraw'))?.revision).toBe('2');
    expect(existsSync(path.join(h.stateDir, 'catalog', '1780000000'))).toBe(false);
  });

  it('decision 168: an unsigned or badly signed catalog is refused with a clear status and changes nothing', async () => {
    bundle = buildBundle(bumpRevision(catalogFiles(REPO_CATALOG), 'excalidraw', '3'), { serial: 1_780_000_000 });
    sigOverride = null;
    const seen = h.fetcher.requests.length;
    expect(await refresh()).toMatchObject({ serial: 1_760_000_000, origin: 'downloaded', error: 'refusing the app catalog c1780000000: its catalog.json is not signed (no catalog.json.sig); Harbor keeps the catalog it has' });
    sigOverride = Buffer.from(signDetached(Buffer.from('another catalog.json'), TEST_SIGNER.privatePem));
    const s = await refresh();
    expect(s.error).toMatch(/^refusing the app catalog c1780000000: its catalog\.json does not match its catalog\.json\.sig/);
    expect(await status()).toMatchObject({ serial: 1_760_000_000, error: s.error });
    expect((await catalogItem('excalidraw'))?.revision).toBe('2');
    expect(existsSync(path.join(h.stateDir, 'catalog', '1780000000'))).toBe(false);
    expect(h.fetcher.requests.slice(seen).filter((r) => r.url.endsWith('/catalog.zip'))).toEqual([]);
    sigOverride = undefined;
  });

  it('a plan the catalog moved past fails PLAN_STALE and leaves the app as it was (no needs_action)', async () => {
    const offerRevision = async (revision: string, serial: number) => {
      bundle = buildBundle(bumpRevision(catalogFiles(REPO_CATALOG), 'excalidraw', revision), { serial });
      expect(await refresh()).toMatchObject({ serial, error: null });
    };
    const failed = async (planId: string): Promise<OperationDto> => h.api.waitOperation((await h.api.submit(planId)).operationId);

    // update: planned for revision 3, approved after the catalog moved to 4
    await offerRevision('3', 1_770_000_000);
    const before = (await h.api.instances()).find((i) => i.id === manual.id)!;
    expect(before).toMatchObject({ revision: '2', installState: 'installed', runtime: 'running', readiness: 'healthy' });
    const upd = await h.api.plan({ kind: 'update', instanceId: manual.id });
    expect(upd.update?.toRevision).toBe('3');
    await offerRevision('4', 1_771_000_000);
    const op = await failed(upd.id);
    expect(op.state).toBe('failed');
    expect(op.error).toMatchObject({ code: 'PLAN_STALE', nextAction: 'The app catalog changed since this plan was made. Review the plan again.' });
    expect(op.error?.message).toMatch(/^the app catalog changed since this plan was made \(excalidraw: bundled revision 4 differs from expected 3\)$/);
    expect((await h.api.instances()).find((i) => i.id === manual.id)).toMatchObject({ revision: '2', installState: 'installed', runtime: 'running', readiness: 'healthy' });
    const n = await h.api.expect<NotificationsDto>(200, 'GET', '/v1/notifications');
    expect(n.items.filter((x) => x.kind === 'operation-failed' && x.instanceId === manual.id)).toEqual([]);
    // the next plan is for the new revision and works
    const again = await h.api.plan({ kind: 'update', instanceId: manual.id });
    expect(again.update?.toRevision).toBe('4');

    // install: planned for revision 4, approved after the catalog moved to 5; nothing is left behind
    const inst = await h.api.plan({ kind: 'install', packageId: 'excalidraw' });
    await offerRevision('5', 1_772_000_000);
    const iop = await failed(inst.id);
    expect(iop.state).toBe('failed');
    expect(iop.error?.code).toBe('PLAN_STALE');
    expect((await h.api.instances()).some((i) => i.id === inst.instanceId || i.name === inst.name)).toBe(false);
    expect(h.daemon.ctx.repo.claimedPorts().some((c) => c.instanceId === inst.instanceId)).toBe(false);
    const replanned = await h.api.plan({ kind: 'install', packageId: 'excalidraw' });
    expect(replanned).toMatchObject({ name: inst.name, revision: '5' });
    expect(replanned.endpoints.map((e) => e.hostPort)).toEqual(inst.endpoints.map((e) => e.hostPort));
    expect((await h.api.expect<NotificationsDto>(200, 'GET', '/v1/notifications')).items.filter((x) => x.kind === 'operation-failed' && x.instanceId === inst.instanceId)).toEqual([]);
  });

  it('a package that needs a newer Harbor lists as unavailable; installed copies keep their icon', async () => {
    bundle = buildBundle(bumpRevision(catalogFiles(REPO_CATALOG), 'excalidraw', '6', { minHarbor: '99.0.0' }), { serial: 1_780_000_000 });
    expect(await refresh()).toMatchObject({ serial: 1_780_000_000, error: null });
    expect(await catalogItem('excalidraw')).toMatchObject({ availability: 'unavailable', reason: 'needs Harbor 99.0.0 or newer', name: 'Excalidraw' });
    // no update is offered for a revision this Harbor cannot run
    expect((await h.api.instances()).find((i) => i.id === manual.id)?.updateAvailable).toBeNull();
    // presentation assets are served without the minHarbor gate (the launcher tile and drawer icon)
    const icon = await h.api.raw('GET', '/v1/catalog/excalidraw/asset/icon.svg', undefined, { authorization: '' });
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/svg+xml');
    expect(Buffer.from(await icon.arrayBuffer())).toEqual(readFileSync(path.join(REPO_CATALOG, 'excalidraw', 'icon.svg')));
  });
});

describe('official catalog updates off (url null)', () => {
  it('status says off and refresh never fetches', async () => {
    const off = await startHarness();
    try {
      const before = off.fetcher.requests.length;
      expect(await off.api.expect<CatalogStatusDto>(200, 'GET', '/v1/catalog/status')).toMatchObject({ source: null, origin: 'bundled', serial: 0, error: null });
      expect(await off.api.expect<CatalogStatusDto>(200, 'POST', '/v1/catalog/refresh', {})).toMatchObject({ source: null, checkedAt: null, error: null });
      expect(off.fetcher.requests.slice(before).filter((r) => r.url.includes('catalog'))).toEqual([]);
    } finally {
      await off.close();
    }
  });
});
