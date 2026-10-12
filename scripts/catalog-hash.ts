// Editorial helper: recompute release.json file hashes for packages after editing their
// manifest/compose/README/assets. Runtime never calls this; it only verifies.
//   pnpm catalog:hash [--catalog <dir>] [<packageId>...] [--check]
// No ids = every package in the catalog index. --check writes nothing and exits 1 listing the stale
// packages (the harbor-apps CI gate). The catalog dir resolves as in scripts/catalog-dir.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../src/packages/inventory.js';
import { RELEASE_FILES } from '../src/contracts/release.schema.js';
import { readCatalogIndex } from '../src/packages/catalog.js';
import { catalogArg } from './catalog-dir.mjs';

let parsed: { rest: string[]; dir: string };
try {
  parsed = catalogArg(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const check = parsed.rest.includes('--check');
const unknownFlag = parsed.rest.find((a) => a.startsWith('--') && a !== '--check');
if (unknownFlag) { console.error(`usage: catalog-hash.ts [--catalog <dir>] [<packageId>...] [--check] (unknown ${unknownFlag})`); process.exit(2); }
const catalogDir = parsed.dir;
const index = readCatalogIndex(catalogDir);
const ids = parsed.rest.filter((a) => !a.startsWith('--'));
for (const id of ids) if (!index.packages[id]) { console.error(`${id}: not in ${path.join(catalogDir, 'index.json')}`); process.exit(2); }

// Returns the refreshed release.json and whether it differs from the one on disk.
function refresh(dir: string): { release: Record<string, unknown> & { files: Record<string, unknown>; assets?: unknown }; changed: boolean } {
  const release = JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8'));
  let changed = false;
  for (const f of RELEASE_FILES) {
    const h = sha256Hex(readFileSync(path.join(dir, f)));
    if (release.files[f]?.sha256 !== h) { changed = true; release.files[f] = { sha256: h }; }
  }
  // presentation assets referenced by the manifest
  const manifestText = readFileSync(path.join(dir, 'manifest.yaml'), 'utf8');
  const assetNames = [...manifestText.matchAll(/^\s*(?:icon:|-)\s*([a-z0-9][a-z0-9._-]*\.(?:svg|png|jpg|jpeg|webp))\s*$/gm)].map((m) => m[1]!);
  const assets: Record<string, { sha256: string }> = {};
  for (const name of assetNames) assets[name] = { sha256: sha256Hex(readFileSync(path.join(dir, name))) };
  if (JSON.stringify(release.assets ?? {}) !== JSON.stringify(assets)) {
    changed = true;
    if (assetNames.length) release.assets = assets;
    else delete release.assets;
  }
  return { release, changed };
}

const stale: string[] = [];
for (const id of ids.length ? ids : Object.keys(index.packages)) {
  const dir = path.join(catalogDir, index.packages[id]!.dir);
  const { release, changed } = refresh(dir);
  if (check) {
    if (changed) stale.push(id);
    else console.log(`${id}: hashes ok`);
  } else {
    writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release, null, 2) + '\n');
    console.log(`${id}: ${changed ? 'updated' : 'unchanged'}`);
  }
}
if (stale.length) {
  console.error(`release.json hashes are stale for: ${stale.join(', ')}\nrun: pnpm catalog:hash --catalog ${catalogDir} ${stale.join(' ')}`);
  process.exit(1);
}
