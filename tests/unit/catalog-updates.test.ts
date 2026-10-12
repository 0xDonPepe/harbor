import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeFetcher, type FetchResult } from '../../src/appearance/fetcher.js';
import { PackageStore } from '../../src/packages/store.js';
import { FakeRegistry } from '../../src/packages/registry.js';
import { CatalogUpdateService, CHECK_DEADLINE_MS, type CatalogUpdateDeps } from '../../src/system/catalog-updates.js';
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

function setup(opts: { url?: string | null } & Partial<Pick<CatalogUpdateDeps, 'clock' | 'log' | 'monotonicMs' | 'fetcher'>> = {}) {
  const signer = testSigner();
  const seed = cloneCatalog();
  const stateDir = tempDir('harbor-catalog-state-');
  const server = new BundleServer();
  const svc = new CatalogUpdateService({ seedDir: seed, stateDir, url: opts.url === undefined ? URL_BASE : opts.url, publicKeys: [signer.publicKey], fetcher: opts.fetcher ?? server.fetcher, clock: opts.clock ?? systemClock, log: opts.log ?? quiet, ...(opts.monotonicMs ? { monotonicMs: opts.monotonicMs } : {}) });
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

describe('a downloaded catalog is trusted only while it verifies (decision 158 review)', () => {
  const recorder = () => {
    const warns: string[] = [];
    return { warns, log: { ...quiet, warn: (m: string) => void warns.push(m) } };
  };

  it('a folder signed by a key this Harbor no longer pins falls back to the seed, and the new key\'s bundle replaces it', async () => {
    const { seed, stateDir, server, signer, offer, root } = setup();
    const before = new CatalogUpdateService({ seedDir: seed, stateDir, url: URL_BASE, publicKeys: [signer.publicKey], fetcher: server.fetcher, clock: systemClock, log: quiet });
    offer(9_000_000, '2');
    await before.refresh();
    expect(before.status()).toMatchObject({ serial: 9_000_000, origin: 'downloaded' });

    // a Harbor release rotates the key: the old folder no longer counts
    const rotated = testSigner();
    const { warns, log } = recorder();
    const after = new CatalogUpdateService({ seedDir: seed, stateDir, url: URL_BASE, publicKeys: [rotated.publicKey], fetcher: server.fetcher, clock: systemClock, log });
    expect(after.activeDir()).toBe(seed);
    expect(after.status()).toMatchObject({ serial: 0, origin: 'bundled' });
    after.activeDir();
    expect(warns.filter((w) => w.includes('not trusted'))).toHaveLength(1);
    expect(warns[0]).toMatch(/downloaded app catalog 9000000 is not trusted \(the app catalog signature does not verify\)/);

    // a bundle from the new key with a LOWER serial than the stale folder still wins: it is compared with the seed
    server.bundle = buildBundle(bumpRevision(catalogFiles(REPO_CATALOG), 'excalidraw', '3'), rotated, { serial: 5_000 });
    expect(await after.refresh()).toMatchObject({ serial: 5_000, origin: 'downloaded', error: null });
    expect(after.activeDir()).toBe(path.join(root, '5000'));
    expect(numericDirs(root)).toEqual(['5000']);
  });

  it('a folder whose catalog.json names another serial falls back to the seed', async () => {
    const { svc, seed, offer, root } = setup();
    offer(100, '2');
    await svc.refresh();
    renameSync(path.join(root, '100'), path.join(root, '500'));
    writeFileSync(path.join(root, 'current.json'), JSON.stringify({ serial: 500 }));
    expect(svc.activeDir()).toBe(seed);
    expect(svc.status()).toMatchObject({ origin: 'bundled', serial: 0 });
  });

  it('a tampered stored catalog.json falls back to the seed; the signed bytes back make it count again', async () => {
    const { svc, seed, offer, root, store } = setup();
    offer(100, '2');
    await svc.refresh();
    expect(store.load('excalidraw').revision).toBe('2');
    const file = path.join(root, '100', 'catalog.json');
    const signed = readFileSync(file);
    const forged = JSON.parse(signed.toString('utf8'));
    forged.commit = 'feedfacefeedfacefeedfacefeedfacefeedface';
    writeFileSync(file, JSON.stringify(forged));
    expect(svc.activeDir()).toBe(seed);
    expect(store.load('excalidraw').revision).toBe('1');
    writeFileSync(file, signed);
    expect(svc.activeDir()).toBe(path.join(root, '100'));
    // a missing signature is the same as a wrong one
    renameSync(path.join(root, '100', 'catalog.json.sig'), path.join(root, '100', 'sig.bak'));
    expect(svc.activeDir()).toBe(seed);
  });

  it('refuses a bundle dated more than a day ahead of the clock, without downloading its archive', async () => {
    const nowS = 1_760_000_000;
    const { svc, server, offer } = setup({ clock: { now: () => new Date(nowS * 1000) } });
    offer(nowS + 2 * 86_400, '2');
    const s = await svc.refresh();
    expect(s.error).toMatch(/^the app catalog is dated in the future \(2025-10-11T/);
    expect(s).toMatchObject({ origin: 'bundled', serial: 0 });
    expect(server.count('catalog.zip')).toBe(0);
    // a few hours ahead (a CI clock slightly off) is fine
    offer(nowS + 3600, '2');
    expect(await svc.refresh()).toMatchObject({ serial: nowS + 3600, origin: 'downloaded', error: null });
  });

  it('a release published halfway through a check (mixed files) is checked again once from the start', async () => {
    const { svc, server, signer, base } = setup();
    const older = buildBundle(bumpRevision(base, 'excalidraw', '2'), signer, { serial: 100 });
    const newer = buildBundle(bumpRevision(base, 'excalidraw', '3'), signer, { serial: 200 });
    // first round: old catalog.json, then the new release lands (new signature)
    server.bundle = newer;
    let metaCalls = 0;
    server.fetcher.routes.unshift({ match: (u) => u === `${URL_BASE}/catalog.json` && metaCalls++ === 0, reply: () => bin(older.meta) });
    expect(await svc.refresh()).toMatchObject({ serial: 200, origin: 'downloaded', error: null });
    expect(server.count('catalog.json')).toBe(2);

    // old catalog.json + signature, then the new archive: checksum mismatch, checked again
    const { svc: svc2, server: server2, signer: signer2, base: base2 } = setup();
    const a = buildBundle(bumpRevision(base2, 'excalidraw', '2'), signer2, { serial: 100 });
    const b = buildBundle(bumpRevision(base2, 'excalidraw', '3'), signer2, { serial: 200 });
    server2.bundle = a;
    let zipCalls = 0;
    server2.fetcher.routes.unshift({
      match: (u) => u === `${URL_BASE}/catalog.zip` && zipCalls++ === 0,
      reply: () => {
        server2.bundle = b;
        return bin(b.zip.subarray(0, Math.min(b.zip.length, a.zip.length)));
      },
    });
    expect(await svc2.refresh()).toMatchObject({ serial: 200, error: null });
    expect(server2.count('catalog.zip')).toBe(2);

    // a bundle that stays wrong is checked twice, then reported
    const { svc: svc3, server: server3, base: base3 } = setup();
    server3.bundle = buildBundle(base3, testSigner(), { serial: 100 });
    expect((await svc3.refresh()).error).toMatch(/signature does not verify/);
    expect(server3.count('catalog.json')).toBe(2);
  });

  it('one deadline for the whole check: each step gets at most what is left of it', async () => {
    let t = 0;
    const timeouts: Record<string, number[]> = {};
    const server = new BundleServer();
    const fetcher = {
      async fetch(url: string, opts: { timeoutMs?: number } = {}) {
        const name = url.slice(URL_BASE.length + 1);
        (timeouts[name] ??= []).push(opts.timeoutMs ?? -1);
        t += 100_000; // every request takes 100 s
        return server.fetcher.fetch(url);
      },
    };
    const { svc, signer, base } = setup({ fetcher, monotonicMs: () => t });
    server.bundle = buildBundle(bumpRevision(base, 'excalidraw', '2'), signer, { serial: 100 });
    expect(await svc.refresh()).toMatchObject({ serial: 100, error: null });
    expect(timeouts).toEqual({ 'catalog.json': [30_000], 'catalog.json.sig': [30_000], 'catalog.zip': [CHECK_DEADLINE_MS - 200_000] });

    // no time left before the archive: the check stops with that reason (the CLI never waits past its own limit)
    t = 0;
    const slow = { async fetch(url: string) { t += 130_000; return server.fetcher.fetch(url); } };
    const { svc: svc2, signer: signer2, base: base2 } = setup({ fetcher: slow, monotonicMs: () => t });
    server.bundle = buildBundle(bumpRevision(base2, 'excalidraw', '2'), signer2, { serial: 100 });
    expect((await svc2.refresh()).error).toBe(`the app catalog check took longer than ${CHECK_DEADLINE_MS / 1000} s (stopped before catalog.zip); Harbor tries again at the next check`);
  });
});
