import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeFetcher, type FetchResult } from '../../src/appearance/fetcher.js';
import { PackageStore } from '../../src/packages/store.js';
import { FakeRegistry } from '../../src/packages/registry.js';
import { signDetached } from '../../src/signing.js';
import { CatalogUpdateService, CHECK_DEADLINE_MS, type CatalogUpdateDeps } from '../../src/system/catalog-updates.js';
import { systemClock } from '../../src/util.js';
import { buildBundle, bumpRevision, catalogFiles, TEST_KEYS, TEST_SIGNER, testKeyPair, type TestBundle } from './bundle-helpers.js';
import { cloneCatalog, REPO_CATALOG, tempDir } from './helpers.js';

const RELEASES = 'https://catalog.example.test/releases';
const URL_BASE = `${RELEASES}/latest/download`;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const bin = (body: Buffer | string, status = 200): FetchResult => ({ status, contentType: 'application/octet-stream', body: Buffer.from(body) });
const redirect = (location: string): FetchResult => ({ status: 302, contentType: 'text/html', body: Buffer.from(''), location });
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A catalog "server" shaped like GitHub releases: releases/latest redirects to tag c<serial>, and each release
// serves its own files under releases/download/c<serial>/. A release may carry a replaced archive or signature.
interface Release {
  bundle: TestBundle;
  zip?: Buffer;
  sig?: Buffer | null; // null: the release has no catalog.json.sig
}
class BundleServer {
  readonly releases = new Map<number, Release>();
  latest: number | null = null;
  readonly fetcher = new FakeFetcher();
  constructor() {
    this.fetcher.on(new RegExp(`^${esc(RELEASES)}/latest$`), () => (this.latest === null ? redirect(RELEASES) : redirect(`${RELEASES}/tag/c${this.latest}`)));
    this.fetcher.on(new RegExp(`^${esc(RELEASES)}/download/c(\\d+)/([^/]+)$`), (url) => {
      const [, tag, name] = /\/download\/c(\d+)\/([^/]+)$/.exec(url)!;
      const r = this.releases.get(Number(tag));
      if (!r) return bin('missing', 404);
      if (name === 'catalog.json') return bin(r.bundle.meta);
      if (name === 'catalog.zip') return bin(r.zip ?? r.bundle.zip);
      if (name === 'catalog.json.sig') return r.sig === null ? bin('Not Found', 404) : bin(r.sig ?? r.bundle.sig);
      return bin('missing', 404);
    });
  }
  publish(bundle: TestBundle, opts: { tag?: number; zip?: Buffer; sig?: Buffer | null } = {}): void {
    const tag = opts.tag ?? bundle.serial;
    this.releases.set(tag, { bundle, ...(opts.zip ? { zip: opts.zip } : {}), ...(opts.sig !== undefined ? { sig: opts.sig } : {}) });
    this.latest = tag;
  }
  count(name: string): number {
    return this.fetcher.requests.filter((r) => r.url.endsWith(`/${name}`)).length;
  }
}

function setup(opts: { url?: string | null } & Partial<Pick<CatalogUpdateDeps, 'clock' | 'log' | 'monotonicMs' | 'fetcher' | 'keys'>> = {}) {
  const seed = cloneCatalog();
  const stateDir = tempDir('harbor-catalog-state-');
  const server = new BundleServer();
  const svc = new CatalogUpdateService({ seedDir: seed, stateDir, url: opts.url === undefined ? URL_BASE : opts.url, fetcher: opts.fetcher ?? server.fetcher, clock: opts.clock ?? systemClock, log: opts.log ?? quiet, keys: opts.keys ?? TEST_KEYS, ...(opts.monotonicMs ? { monotonicMs: opts.monotonicMs } : {}) });
  const store = new PackageStore(() => svc.activeDir(), tempDir('harbor-local-'), new FakeRegistry(), systemClock);
  const base = catalogFiles(REPO_CATALOG);
  const offer = (serial: number, revision: string, files = bumpRevision(base, 'excalidraw', revision)) => server.publish(buildBundle(files, { serial }));
  return { seed, stateDir, server, svc, store, base, offer, root: path.join(stateDir, 'catalog') };
}

const numericDirs = (root: string) => readdirSync(root).filter((n) => /^\d+$/.test(n)).sort();

describe('official catalog updates (decision 158)', () => {
  it('starts on the bundled seed (serial 0 without catalog.json) and swaps to a newer bundle without a restart', async () => {
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
    // catalog.json and its signature are kept verbatim next to the extracted catalog (nothing else is added)
    expect(readFileSync(path.join(root, '1760000000', 'catalog.json'))).toEqual(server.releases.get(1_760_000_000)!.bundle.meta);
    expect(readFileSync(path.join(root, '1760000000', 'catalog.json.sig'))).toEqual(server.releases.get(1_760_000_000)!.bundle.sig);
    // same store object, next read sees the new revision
    expect(store.list().find((i) => i.id === 'excalidraw')).toMatchObject({ revision: '2', origin: 'bundled', availability: 'available' });
    expect(store.load('excalidraw').revision).toBe('2');
    expect(store.currentRevisions().get('excalidraw')?.revision).toBe('2');
  });

  it('decision 168: every file comes from the tag releases/latest names, resolved once per check', async () => {
    const { svc, server, offer } = setup();
    offer(100, '2');
    await svc.refresh();
    expect(server.fetcher.requests.map((r) => r.url)).toEqual([`${RELEASES}/latest`, `${RELEASES}/download/c100/catalog.json`, `${RELEASES}/download/c100/catalog.json.sig`, `${RELEASES}/download/c100/catalog.zip`]);
  });

  it('never replaces the active catalog with an equal or older serial, and does not download anything for it', async () => {
    const { svc, server, offer, root } = setup();
    offer(200, '2');
    await svc.refresh();
    expect(server.count('catalog.zip')).toBe(1);
    // replay of the same bundle: the tag alone says there is nothing new
    expect(await svc.refresh()).toMatchObject({ serial: 200, error: null });
    // an older bundle (rollback attempt) with a "newer" revision inside
    offer(100, '9');
    expect(await svc.refresh()).toMatchObject({ serial: 200, origin: 'downloaded', error: null });
    expect(server.count('catalog.json')).toBe(1);
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
    const { seed, stateDir, server, offer } = setup();
    // first daemon: downloads serial 300
    const first = new CatalogUpdateService({ seedDir: seed, stateDir, url: URL_BASE, fetcher: server.fetcher, clock: systemClock, log: quiet, keys: TEST_KEYS });
    offer(300, '2');
    await first.refresh();
    expect(first.status().serial).toBe(300);
    // the upgrade ships a seed with serial 500 (catalog.json copied by the release build; no signature needed)
    const seedMeta = buildBundle(catalogFiles(seed), { serial: 500, commit: 'feedface00' });
    writeFileSync(path.join(seed, 'catalog.json'), seedMeta.meta);
    const next = new CatalogUpdateService({ seedDir: seed, stateDir, url: URL_BASE, fetcher: server.fetcher, clock: systemClock, log: quiet, keys: TEST_KEYS });
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
    const { svc, server, offer, base, root, store } = setup();
    offer(100, '2');
    await svc.refresh();
    const active = svc.activeDir();

    // an archive that is not the one catalog.json pins
    server.publish(buildBundle(bumpRevision(base, 'excalidraw', '3'), { serial: 200 }), { zip: buildBundle(bumpRevision(base, 'excalidraw', '7'), { serial: 200 }).zip });
    expect((await svc.refresh()).error).toMatch(/does not match its catalog\.json checksum|larger than/);
    // a signed catalog.json that is not valid metadata
    const nope = Buffer.from('{nope');
    server.publish({ ...buildBundle(bumpRevision(base, 'excalidraw', '3'), { serial: 200 }), meta: nope }, { sig: Buffer.from(signDetached(nope, TEST_SIGNER.privatePem)) });
    expect((await svc.refresh()).error).toMatch(/catalog\.json is not JSON/);
    // index lists a folder the archive does not carry
    const index = JSON.parse(base['index.json']!.toString('utf8'));
    index.packages['ghost'] = { revision: '1', dir: 'ghost' };
    offer(200, '3', { ...bumpRevision(base, 'excalidraw', '3'), 'index.json': Buffer.from(JSON.stringify(index)) });
    expect((await svc.refresh()).error).toMatch(/lists ghost but has no ghost\/ folder/);
    // an invalid index
    offer(200, '3', { ...base, 'index.json': Buffer.from('{"schemaVersion":2}') });
    expect((await svc.refresh()).error).toMatch(/catalog index invalid/);
    // no release at all (GitHub sends releases/latest to the bare releases page)
    server.latest = null;
    const s = await svc.refresh();
    expect(s.error).toBe(`could not resolve the latest catalog release from ${RELEASES}/latest (Location: "${RELEASES}")`);
    expect(s).toMatchObject({ serial: 100, origin: 'downloaded' });
    // a tag whose files are gone
    server.latest = 250;
    expect((await svc.refresh()).error).toBe('the catalog server answered HTTP 404 for catalog.json');

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
    const boom = new CatalogUpdateService({ seedDir: svc.activeDir(), stateDir: tempDir(), url: URL_BASE, fetcher: { fetch: async () => Promise.reject(new Error('getaddrinfo ENOTFOUND catalog.example.test')) }, clock: systemClock, log: quiet, keys: TEST_KEYS });
    const s = await boom.refresh();
    expect(s.error).toBe('could not download the newest catalog release from the catalog server (getaddrinfo ENOTFOUND catalog.example.test)');
    expect(s.origin).toBe('bundled');
  });

  it('runs one check at a time: concurrent refreshes share it', async () => {
    const { svc, server, offer } = setup();
    offer(100, '2');
    const [a, b] = await Promise.all([svc.refresh(), svc.refresh()]);
    expect(a).toEqual(b);
    expect(server.count('latest')).toBe(1);
    expect(server.count('catalog.json')).toBe(1);
    expect(server.count('catalog.zip')).toBe(1);
    await svc.refresh();
    expect(server.count('latest')).toBe(2); // a later click checks again
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
    const seen = server.count('latest');
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(svc.status().serial).toBe(100);
    await new Promise((r) => setTimeout(r, 60));
    expect(server.count('latest')).toBe(seen);
    expect(existsSync(svc.activeDir())).toBe(true);
  });
});


describe('decision 168: a downloaded catalog is used only when a pinned key signed its catalog.json', () => {
  it('refuses an unsigned release and keeps the catalog it has, without downloading the archive', async () => {
    const { svc, server, offer, base } = setup();
    offer(100, '2');
    await svc.refresh();
    server.publish(buildBundle(bumpRevision(base, 'excalidraw', '3'), { serial: 200 }), { sig: null });
    const s = await svc.refresh();
    expect(s.error).toBe('refusing the app catalog c200: its catalog.json is not signed (no catalog.json.sig); Harbor keeps the catalog it has');
    expect(s).toMatchObject({ serial: 100, origin: 'downloaded' });
    expect(server.count('catalog.zip')).toBe(1);
  });

  it('refuses a signature over other bytes, by another key, or that is not a signature', async () => {
    const { svc, server, base } = setup();
    const b = buildBundle(bumpRevision(base, 'excalidraw', '2'), { serial: 100 });
    const other = buildBundle(bumpRevision(base, 'excalidraw', '3'), { serial: 100 });
    // the signature of another catalog.json (a tampered file keeps the old signature)
    server.publish(b, { sig: other.sig });
    expect((await svc.refresh()).error).toMatch(/^refusing the app catalog c100: its catalog\.json does not match its catalog\.json\.sig: the file was changed, or it was signed by a key this Harbor does not trust \(trusted: test-FIXTURE-key\); Harbor keeps the catalog it has$/);
    // a valid signature by a key this Harbor does not pin
    const stranger = testKeyPair('stranger-FIXTURE');
    server.publish(b, { sig: Buffer.from(signDetached(b.meta, stranger.privatePem)) });
    expect((await svc.refresh()).error).toMatch(/does not match its catalog\.json\.sig/);
    // garbage
    server.publish(b, { sig: Buffer.from('not a signature\n') });
    expect((await svc.refresh()).error).toBe('refusing the app catalog c100: its catalog.json has a catalog.json.sig that is not an Ed25519 signature; Harbor keeps the catalog it has');
    expect(svc.status()).toMatchObject({ origin: 'bundled', serial: 0 });
    expect(server.count('catalog.zip')).toBe(0);
    // the good signature is accepted
    server.publish(b);
    expect(await svc.refresh()).toMatchObject({ serial: 100, origin: 'downloaded', error: null });
  });

  it('by default only the pinned release keys count: a bundle signed by a test key is refused', async () => {
    const { seed, server, offer } = setup();
    const real = new CatalogUpdateService({ seedDir: seed, stateDir: tempDir(), url: URL_BASE, fetcher: server.fetcher, clock: systemClock, log: quiet });
    offer(100, '2');
    expect((await real.refresh()).error).toMatch(/does not match its catalog\.json\.sig: .* \(trusted: harbor-2026-10\); Harbor keeps the catalog it has$/);
    expect(real.status()).toMatchObject({ origin: 'bundled', serial: 0 });
  });

  it('accepts any pinned key, so a rotation can ship the next key first', async () => {
    const next = testKeyPair('next-FIXTURE-key');
    const { svc, server, base } = setup({ keys: [...TEST_KEYS, next.key] });
    const b = buildBundle(bumpRevision(base, 'excalidraw', '2'), { serial: 100 });
    server.publish(b, { sig: Buffer.from(signDetached(b.meta, next.privatePem)) });
    expect(await svc.refresh()).toMatchObject({ serial: 100, origin: 'downloaded', error: null });
  });

  it('refuses a release whose catalog.json names another serial than its tag', async () => {
    const { svc, server, base } = setup();
    server.publish(buildBundle(bumpRevision(base, 'excalidraw', '2'), { serial: 200 }), { tag: 300 });
    expect((await svc.refresh()).error).toBe('the catalog release c300 carries a catalog.json with serial 200; Harbor keeps the catalog it has');
    expect(server.count('catalog.zip')).toBe(0);
  });

  it('a mirror URL (not …/releases/latest/download) is read as is, signature required the same way', async () => {
    const MIRROR = 'https://mirror.example.test/harbor-catalog';
    const fetcher = new FakeFetcher();
    let current: { b: TestBundle; sig: Buffer | null } | null = null;
    fetcher.on(`${MIRROR}/`, (url) => {
      if (!current) return bin('missing', 404);
      const name = url.slice(MIRROR.length + 1);
      if (name === 'catalog.json') return bin(current.b.meta);
      if (name === 'catalog.zip') return bin(current.b.zip);
      if (name === 'catalog.json.sig') return current.sig ? bin(current.sig) : bin('missing', 404);
      return bin('missing', 404);
    });
    const { svc, base } = setup({ url: MIRROR, fetcher });
    const b = buildBundle(bumpRevision(base, 'excalidraw', '2'), { serial: 100 });
    current = { b, sig: null };
    expect((await svc.refresh()).error).toBe('refusing the app catalog: its catalog.json is not signed (no catalog.json.sig); Harbor keeps the catalog it has');
    current = { b, sig: b.sig };
    expect(await svc.refresh()).toMatchObject({ serial: 100, origin: 'downloaded', error: null });
    expect(fetcher.requests.map((r) => r.url).filter((u) => u.includes('latest'))).toEqual([]);
  });

  it('a mirror read across a publish (two bundles mixed) starts over once; a tag-pinned check never needs to', async () => {
    const MIRROR = 'https://mirror.example.test/harbor-catalog';
    // a mirror that switches from `from` to `to` right after serving the file `flipAfter`
    const mixing = (from: TestBundle, to: TestBundle, flipAfter: string) => {
      const fetcher = new FakeFetcher();
      let current = from;
      fetcher.on(`${MIRROR}/`, (url) => {
        const name = url.slice(MIRROR.length + 1);
        const b = current;
        if (name === flipAfter) current = to;
        if (name === 'catalog.json') return bin(b.meta);
        if (name === 'catalog.zip') return bin(b.zip);
        if (name === 'catalog.json.sig') return bin(b.sig);
        return bin('missing', 404);
      });
      return fetcher;
    };
    const base = catalogFiles(REPO_CATALOG);
    const older = buildBundle(bumpRevision(base, 'excalidraw', '2'), { serial: 100 });
    const newer = buildBundle(bumpRevision(base, 'excalidraw', '3'), { serial: 200 });
    // the newer bundle lands between catalog.json and its signature (the signature does not match)
    const a = mixing(older, newer, 'catalog.json');
    expect(await setup({ url: MIRROR, fetcher: a }).svc.refresh()).toMatchObject({ serial: 200, origin: 'downloaded', error: null });
    expect(a.requests.filter((r) => r.url.endsWith('/catalog.json'))).toHaveLength(2);
    // ... or between the signature and the archive (the checksum does not match)
    const b = mixing(older, newer, 'catalog.json.sig');
    expect(await setup({ url: MIRROR, fetcher: b }).svc.refresh()).toMatchObject({ serial: 200, origin: 'downloaded', error: null });
    expect(b.requests.filter((r) => r.url.endsWith('/catalog.zip'))).toHaveLength(2);
    // a mirror that keeps serving a bad signature is still refused after the one retry
    const bad = new FakeFetcher();
    bad.on(`${MIRROR}/`, (url) => (url.endsWith('/catalog.json') ? bin(older.meta) : url.endsWith('.sig') ? bin(newer.sig) : bin(older.zip)));
    expect((await setup({ url: MIRROR, fetcher: bad }).svc.refresh()).error).toMatch(/does not match its catalog\.json\.sig/);
    expect(bad.requests.filter((r) => r.url.endsWith('/catalog.json'))).toHaveLength(2);
    // the GitHub layout pins the tag: a wrong archive is an error at once, without a second try
    const gh = setup();
    gh.server.publish(buildBundle(bumpRevision(base, 'excalidraw', '5'), { serial: 400 }), { zip: older.zip });
    expect((await gh.svc.refresh()).error).toMatch(/does not match its catalog\.json checksum|larger than/);
    expect(gh.server.count('catalog.zip')).toBe(1);
    expect(gh.server.count('catalog.json')).toBe(1);
  });
});

describe('a downloaded catalog counts only while it is intact (decision 158 review)', () => {
  const recorder = () => {
    const warns: string[] = [];
    return { warns, log: { ...quiet, warn: (m: string) => void warns.push(m) } };
  };

  it('a folder whose catalog.json no longer parses falls back to the seed (warned once), and the next bundle is compared with the seed', async () => {
    const { seed, stateDir, server, offer, root } = setup();
    const before = new CatalogUpdateService({ seedDir: seed, stateDir, url: URL_BASE, fetcher: server.fetcher, clock: systemClock, log: quiet, keys: TEST_KEYS });
    offer(9_000_000, '2');
    await before.refresh();
    expect(before.status()).toMatchObject({ serial: 9_000_000, origin: 'downloaded' });

    const damaged = Buffer.from('{damaged');
    writeFileSync(path.join(root, '9000000', 'catalog.json'), damaged);
    writeFileSync(path.join(root, '9000000', 'catalog.json.sig'), signDetached(damaged, TEST_SIGNER.privatePem)); // signed, still damaged
    const { warns, log } = recorder();
    const after = new CatalogUpdateService({ seedDir: seed, stateDir, url: URL_BASE, fetcher: server.fetcher, clock: systemClock, log, keys: TEST_KEYS });
    expect(after.activeDir()).toBe(seed);
    expect(after.status()).toMatchObject({ serial: 0, origin: 'bundled' });
    after.activeDir();
    expect(warns.filter((w) => w.includes('is damaged'))).toHaveLength(1);
    expect(warns[0]).toMatch(/^the downloaded app catalog 9000000 is damaged \(catalog\.json is not JSON: .*\); using the catalog bundled with Harbor$/);

    // a bundle with a LOWER serial than the damaged folder still wins: it is compared with the seed
    server.publish(buildBundle(bumpRevision(catalogFiles(REPO_CATALOG), 'excalidraw', '3'), { serial: 5_000 }));
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

  it('a stored catalog.json that is damaged, names another serial or is gone falls back to the seed; the original bytes back make it count again', async () => {
    const { svc, seed, offer, root, store } = setup();
    offer(100, '2');
    await svc.refresh();
    expect(store.load('excalidraw').revision).toBe('2');
    const file = path.join(root, '100', 'catalog.json');
    const original = readFileSync(file);
    const meta = JSON.parse(original.toString('utf8'));

    writeFileSync(file, original.subarray(0, 40)); // truncated
    expect(svc.activeDir()).toBe(seed);
    expect(store.load('excalidraw').revision).toBe('1');
    writeFileSync(file, original);
    expect(svc.activeDir()).toBe(path.join(root, '100'));

    const sigFile = path.join(root, '100', 'catalog.json.sig');
    const originalSig = readFileSync(sigFile);
    const signed = (text: string) => {
      writeFileSync(file, text);
      writeFileSync(sigFile, signDetached(Buffer.from(text), TEST_SIGNER.privatePem));
    };
    signed(JSON.stringify({ ...meta, serial: 101 }));
    expect(svc.activeDir()).toBe(seed);
    signed(JSON.stringify({ ...meta, schemaVersion: 2 }));
    expect(svc.activeDir()).toBe(seed);
    writeFileSync(sigFile, originalSig);
    writeFileSync(file, original);
    renameSync(file, path.join(root, '100', 'meta.bak'));
    expect(svc.activeDir()).toBe(seed);
    renameSync(path.join(root, '100', 'meta.bak'), file);
    expect(svc.activeDir()).toBe(path.join(root, '100'));
    // an edit that keeps it valid and naming the same serial no longer verifies with the stored signature
    writeFileSync(file, JSON.stringify({ ...meta, commit: 'feedfacefeedfacefeedfacefeedfacefeedface' }));
    expect(svc.activeDir()).toBe(seed);
    writeFileSync(file, original);
    expect(svc.activeDir()).toBe(path.join(root, '100'));
  });

  it('decision 168: a folder without a valid stored catalog.json.sig (downloaded unsigned by Harbor 0.31 or older) falls back to the seed', async () => {
    const { seed, stateDir, server, offer, root } = setup();
    const first = new CatalogUpdateService({ seedDir: seed, stateDir, url: URL_BASE, fetcher: server.fetcher, clock: systemClock, log: quiet, keys: TEST_KEYS });
    offer(100, '2');
    await first.refresh();
    const sigFile = path.join(root, '100', 'catalog.json.sig');
    const good = readFileSync(sigFile);
    // what an older Harbor left: the folder without a signature
    renameSync(sigFile, `${sigFile}.bak`);
    const warns: string[] = [];
    const log = { ...quiet, warn: (m: string) => void warns.push(m) };
    const after = new CatalogUpdateService({ seedDir: seed, stateDir, url: URL_BASE, fetcher: server.fetcher, clock: systemClock, log, keys: TEST_KEYS });
    expect(after.activeDir()).toBe(seed);
    expect(warns).toEqual(['the downloaded app catalog 100 is not signed (its catalog.json is not signed (no catalog.json.sig)); using the catalog bundled with Harbor']);
    // signed by a key this Harbor does not pin, or garbage
    writeFileSync(sigFile, signDetached(readFileSync(path.join(root, '100', 'catalog.json')), testKeyPair('stranger-FIXTURE').privatePem));
    expect(after.activeDir()).toBe(seed);
    writeFileSync(sigFile, 'x'.repeat(5000));
    expect(after.activeDir()).toBe(seed);
    writeFileSync(sigFile, good);
    expect(after.activeDir()).toBe(path.join(root, '100'));
    // the real pinned keys never accept a test-signed folder
    expect(new CatalogUpdateService({ seedDir: seed, stateDir, url: URL_BASE, fetcher: server.fetcher, clock: systemClock, log: quiet }).activeDir()).toBe(seed);
    // with the folder retired, the next check downloads the signed bundle again (compared with the seed)
    rmSync(sigFile);
    expect(await after.refresh()).toMatchObject({ serial: 100, origin: 'downloaded', error: null });
    expect(readFileSync(sigFile)).toEqual(good);
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

  it('a release published halfway through a check cannot mix two bundles: the files come from the tag resolved first', async () => {
    const { svc, server, base } = setup();
    const older = buildBundle(bumpRevision(base, 'excalidraw', '2'), { serial: 100 });
    const newer = buildBundle(bumpRevision(base, 'excalidraw', '3'), { serial: 200 });
    server.publish(older);
    // the newer release lands right after the lookup of releases/latest
    server.fetcher.routes.unshift({
      match: (u) => u === `${RELEASES}/latest` && server.latest === 100,
      reply: () => {
        server.publish(newer);
        return redirect(`${RELEASES}/tag/c100`);
      },
    });
    expect(await svc.refresh()).toMatchObject({ serial: 100, origin: 'downloaded', error: null });
    expect(server.fetcher.requests.filter((r) => r.url.includes('/download/')).every((r) => r.url.includes('/download/c100/'))).toBe(true);
    // the next check takes the newer one
    expect(await svc.refresh()).toMatchObject({ serial: 200, error: null });
  });

  it('one deadline for the whole check: each step gets at most what is left of it', async () => {
    let t = 0;
    const timeouts: Record<string, number[]> = {};
    const server = new BundleServer();
    const fetcher = {
      async fetch(url: string, opts: { timeoutMs?: number } = {}) {
        const name = url.split('/').pop()!;
        (timeouts[name] ??= []).push(opts.timeoutMs ?? -1);
        t += 50_000; // every request takes 50 s
        return server.fetcher.fetch(url);
      },
    };
    const { svc, base } = setup({ fetcher, monotonicMs: () => t });
    server.publish(buildBundle(bumpRevision(base, 'excalidraw', '2'), { serial: 100 }));
    expect(await svc.refresh()).toMatchObject({ serial: 100, error: null });
    expect(timeouts).toEqual({ latest: [30_000], 'catalog.json': [30_000], 'catalog.json.sig': [30_000], 'catalog.zip': [CHECK_DEADLINE_MS - 150_000] });

    // no time left before the archive: the check stops with that reason (the CLI never waits past its own limit)
    t = 0;
    const slow = { async fetch(url: string) { t += CHECK_DEADLINE_MS / 3 + 1; return server.fetcher.fetch(url); } };
    const { svc: svc2, base: base2 } = setup({ fetcher: slow, monotonicMs: () => t });
    server.publish(buildBundle(bumpRevision(base2, 'excalidraw', '2'), { serial: 100 }));
    expect((await svc2.refresh()).error).toBe(`the app catalog check took longer than ${CHECK_DEADLINE_MS / 1000} s (stopped before catalog.zip); Harbor tries again at the next check`);
  });
});
