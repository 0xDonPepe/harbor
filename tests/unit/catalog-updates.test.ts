import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeFetcher, type FetchResult } from '../../src/appearance/fetcher.js';
import { PackageStore } from '../../src/packages/store.js';
import { FakeRegistry } from '../../src/packages/registry.js';
import { CatalogUpdateService } from '../../src/system/catalog-updates.js';
import { systemClock } from '../../src/util.js';
import { buildBundle, bumpRevision, catalogFiles, testSigner, type TestBundle } from './bundle-helpers.js';
import { cloneCatalog, REPO_CATALOG, tempDir } from './helpers.js';

const URL_BASE = 'https://catalog.example.test/releases/latest/download';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const bin = (body: Buffer | string, status = 200): FetchResult => ({ status, contentType: 'application/octet-stream', body: Buffer.from(body) });

// A catalog "server": whatever bundle is current answers the three asset names.
class BundleServer {
  bundle: TestBundle | null = null;
  zipOverride: Buffer | null = null;
  readonly fetcher = new FakeFetcher();
  constructor() {
    this.fetcher.on(`${URL_BASE}/catalog.json.sig`, () => (this.bundle ? bin(this.bundle.sig) : bin('missing', 404)));
    this.fetcher.on(`${URL_BASE}/catalog.json`, () => (this.bundle ? bin(this.bundle.meta) : bin('missing', 404)));
    this.fetcher.on(`${URL_BASE}/catalog.zip`, () => (this.bundle ? bin(this.zipOverride ?? this.bundle.zip) : bin('missing', 404)));
  }
  count(name: string): number {
    return this.fetcher.requests.filter((r) => r.url === `${URL_BASE}/${name}`).length;
  }
}

function setup(opts: { url?: string | null } = {}) {
  const signer = testSigner();
  const seed = cloneCatalog();
  const stateDir = tempDir('harbor-catalog-state-');
  const server = new BundleServer();
  const svc = new CatalogUpdateService({ seedDir: seed, stateDir, url: opts.url === undefined ? URL_BASE : opts.url, publicKeys: [signer.publicKey], fetcher: server.fetcher, clock: systemClock, log: quiet });
  const store = new PackageStore(() => svc.activeDir(), tempDir('harbor-local-'), new FakeRegistry(), systemClock);
  const base = catalogFiles(REPO_CATALOG);
  const offer = (serial: number, revision: string, files = bumpRevision(base, 'excalidraw', revision)) => {
    server.bundle = buildBundle(files, signer, { serial });
    server.zipOverride = null;
  };
  return { signer, seed, stateDir, server, svc, store, base, offer, root: path.join(stateDir, 'catalog') };
}

const numericDirs = (root: string) => readdirSync(root).filter((n) => /^\d+$/.test(n)).sort();

describe('official catalog updates (decision 158)', () => {
  it('starts on the bundled seed (serial 0 without catalog.json) and swaps to a newer signed bundle without a restart', async () => {
    const { svc, store, seed, server, offer, root } = setup();
    expect(svc.activeDir()).toBe(seed);
    expect(svc.status()).toMatchObject({ source: URL_BASE, serial: 0, origin: 'bundled', commit: null, createdAt: null, checkedAt: null, error: null });
    expect(store.list().find((i) => i.id === 'excalidraw')?.revision).toBe('1');

    offer(1_760_000_000, '2');
    const s = await svc.refresh();
    expect(s).toMatchObject({ serial: 1_760_000_000, origin: 'downloaded', commit: 'abcdef0123456789abcdef0123456789abcdef01', createdAt: '2026-10-01T12:00:00Z', error: null });
    expect(s.checkedAt).not.toBeNull();
    expect(s.packages).toBe(Object.keys(JSON.parse(readFileSync(path.join(seed, 'index.json'), 'utf8')).packages).length);
    expect(svc.activeDir()).toBe(path.join(root, '1760000000'));
    expect(JSON.parse(readFileSync(path.join(root, 'current.json'), 'utf8'))).toEqual({ serial: 1_760_000_000 });
    // the signed metadata is kept verbatim next to the extracted catalog
    expect(readFileSync(path.join(root, '1760000000', 'catalog.json'))).toEqual(server.bundle!.meta);
    expect(readFileSync(path.join(root, '1760000000', 'catalog.json.sig'), 'utf8')).toBe(server.bundle!.sig);
    // same store object, next read sees the new revision
    expect(store.list().find((i) => i.id === 'excalidraw')).toMatchObject({ revision: '2', origin: 'bundled', availability: 'available' });
    expect(store.load('excalidraw').revision).toBe('2');
    expect(store.currentRevisions().get('excalidraw')?.revision).toBe('2');
  });

  it('never replaces the active catalog with an equal or older serial, and does not download its archive', async () => {
    const { svc, server, offer, root } = setup();
    offer(200, '2');
    await svc.refresh();
    expect(server.count('catalog.zip')).toBe(1);
    // replay of the same bundle
    expect(await svc.refresh()).toMatchObject({ serial: 200, error: null });
    // an older bundle (rollback attempt) with a "newer" revision inside
    offer(100, '9');
    expect(await svc.refresh()).toMatchObject({ serial: 200, origin: 'downloaded', error: null });
    expect(server.count('catalog.zip')).toBe(1);
    expect(numericDirs(root)).toEqual(['200']);
  });

  it('keeps only the active catalog and the one it replaced', async () => {
    const { svc, offer, root } = setup();
    offer(100, '2');
    await svc.refresh();
    expect(numericDirs(root)).toEqual(['100']);
    offer(200, '3');
    await svc.refresh();
    expect(numericDirs(root)).toEqual(['100', '200']);
    offer(300, '4');
    await svc.refresh();
    expect(numericDirs(root)).toEqual(['200', '300']);
    expect(readdirSync(root).filter((n) => n.startsWith('.partial-'))).toEqual([]);
  });

  it('a seed newer than the downloaded catalog wins (Harbor upgraded with a fresher bundle)', async () => {
    const { seed, stateDir, server, signer, offer } = setup();
    // first daemon: downloads serial 300
    const first = new CatalogUpdateService({ seedDir: seed, stateDir, url: URL_BASE, publicKeys: [signer.publicKey], fetcher: server.fetcher, clock: systemClock, log: quiet });
    offer(300, '2');
    await first.refresh();
    expect(first.status().serial).toBe(300);
    // the upgrade ships a seed with serial 500 (catalog.json copied by the release build)
    const seedMeta = buildBundle(catalogFiles(seed), signer, { serial: 500, commit: 'feedface00' });
    writeFileSync(path.join(seed, 'catalog.json'), seedMeta.meta);
    writeFileSync(path.join(seed, 'catalog.json.sig'), seedMeta.sig);
    const next = new CatalogUpdateService({ seedDir: seed, stateDir, url: URL_BASE, publicKeys: [signer.publicKey], fetcher: server.fetcher, clock: systemClock, log: quiet });
    expect(next.activeDir()).toBe(seed);
    expect(next.status()).toMatchObject({ serial: 500, origin: 'bundled', commit: 'feedface00' });
    // the server still offers 400: older than the seed, nothing to do
    offer(400, '3');
    expect(await next.refresh()).toMatchObject({ serial: 500, origin: 'bundled', error: null });
    expect(next.activeDir()).toBe(seed);
  });

  it('a corrupt or dangling pointer falls back to the seed', async () => {
    const { svc, seed, offer, root } = setup();
    offer(100, '2');
    await svc.refresh();
    writeFileSync(path.join(root, 'current.json'), '{not json');
    expect(svc.activeDir()).toBe(seed);
    writeFileSync(path.join(root, 'current.json'), JSON.stringify({ serial: 999 }));
    expect(svc.activeDir()).toBe(seed);
    writeFileSync(path.join(root, 'current.json'), JSON.stringify({ serial: '100' }));
    expect(svc.status()).toMatchObject({ origin: 'bundled', serial: 0 });
    writeFileSync(path.join(root, 'current.json'), JSON.stringify({ serial: 100 }));
    expect(svc.activeDir()).toBe(path.join(root, '100'));
  });

  it('a failed check leaves the active catalog untouched and reports why', async () => {
    const { svc, server, offer, base, signer, root, store } = setup();
    offer(100, '2');
    await svc.refresh();
    const active = svc.activeDir();

    // archive swapped after signing
    offer(200, '3');
    server.zipOverride = buildBundle(bumpRevision(base, 'excalidraw', '7'), signer, { serial: 200 }).zip;
    expect((await svc.refresh()).error).toMatch(/does not match its signed checksum|larger than/);
    // signed by someone else
    server.bundle = buildBundle(bumpRevision(base, 'excalidraw', '3'), testSigner(), { serial: 200 });
    expect((await svc.refresh()).error).toMatch(/signature does not verify/);
    // index lists a folder the archive does not carry
    const index = JSON.parse(base['index.json']!.toString('utf8'));
    index.packages['ghost'] = { revision: '1', dir: 'ghost' };
    offer(200, '3', { ...bumpRevision(base, 'excalidraw', '3'), 'index.json': Buffer.from(JSON.stringify(index)) });
    expect((await svc.refresh()).error).toMatch(/lists ghost but has no ghost\/ folder/);
    // an invalid index
    offer(200, '3', { ...base, 'index.json': Buffer.from('{"schemaVersion":2}') });
    expect((await svc.refresh()).error).toMatch(/catalog index invalid/);
    // the server is down
    server.bundle = null;
    const s = await svc.refresh();
    expect(s.error).toBe('the catalog server answered HTTP 404 for catalog.json');
    expect(s).toMatchObject({ serial: 100, origin: 'downloaded' });

    expect(svc.activeDir()).toBe(active);
    expect(numericDirs(root)).toEqual(['100']);
    expect(readdirSync(root).filter((n) => n.startsWith('.partial-'))).toEqual([]);
    expect(store.load('excalidraw').revision).toBe('2');
    // the next good bundle clears the error
    offer(300, '4');
    expect(await svc.refresh()).toMatchObject({ serial: 300, error: null });
  });

  it('a fetcher that throws becomes a status error, never an exception', async () => {
    const { svc } = setup();
    const boom = new CatalogUpdateService({ seedDir: svc.activeDir(), stateDir: tempDir(), url: URL_BASE, publicKeys: [testSigner().publicKey], fetcher: { fetch: async () => Promise.reject(new Error('getaddrinfo ENOTFOUND catalog.example.test')) }, clock: systemClock, log: quiet });
    const s = await boom.refresh();
    expect(s.error).toBe('could not download catalog.json from the catalog server (getaddrinfo ENOTFOUND catalog.example.test)');
    expect(s.origin).toBe('bundled');
  });

  it('runs one check at a time: concurrent refreshes share it', async () => {
    const { svc, server, offer } = setup();
    offer(100, '2');
    const [a, b] = await Promise.all([svc.refresh(), svc.refresh()]);
    expect(a).toEqual(b);
    expect(server.count('catalog.json')).toBe(1);
    expect(server.count('catalog.zip')).toBe(1);
    await svc.refresh();
    expect(server.count('catalog.json')).toBe(2); // a later click checks again
  });

  it('off (url null): status says so, refresh and the timer never fetch', async () => {
    const { svc, server, offer, seed } = setup({ url: null });
    offer(100, '2');
    expect(svc.status()).toMatchObject({ source: null, origin: 'bundled', serial: 0, error: null });
    expect(await svc.refresh()).toMatchObject({ source: null, serial: 0, checkedAt: null });
    svc.start(1, 5);
    await new Promise((r) => setTimeout(r, 40));
    svc.stop();
    expect(server.fetcher.requests).toEqual([]);
    expect(svc.activeDir()).toBe(seed);
  });

  it('the timer checks after the first delay, then on its interval, and stops', async () => {
    const { svc, server, offer } = setup();
    offer(100, '2');
    svc.start(5, 20);
    await new Promise((r) => setTimeout(r, 80));
    svc.stop();
    const seen = server.count('catalog.json');
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(svc.status().serial).toBe(100);
    await new Promise((r) => setTimeout(r, 60));
    expect(server.count('catalog.json')).toBe(seen);
    expect(existsSync(svc.activeDir())).toBe(true);
  });
});
