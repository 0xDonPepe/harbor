import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalogBundle } from '../../scripts/catalog-bundle-build.js';
import { extractCatalog, fetchCatalogBundle } from '../../scripts/catalog-fetch.mjs';
import { verifyCatalog } from '../../scripts/catalog-verify-lib.js';
import * as bundleLib from '../../src/packages/catalog-bundle.js';
import { openBundle, parseBundleMeta } from '../../src/packages/catalog-bundle.js';
import * as catalogLib from '../../src/packages/catalog.js';
import { listCatalog, readCatalogIndex } from '../../src/packages/catalog.js';
import { CATALOG_INDEX_SCHEMA } from '../../src/contracts/release.schema.js';
import type { HarborFeature } from '../../src/packages/features.js';
import { cloneCatalog, DIGEST_A, MINIMAL_COMPOSE, MINIMAL_MANIFEST, REPO_CATALOG, tempDir, writePackage } from './helpers.js';

// Decision 158: the harbor-apps CI bundles its apps/ folder with scripts/catalog-bundle.ts and signs the
// metadata. A throwaway key stands in for the CI secret here.
const SERIAL = 1_791_000_000;
const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
function throwawayKey(): { publicKey: string; signMeta: (meta: Buffer) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), signMeta: (meta) => sign(null, meta, privateKey).toString('base64') };
}
const ROOT = path.resolve(import.meta.dirname, '../..');
function runScript(script: string, args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, INIT_CWD: ROOT } });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('catalog bundle build (decision 158)', () => {
  it('bundles every index package; the signed result opens with the same bytes Harbor would load', () => {
    const built = buildCatalogBundle(REPO_CATALOG, { commit: COMMIT, serial: SERIAL });
    const ids = Object.keys(readCatalogIndex(REPO_CATALOG).packages).sort();
    expect(built.packages.map((p) => p.id)).toEqual(ids);
    expect(parseBundleMeta(built.meta)).toEqual({ schemaVersion: 1, serial: SERIAL, commit: COMMIT, createdAt: new Date(SERIAL * 1000).toISOString(), zip: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: built.zip.length }, packages: ids.length });
    const key = throwawayKey();
    const { files, meta } = openBundle({ meta: built.meta, sig: key.signMeta(built.meta), zip: built.zip }, [key.publicKey]);
    expect(meta.serial).toBe(SERIAL);
    const names = [...files.keys()];
    expect(names).toEqual([...names].sort());
    // re-written (decision 159: minHarbor is stamped), same entries; nothing in the fixtures needs a minimum
    expect(JSON.parse(files.get('index.json')!.toString('utf8'))).toEqual(readCatalogIndex(REPO_CATALOG));
    for (const id of ids) for (const f of ['manifest.yaml', 'compose.yaml', 'README.md', 'release.json']) expect(files.get(`${id}/${f}`), `${id}/${f}`).toEqual(readFileSync(path.join(REPO_CATALOG, id, f)));
    expect(files.get('excalidraw/icon.svg')).toEqual(readFileSync(path.join(REPO_CATALOG, 'excalidraw', 'icon.svg')));
    expect(names.some((n) => n.startsWith('README') || n.includes('..'))).toBe(false); // the catalog README is not a package file
    // the same checkout always gives the same bytes
    expect(buildCatalogBundle(REPO_CATALOG, { commit: COMMIT, serial: SERIAL }).zip.equals(built.zip)).toBe(true);
  });

  it('leaves out stray files and folders the index does not list', () => {
    const dir = cloneCatalog();
    writeFileSync(path.join(dir, 'excalidraw', 'notes.txt'), 'scratch');
    writePackage(dir, 'demo', { manifest: MINIMAL_MANIFEST, compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` } });
    const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
    delete index.packages.demo;
    writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
    const key = throwawayKey();
    const built = buildCatalogBundle(dir, { commit: COMMIT, serial: SERIAL });
    const { files } = openBundle({ meta: built.meta, sig: key.signMeta(built.meta), zip: built.zip }, [key.publicKey]);
    expect([...files.keys()].filter((n) => n.includes('notes.txt') || n.startsWith('demo/'))).toEqual([]);
  });

  it('fails the whole bundle when one package does not validate, naming it', () => {
    const dir = cloneCatalog();
    writeFileSync(path.join(dir, 'memos', 'README.md'), readFileSync(path.join(dir, 'memos', 'README.md'), 'utf8') + '\nedited without a hash refresh\n');
    expect(() => buildCatalogBundle(dir, { commit: COMMIT, serial: SERIAL })).toThrow(/memos: .*README.md hash mismatch/);
    expect(() => buildCatalogBundle(REPO_CATALOG, { commit: COMMIT, serial: 0 })).toThrow(/serial/);
    expect(() => buildCatalogBundle(REPO_CATALOG, { commit: 'not-a-sha', serial: SERIAL })).toThrow(/commit/);
  });

  it('the CLI writes the zip and unsigned metadata, and drops a stale signature', () => {
    const out = tempDir('harbor-bundle-');
    writeFileSync(path.join(out, 'catalog.json.sig'), 'old');
    const r = runScript('catalog-bundle.ts', [REPO_CATALOG, '--out', out, '--commit', COMMIT, '--serial', String(SERIAL)]);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(path.join(out, 'catalog.json.sig'))).toBe(false);
    expect(parseBundleMeta(readFileSync(path.join(out, 'catalog.json'))).zip.bytes).toBe(readFileSync(path.join(out, 'catalog.zip')).length);
    rmSync(out, { recursive: true, force: true });
    const bad = cloneCatalog();
    writeFileSync(path.join(bad, 'n8n', 'compose.yaml'), readFileSync(path.join(bad, 'n8n', 'compose.yaml'), 'utf8') + '\n');
    const out2 = tempDir('harbor-bundle-');
    const f = runScript('catalog-bundle.ts', [bad, '--out', out2, '--commit', COMMIT, '--serial', String(SERIAL)]);
    expect(f.code).toBe(1);
    expect(f.out).toMatch(/n8n: .*compose.yaml hash mismatch/);
    expect(existsSync(path.join(out2, 'catalog.zip'))).toBe(false);
  });

  it('catalog-hash --check lists stale packages and writes nothing', () => {
    const dir = cloneCatalog();
    expect(runScript('catalog-hash.ts', ['--catalog', dir, '--check']).code).toBe(0);
    const readme = path.join(dir, 'jellyfin', 'README.md');
    writeFileSync(readme, readFileSync(readme, 'utf8') + '\nedited\n');
    const before = readFileSync(path.join(dir, 'jellyfin', 'release.json'));
    const r = runScript('catalog-hash.ts', ['--catalog', dir, '--check']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/stale for: jellyfin\b/);
    expect(readFileSync(path.join(dir, 'jellyfin', 'release.json'))).toEqual(before);
    expect(runScript('catalog-hash.ts', ['--catalog', dir, 'jellyfin']).code).toBe(0);
    expect(runScript('catalog-hash.ts', ['--catalog', dir, '--check']).code).toBe(0);
  });

  it('extracts a fetched bundle into a catalog that verifies (scripts/catalog-fetch.mjs, local bundle + test key)', async () => {
    const key = throwawayKey();
    const built = buildCatalogBundle(REPO_CATALOG, { commit: COMMIT, serial: SERIAL });
    const src = tempDir('harbor-fetch-src-');
    writeFileSync(path.join(src, 'catalog.zip'), built.zip);
    writeFileSync(path.join(src, 'catalog.json'), built.meta);
    writeFileSync(path.join(src, 'catalog.json.sig'), key.signMeta(built.meta));
    const fetched = await fetchCatalogBundle(bundleLib, { HARBOR_CATALOG_BUNDLE: src, HARBOR_CATALOG_PUBLIC_KEY: key.publicKey });
    expect(fetched.official).toBe(false);
    const out = tempDir('harbor-fetch-out-');
    const index = extractCatalog(out, fetched, { bundleLib, catalogLib });
    expect(index).toEqual(readCatalogIndex(REPO_CATALOG));
    expect(readFileSync(path.join(out, 'catalog.json'))).toEqual(built.meta);
    expect(verifyCatalog(out).failed).toBe(0);
    // a bundle signed by any other key is refused before anything is extracted
    await expect(fetchCatalogBundle(bundleLib, { HARBOR_CATALOG_BUNDLE: src, HARBOR_CATALOG_PUBLIC_KEY: throwawayKey().publicKey })).rejects.toThrow(/signature does not verify/);
  });
});

// Decision 159 with an injected feature table: pretend `command` (decision 123) first arrived in 0.29.0.
describe('automatic minHarbor (decision 159)', () => {
  const TABLE: HarborFeature[] = [{ path: 'compose.services.*.command', since: '0.29.0', note: 'pretend' }];
  function catalogWithCommand(declared?: string): string {
    const dir = cloneCatalog();
    writePackage(dir, 'demo', { manifest: MINIMAL_MANIFEST, compose: MINIMAL_COMPOSE + '    command: ["serve"]\n', images: { web: `example/demo@${DIGEST_A}` } });
    if (declared) {
      const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
      index.packages.demo.minHarbor = declared;
      writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
    }
    return dir;
  }

  it('the bundle stamps the computed minimum; an older Harbor lists the app as unavailable', () => {
    const built = buildCatalogBundle(catalogWithCommand(), { commit: COMMIT, serial: SERIAL, features: TABLE });
    expect(built.packages.find((p) => p.id === 'demo')?.minHarbor).toBe('0.29.0');
    expect(built.packages.filter((p) => p.minHarbor).map((p) => p.id)).toEqual(['demo']);
    const key = throwawayKey();
    const { files } = openBundle({ meta: built.meta, sig: key.signMeta(built.meta), zip: built.zip }, [key.publicKey]);
    const index = JSON.parse(files.get('index.json')!.toString('utf8'));
    expect(index.packages.demo).toEqual({ revision: '1', dir: 'demo', minHarbor: '0.29.0' });
    expect(Object.keys(index.packages.demo)).toEqual(['dir', 'minHarbor', 'revision']); // sorted: deterministic bytes
    expect(index.packages.memos.minHarbor).toBeUndefined();
    const box = tempDir('harbor-box-catalog-');
    for (const [name, bytes] of files) {
      mkdirSync(path.dirname(path.join(box, name)), { recursive: true });
      writeFileSync(path.join(box, name), bytes);
    }
    const old = listCatalog(box, 'bundled', { harborVersion: '0.28.0' });
    expect(old.find((i) => i.id === 'demo')).toMatchObject({ availability: 'unavailable', reason: 'needs Harbor 0.29.0 or newer', name: 'Demo' });
    expect(old.filter((i) => i.availability === 'unavailable').map((i) => i.id)).toEqual(['demo']);
    expect(listCatalog(box, 'bundled', { harborVersion: '0.29.0' }).find((i) => i.id === 'demo')?.availability).toBe('available');
    // the same checkout still gives the same bytes
    expect(buildCatalogBundle(catalogWithCommand(), { commit: COMMIT, serial: SERIAL, features: TABLE }).zip.equals(built.zip)).toBe(true);
  });

  it('copies every index entry field (sorted keys) instead of rebuilding the entry', () => {
    const dir = catalogWithCommand('0.28.0');
    const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
    index.packages.memos = { minHarbor: '0.28.0', dir: index.packages.memos.dir, revision: index.packages.memos.revision };
    writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
    const built = buildCatalogBundle(dir, { commit: COMMIT, serial: SERIAL, features: TABLE });
    const key = throwawayKey();
    const stamped = JSON.parse(openBundle({ meta: built.meta, sig: key.signMeta(built.meta), zip: built.zip }, [key.publicKey]).files.get('index.json')!.toString('utf8'));
    const fields = Object.keys(CATALOG_INDEX_SCHEMA.properties.packages.additionalProperties.properties).sort();
    expect(Object.keys(stamped.packages.memos)).toEqual(fields); // every field the index format has makes it through
    expect(stamped.packages.memos).toEqual(index.packages.memos);
    expect(Object.keys(stamped.packages.demo)).toEqual(fields);
    expect(stamped.packages.demo.minHarbor).toBe('0.29.0');
  });

  it('release.json counts too: a release field or value newer than the baseline stamps minHarbor', () => {
    const table: HarborFeature[] = [{ path: 'release.qualification.status', value: 'pending', since: '0.29.1', note: 'pretend pending is new' }];
    const dir = catalogWithCommand();
    expect(buildCatalogBundle(dir, { commit: COMMIT, serial: SERIAL, features: table }).packages.find((p) => p.id === 'demo')?.minHarbor).toBe('0.29.1');
    expect(verifyCatalog(dir, { features: table }).lines.find((l) => l.includes(' demo@'))).toMatch(/minHarbor declared=none computed=0\.29\.1/);
  });

  it('the CLI prints one ok line per app: id@revision, then (version) and minHarbor=<v> when set', () => {
    const out = tempDir('harbor-bundle-');
    const r = runScript('catalog-bundle.ts', [catalogWithCommand('0.28.0'), '--out', out, '--commit', COMMIT, '--serial', String(SERIAL)]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/^ok {3}demo@1 minHarbor=0\.28\.0$/m);
    expect(r.out).toMatch(/^ok {3}memos@\S+( \(\S+\))?$/m); // no minHarbor token when there is none
  });

  it('a higher declared minimum wins over the computed one', () => {
    const built = buildCatalogBundle(catalogWithCommand('0.30.0'), { commit: COMMIT, serial: SERIAL, features: TABLE });
    expect(built.packages.find((p) => p.id === 'demo')?.minHarbor).toBe('0.30.0');
  });

  it('verify reports declared vs computed and fails a declared minimum below the computed one', () => {
    const ok = verifyCatalog(catalogWithCommand(), { features: TABLE });
    expect(ok.failed).toBe(0);
    expect(ok.lines.find((l) => l.includes(' demo@'))).toMatch(/minHarbor declared=none computed=0\.29\.0/);
    expect(verifyCatalog(catalogWithCommand('0.29.0'), { features: TABLE }).failed).toBe(0);
    const low = verifyCatalog(catalogWithCommand('0.28.0'), { features: TABLE });
    expect(low.failed).toBe(1);
    expect(low.lines.find((l) => l.startsWith('FAIL'))).toMatch(/^FAIL demo: index.json declares minHarbor 0\.28\.0 but the package uses compose\.services\.\*\.command \(0\.29\.0\): raise it to 0\.29\.0/);
    expect(verifyCatalog(catalogWithCommand('0.28.0')).failed).toBe(0); // the real table: command is baseline
  });

  it('the verify CLI prints declared vs computed (the real table: nothing beyond the baseline yet)', () => {
    const r = runScript('catalog-verify.ts', [catalogWithCommand('0.28.0'), '--quiet']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/ok {3}demo@1 .*minHarbor declared=0\.28\.0 computed=none/);
  });
});
