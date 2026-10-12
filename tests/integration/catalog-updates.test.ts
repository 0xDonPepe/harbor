import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json as fakeJson } from '../../src/appearance/fetcher.js';
import type { CatalogItemDto, CatalogStatusDto, InstanceSummary, NotificationsDto } from '../../src/contracts/api.js';
import { buildBundle, bumpRevision, catalogFiles, testSigner, type TestBundle } from '../unit/bundle-helpers.js';
import { REPO_CATALOG, startHarness, type Harness } from './harness.js';

// Decision 158: the daemon swaps in a newer signed catalog from the catalog repository's releases.
// The "server" is the harness's fake fetcher; the signing key is generated for this run and passed in
// through config.catalog.publicKeys.

const URL_BASE = 'https://catalog.example.test/releases/latest/download';
const signer = testSigner();
let bundle: TestBundle | null = null;
let h: Harness;

beforeAll(async () => {
  h = await startHarness({ config: { catalog: { url: URL_BASE, publicKeys: [signer.publicKey] } } });
  const bin = (b: Buffer | string) => ({ status: 200, contentType: 'application/octet-stream', body: Buffer.from(b) });
  h.fetcher.on(`${URL_BASE}/catalog.json.sig`, () => (bundle ? bin(bundle.sig) : fakeJson({}, 404)));
  h.fetcher.on(`${URL_BASE}/catalog.json`, () => (bundle ? bin(bundle.meta) : fakeJson({}, 404)));
  h.fetcher.on(`${URL_BASE}/catalog.zip`, () => (bundle ? bin(bundle.zip) : fakeJson({}, 404)));
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
    expect(s).toMatchObject({ origin: 'bundled', serial: 0, error: 'the catalog server answered HTTP 404 for catalog.json' });
    expect(s.checkedAt).not.toBeNull();
  });

  it('installed apps get an update from a newer signed catalog, without a restart', async () => {
    expect((await h.api.run({ kind: 'install', packageId: 'excalidraw' })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'install', packageId: 'excalidraw' })).op.state).toBe('succeeded');
    const mine = (await h.api.instances()).filter((i) => i.packageId === 'excalidraw').sort((a, b) => a.name.localeCompare(b.name));
    [manual, auto] = [mine[0]!, mine[1]!];
    await h.api.expect(200, 'PUT', `/v1/instances/${auto.id}/auto-update`, { enabled: true });
    expect(manual.revision).toBe('1');

    bundle = buildBundle(bumpRevision(catalogFiles(REPO_CATALOG), 'excalidraw', '2'), signer, { serial: 1_760_000_000, commit: '0123456789abcdef0123456789abcdef01234567' });
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
    bundle = buildBundle(bumpRevision(catalogFiles(REPO_CATALOG), 'excalidraw', '9'), signer, { serial: 1_700_000_000 });
    expect(await refresh()).toMatchObject({ serial: 1_760_000_000, error: null });
    expect((await catalogItem('excalidraw'))?.revision).toBe('2');
    await h.restart();
    expect(await status()).toMatchObject({ serial: 1_760_000_000, origin: 'downloaded', checkedAt: null });
    expect((await catalogItem('excalidraw'))?.revision).toBe('2');
  });

  it('a bundle signed by another key is refused and changes nothing', async () => {
    bundle = buildBundle(bumpRevision(catalogFiles(REPO_CATALOG), 'excalidraw', '3'), testSigner(), { serial: 1_800_000_000 });
    expect(await refresh()).toMatchObject({ serial: 1_760_000_000, error: 'the app catalog signature does not verify' });
    expect((await catalogItem('excalidraw'))?.revision).toBe('2');
  });

  it('a package that needs a newer Harbor lists as unavailable', async () => {
    bundle = buildBundle(bumpRevision(catalogFiles(REPO_CATALOG), 'excalidraw', '3', { minHarbor: '99.0.0' }), signer, { serial: 1_800_000_000 });
    expect(await refresh()).toMatchObject({ serial: 1_800_000_000, error: null });
    expect(await catalogItem('excalidraw')).toMatchObject({ availability: 'unavailable', reason: 'needs Harbor 99.0.0 or newer', name: 'Excalidraw' });
    // no update is offered for a revision this Harbor cannot run
    expect((await h.api.instances()).find((i) => i.id === manual.id)?.updateAvailable).toBeNull();
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
