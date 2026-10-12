// Build the official catalog bundle (decision 158) from a catalog checkout: the zip and its catalog.json
// (sha256 + size of the zip: an integrity check, no signature).
// Every index-listed package must load exactly as the daemon loads it; one failure fails the bundle.
// Only the files the loader reads go in (four package files + presentation assets named by the manifest),
// so stray files and unlisted folders in the checkout never ship. No timestamps: the same checkout
// always gives the same bytes.
// Decision 159: index.json is re-written, not copied: each entry's minHarbor becomes max(declared, computed from
// the fields the package uses in manifest, compose and release.json, src/packages/features.ts), so authors normally
// never set it. Every other entry field is copied as is. Sorted keys, two-space JSON: still deterministic.
import type { CatalogIndex } from '../src/contracts/types.js';
import { BUNDLE_ZIP_LIMITS, MAX_BUNDLE_ZIP_BYTES, parseBundleMeta, type CatalogBundleMeta } from '../src/packages/catalog-bundle.js';
import { loadPackage, readCatalogIndex } from '../src/packages/catalog.js';
import { computeRequiredHarbor, FEATURES, maxHarbor, type HarborFeature } from '../src/packages/features.js';
import { sha256Hex } from '../src/packages/inventory.js';
import { readZip, writeZip } from '../src/packages/zip.js';

export interface BuiltBundle {
  zip: Buffer;
  meta: Buffer;
  parsed: CatalogBundleMeta;
  packages: { id: string; revision: string; version: string | null; minHarbor: string | null }[];
}

export function buildCatalogBundle(catalogDir: string, opts: { commit: string; serial: number; features?: readonly HarborFeature[] }): BuiltBundle {
  if (!Number.isSafeInteger(opts.serial) || opts.serial < 1) throw new Error(`serial must be a positive integer (unix seconds), got ${opts.serial}`);
  const index = readCatalogIndex(catalogDir);
  const files: Record<string, Buffer> = {};
  const stamped: CatalogIndex['packages'] = {};
  const packages: BuiltBundle['packages'] = [];
  const failures: string[] = [];
  for (const id of Object.keys(index.packages).sort()) {
    try {
      const pkg = loadPackage(catalogDir, id);
      const dir = index.packages[id]!.dir;
      files[`${dir}/manifest.yaml`] = pkg.raw.manifest;
      files[`${dir}/compose.yaml`] = pkg.raw.compose;
      files[`${dir}/README.md`] = pkg.raw.readme;
      files[`${dir}/release.json`] = pkg.raw.release;
      for (const [name, bytes] of Object.entries(pkg.assets)) files[`${dir}/${name}`] = bytes;
      const entry = index.packages[id]!;
      const minHarbor = maxHarbor(entry.minHarbor, computeRequiredHarbor({ manifest: pkg.manifest, compose: pkg.compose, release: pkg.release }, opts.features ?? FEATURES));
      // a copy, so an index field added later is never dropped; only minHarbor is overridden; sorted keys
      const copy: Record<string, unknown> = { ...entry, ...(minHarbor ? { minHarbor } : {}) };
      stamped[id] = Object.fromEntries(Object.keys(copy).sort().map((k) => [k, copy[k]])) as CatalogIndex['packages'][string];
      packages.push({ id, revision: pkg.revision, version: pkg.manifest.release.version ?? null, minHarbor });
    } catch (e) {
      failures.push(`${id}: ${(e as Error).message}`);
    }
  }
  if (failures.length) throw new Error(`the catalog does not validate, no bundle was written:\n  ${failures.join('\n  ')}`);
  files['index.json'] = Buffer.from(JSON.stringify({ schemaVersion: index.schemaVersion, packages: stamped }, null, 2) + '\n');
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]!]));
  const zip = writeZip(sorted);
  if (zip.length > MAX_BUNDLE_ZIP_BYTES) throw new Error(`catalog.zip is ${zip.length} bytes; Harbor accepts at most ${MAX_BUNDLE_ZIP_BYTES}`);
  readZip(zip, BUNDLE_ZIP_LIMITS); // the same limits a Harbor box applies when it opens the bundle
  const value: CatalogBundleMeta = {
    schemaVersion: 1,
    serial: opts.serial,
    commit: opts.commit,
    createdAt: new Date(opts.serial * 1000).toISOString(),
    zip: { sha256: sha256Hex(zip), bytes: zip.length },
    packages: packages.length,
  };
  const meta = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  return { zip, meta, parsed: parseBundleMeta(meta), packages };
}
