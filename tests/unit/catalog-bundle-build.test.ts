import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalogBundle } from '../../scripts/catalog-bundle-build.js';
import { extractCatalog, fetchCatalogBundle } from '../../scripts/catalog-fetch.mjs';
import { planCatalog, verifyCatalog } from '../../scripts/catalog-verify-lib.js';
import * as bundleLib from '../../src/packages/catalog-bundle.js';
import { openBundle, parseBundleMeta } from '../../src/packages/catalog-bundle.js';
import * as catalogLib from '../../src/packages/catalog.js';
import { listCatalog, readCatalogIndex } from '../../src/packages/catalog.js';
import { CATALOG_INDEX_SCHEMA } from '../../src/contracts/release.schema.js';
import { cloneCatalog, DIGEST_A, MINIMAL_COMPOSE, MINIMAL_MANIFEST, REPO_CATALOG, tempDir, writePackage } from './helpers.js';

// Decision 158: the harbor-apps CI bundles its apps/ folder with scripts/catalog-bundle.ts and publishes
// catalog.zip + catalog.json as release assets (no signature).
const SERIAL = 1_791_000_000;
const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const ROOT = path.resolve(import.meta.dirname, '../..');
function runScript(script: string, args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, INIT_CWD: ROOT } });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('catalog bundle build (decision 158)', () => {
  it('bundles every index package; the result opens with the same bytes Harbor would load', () => {
    const built = buildCatalogBundle(REPO_CATALOG, { commit: COMMIT, serial: SERIAL });
    const ids = Object.keys(readCatalogIndex(REPO_CATALOG).packages).sort();
    expect(built.packages.map((p) => p.id)).toEqual(ids);
    expect(parseBundleMeta(built.meta)).toEqual({ schemaVersion: 1, serial: SERIAL, commit: COMMIT, createdAt: new Date(SERIAL * 1000).toISOString(), zip: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: built.zip.length }, packages: ids.length });
    const { files, meta } = openBundle({ meta: built.meta, zip: built.zip });
    expect(meta.serial).toBe(SERIAL);
    const names = [...files.keys()];
    expect(names).toEqual([...names].sort());
    // re-written (decision 161: minHarbor comes from the manifest), same entries; no fixture declares a minimum
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
    const built = buildCatalogBundle(dir, { commit: COMMIT, serial: SERIAL });
    const { files } = openBundle({ meta: built.meta, zip: built.zip });
    expect([...files.keys()].filter((n) => n.includes('notes.txt') || n.startsWith('demo/'))).toEqual([]);
  });

  it('fails the whole bundle when one package does not validate, naming it', () => {
    const dir = cloneCatalog();
    writeFileSync(path.join(dir, 'memos', 'README.md'), readFileSync(path.join(dir, 'memos', 'README.md'), 'utf8') + '\nedited without a hash refresh\n');
    expect(() => buildCatalogBundle(dir, { commit: COMMIT, serial: SERIAL })).toThrow(/memos: .*README.md hash mismatch/);
    expect(() => buildCatalogBundle(REPO_CATALOG, { commit: COMMIT, serial: 0 })).toThrow(/serial/);
    expect(() => buildCatalogBundle(REPO_CATALOG, { commit: 'not-a-sha', serial: SERIAL })).toThrow(/commit/);
  });

  it('the CLI writes the zip and its catalog.json', () => {
    const out = tempDir('harbor-bundle-');
    const r = runScript('catalog-bundle.ts', [REPO_CATALOG, '--out', out, '--commit', COMMIT, '--serial', String(SERIAL)]);
    expect(r.code, r.out).toBe(0);
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

  it('extracts a fetched bundle into a catalog that verifies (scripts/catalog-fetch.mjs, local bundle)', async () => {
    const built = buildCatalogBundle(REPO_CATALOG, { commit: COMMIT, serial: SERIAL });
    const src = tempDir('harbor-fetch-src-');
    writeFileSync(path.join(src, 'catalog.zip'), built.zip);
    writeFileSync(path.join(src, 'catalog.json'), built.meta);
    const fetched = await fetchCatalogBundle(bundleLib, { HARBOR_CATALOG_BUNDLE: src });
    expect(fetched.official).toBe(false);
    const out = tempDir('harbor-fetch-out-');
    const index = extractCatalog(out, fetched, { bundleLib, catalogLib });
    expect(index).toEqual(readCatalogIndex(REPO_CATALOG));
    expect(readFileSync(path.join(out, 'catalog.json'))).toEqual(built.meta);
    expect(existsSync(path.join(out, 'catalog.json.sig'))).toBe(false);
    expect(verifyCatalog(out).failed).toBe(0);
    // a zip that does not match its catalog.json (one flipped byte) is refused before anything is extracted
    const bad = tempDir('harbor-fetch-bad-');
    const flipped = Buffer.from(built.zip);
    const mid = Math.floor(flipped.length / 2);
    flipped[mid] = flipped[mid]! ^ 0xff;
    writeFileSync(path.join(bad, 'catalog.zip'), flipped);
    writeFileSync(path.join(bad, 'catalog.json'), built.meta);
    await expect(fetchCatalogBundle(bundleLib, { HARBOR_CATALOG_BUNDLE: bad })).rejects.toThrow(/does not match its catalog\.json checksum/);
  });
});

// Decision 161: each app declares release.minHarbor in its manifest; the bundle copies it into index.json.
describe('declared minHarbor (decision 161)', () => {
  const withMin = (v: string) => MINIMAL_MANIFEST.replace('  revision: "1"\n', `  revision: "1"\n  minHarbor: "${v}"\n`);
  const setIndexMin = (dir: string, id: string, v: string) => {
    const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
    index.packages[id].minHarbor = v;
    writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  };
  function catalogWith(declared?: string, extra: Record<string, string> = {}): string {
    const dir = cloneCatalog();
    writePackage(dir, 'demo', { manifest: declared ? withMin(declared) : MINIMAL_MANIFEST, compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` } });
    for (const [id, v] of Object.entries(extra)) writePackage(dir, id, { manifest: withMin(v).replace('id: demo', `id: ${id}`), compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` } });
    return dir;
  }

  it('the bundle copies the manifest value into the index entry; a 0.28.0 box lists the app as unavailable', () => {
    const built = buildCatalogBundle(catalogWith('0.28.2'), { commit: COMMIT, serial: SERIAL });
    expect(built.packages.find((p) => p.id === 'demo')?.minHarbor).toBe('0.28.2');
    expect(built.packages.filter((p) => p.minHarbor).map((p) => p.id)).toEqual(['demo']);
    const { files } = openBundle({ meta: built.meta, zip: built.zip });
    const index = JSON.parse(files.get('index.json')!.toString('utf8'));
    expect(index.packages.demo).toEqual({ revision: '1', dir: 'demo', minHarbor: '0.28.2' });
    expect(Object.keys(index.packages.demo)).toEqual(['dir', 'minHarbor', 'revision']); // sorted: deterministic bytes
    expect(index.packages.memos.minHarbor).toBeUndefined();
    const box = tempDir('harbor-box-catalog-');
    for (const [name, bytes] of files) {
      mkdirSync(path.dirname(path.join(box, name)), { recursive: true });
      writeFileSync(path.join(box, name), bytes);
    }
    // 0.28.0 only reads the index entry (it would refuse the manifest field itself)
    const old = listCatalog(box, 'bundled', { harborVersion: '0.28.0' });
    expect(old.find((i) => i.id === 'demo')).toMatchObject({ availability: 'unavailable', reason: 'needs Harbor 0.28.2 or newer' });
    expect(old.filter((i) => i.availability === 'unavailable').map((i) => i.id)).toEqual(['demo']);
    expect(listCatalog(box, 'bundled', { harborVersion: '0.28.1' }).find((i) => i.id === 'demo')?.reason).toBe('needs Harbor 0.28.2 or newer');
    expect(listCatalog(box, 'bundled', { harborVersion: '0.28.2' }).find((i) => i.id === 'demo')?.availability).toBe('available');
    expect(buildCatalogBundle(catalogWith('0.28.2'), { commit: COMMIT, serial: SERIAL }).zip.equals(built.zip)).toBe(true);
  });

  it('copies every index entry field (sorted keys); an index minHarbor must equal the manifest\'s', () => {
    const dir = catalogWith('0.29.0');
    setIndexMin(dir, 'demo', '0.29.0');
    const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
    index.packages.memos = { minHarbor: '0.28.0', dir: index.packages.memos.dir, revision: index.packages.memos.revision }; // = the default
    writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
    const built = buildCatalogBundle(dir, { commit: COMMIT, serial: SERIAL });
    const stamped = JSON.parse(openBundle({ meta: built.meta, zip: built.zip }).files.get('index.json')!.toString('utf8'));
    const fields = Object.keys(CATALOG_INDEX_SCHEMA.properties.packages.additionalProperties.properties).sort();
    expect(Object.keys(stamped.packages.demo)).toEqual(fields); // every field the index format has makes it through
    expect(stamped.packages.demo.minHarbor).toBe('0.29.0');
    expect(stamped.packages.memos).toEqual({ dir: 'memos', revision: index.packages.memos.revision }); // the default is not written
    setIndexMin(dir, 'demo', '0.30.0');
    expect(() => buildCatalogBundle(dir, { commit: COMMIT, serial: SERIAL })).toThrow(/demo: index\.json minHarbor 0\.30\.0 does not match the manifest's release\.minHarbor 0\.29\.0/);
    const noDecl = catalogWith();
    setIndexMin(noDecl, 'demo', '0.29.0');
    expect(() => buildCatalogBundle(noDecl, { commit: COMMIT, serial: SERIAL })).toThrow(/demo: index\.json minHarbor 0\.29\.0 does not match the manifest's release\.minHarbor \(none = 0\.28\.0\)/);
  });

  it('the CLI prints one ok line per app: id@revision, then (version) and minHarbor=<v> when declared', () => {
    const out = tempDir('harbor-bundle-');
    const r = runScript('catalog-bundle.ts', [catalogWith('0.28.2'), '--out', out, '--commit', COMMIT, '--serial', String(SERIAL)]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/^ok {3}demo@1 minHarbor=0\.28\.2$/m);
    expect(r.out).toMatch(/^ok {3}memos@\S+( \(\S+\))?$/m); // no minHarbor token when there is none
  });

  it('--summary writes {serial, commit, packages} as JSON, sorted by id, whatever the version text says', () => {
    const dir = catalogWith(undefined, { zeta: '0.30.0' });
    // release.version is free text: a log line could be misread, the JSON cannot
    writePackage(dir, 'demo', { manifest: MINIMAL_MANIFEST.replace('  revision: "1"\n', '  revision: "1"\n  version: "1) minHarbor=0.30.0 (x"\n'), compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` } });
    const out = tempDir('harbor-bundle-');
    const file = path.join(tempDir('harbor-summary-'), 'nested', 'summary.json');
    const r = runScript('catalog-bundle.ts', [dir, '--out', out, '--commit', COMMIT, '--serial', String(SERIAL), '--summary', file]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/^ok {3}demo@1 \(1\) minHarbor=0\.30\.0 \(x\)$/m); // the human log stays as it was
    const summary = JSON.parse(readFileSync(file, 'utf8')) as { serial: number; commit: string; packages: { id: string; revision: string; version: string | null; minHarbor: string | null }[] };
    expect(summary.serial).toBe(SERIAL);
    expect(summary.commit).toBe(COMMIT);
    const ids = summary.packages.map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual([...Object.keys(readCatalogIndex(REPO_CATALOG).packages), 'demo', 'zeta'].sort());
    expect(summary.packages.find((p) => p.id === 'demo')).toEqual({ id: 'demo', revision: '1', version: '1) minHarbor=0.30.0 (x', minHarbor: null });
    expect(summary.packages.find((p) => p.id === 'zeta')).toEqual({ id: 'zeta', revision: '1', version: null, minHarbor: '0.30.0' });
    for (const p of summary.packages) expect(Object.keys(p)).toEqual(['id', 'revision', 'version', 'minHarbor']);
    // a typo or a missing value is a usage error, not a silently skipped summary
    expect(runScript('catalog-bundle.ts', [dir, '--out', out, '--commit', COMMIT, '--serial', String(SERIAL), '--sumary', file]).code).toBe(2);
    expect(runScript('catalog-bundle.ts', [dir, '--out', out, '--commit', COMMIT, '--serial', String(SERIAL), '--summary']).code).toBe(2);
  });

  it('verify prints the declared minimum and fails an invalid declaration', () => {
    const ok = verifyCatalog(catalogWith('0.28.2'));
    expect(ok.failed).toBe(0);
    expect(ok.lines.find((l) => l.includes(' demo@'))).toMatch(/minHarbor=0\.28\.2 /);
    expect(ok.lines.find((l) => l.includes(' memos@'))).toMatch(/minHarbor=0\.28\.0\(default\) /);
    const low = verifyCatalog(catalogWith('0.28.0'));
    expect(low.failed).toBe(1);
    expect(low.lines.find((l) => l.startsWith('FAIL'))).toMatch(/^FAIL demo: .*release\.minHarbor 0\.28\.0 must be 0\.28\.2 or newer/);
    expect(verifyCatalog(catalogWith('0.28')).lines.find((l) => l.startsWith('FAIL'))).toMatch(/^FAIL demo: .*minHarbor.*must match pattern/);
    const mismatch = catalogWith('0.28.2');
    setIndexMin(mismatch, 'demo', '0.28.3');
    expect(verifyCatalog(mismatch).lines.find((l) => l.startsWith('FAIL'))).toMatch(/^FAIL demo: index\.json minHarbor 0\.28\.3 does not match/);
    const r = runScript('catalog-verify.ts', [catalogWith('0.28.2'), '--quiet']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/ok {3}demo@1 .*minHarbor=0\.28\.2 /);
  });

  it('plan groups the apps by declared minimum (absent = 0.28.0), versions and ids sorted', () => {
    const dir = catalogWith('0.30.0', { zeta: '0.28.2', alpha: '0.30.0', beta: '0.100.0' });
    const plan = planCatalog(dir);
    const fixtures = Object.keys(readCatalogIndex(REPO_CATALOG).packages).sort();
    expect(plan).toEqual({ groups: [
      { minHarbor: '0.28.0', ids: fixtures },
      { minHarbor: '0.28.2', ids: ['zeta'] },
      { minHarbor: '0.30.0', ids: ['alpha', 'demo'] },
      { minHarbor: '0.100.0', ids: ['beta'] }, // numeric, not string order
    ] });
  });

  it('plan refuses an invalid declaration or a package that does not load', () => {
    expect(() => planCatalog(catalogWith('0.28.0'))).toThrow(/demo: .*release\.minHarbor 0\.28\.0 must be 0\.28\.2 or newer/);
    expect(() => planCatalog(catalogWith('1.2'))).toThrow(/demo: .*must match pattern/);
    const mismatch = catalogWith('0.28.2');
    setIndexMin(mismatch, 'demo', '0.28.0');
    expect(() => planCatalog(mismatch)).toThrow(/demo: index\.json minHarbor 0\.28\.0 does not match/);
    const broken = catalogWith('0.28.2');
    writeFileSync(path.join(broken, 'memos', 'README.md'), 'edited\n');
    expect(() => planCatalog(broken)).toThrow(/memos: .*README\.md hash mismatch/);
  });

  it('the plan CLI prints the JSON on stdout and exits 1 with the reason on stderr', () => {
    const run = (dir: string) => spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'catalog-plan.ts'), dir], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, INIT_CWD: ROOT } });
    const ok = run(catalogWith('0.28.2'));
    expect(ok.status, ok.stderr).toBe(0);
    const plan = JSON.parse(ok.stdout) as { groups: { minHarbor: string; ids: string[] }[] };
    expect(plan.groups.map((g) => g.minHarbor)).toEqual(['0.28.0', '0.28.2']);
    expect(plan.groups[1]!.ids).toEqual(['demo']);
    const bad = run(catalogWith('0.27.9'));
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toMatch(/demo: .*release\.minHarbor 0\.27\.9 must be 0\.28\.2 or newer/);
  });
});
