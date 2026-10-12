import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalogBundle } from '../../scripts/catalog-bundle-build.js';
import { openBundle, parseBundleMeta } from '../../src/packages/catalog-bundle.js';
import { readCatalogIndex } from '../../src/packages/catalog.js';
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
    expect(files.get('index.json')).toEqual(readFileSync(path.join(REPO_CATALOG, 'index.json')));
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
});
