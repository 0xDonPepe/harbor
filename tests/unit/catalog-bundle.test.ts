import { describe, expect, it } from 'vitest';
import { BUNDLE_FILES, OFFICIAL_CATALOG_URL, catalogDownloadBase, catalogReleasesBase, catalogTagFromLocation, openBundle, parseBundleMeta } from '../../src/packages/catalog-bundle.js';
import { writeZip } from '../../src/packages/zip.js';
import { buildBundle } from './bundle-helpers.js';

const INDEX = JSON.stringify({ schemaVersion: 1, packages: {} });

describe('official catalog bundles (decision 158)', () => {
  it('a bundle is two files, catalog.zip and catalog.json (no signature)', () => {
    expect(BUNDLE_FILES).toEqual({ zip: 'catalog.zip', meta: 'catalog.json' });
  });

  it('opens a bundle whose archive matches its catalog.json and returns its files', () => {
    const b = buildBundle({ 'index.json': INDEX, 'demo/README.md': '# demo\n' }, { serial: 1_760_000_000 });
    const { meta, files } = openBundle(b);
    expect(meta).toMatchObject({ schemaVersion: 1, serial: 1_760_000_000, packages: 0 });
    expect([...files.keys()].sort()).toEqual(['demo/README.md', 'index.json']);
  });

  it('refuses an archive that does not match the catalog.json checksum or size (truncated or mixed download)', () => {
    const b = buildBundle({ 'index.json': INDEX }, { serial: 5 });
    const other = writeZip({ 'index.json': INDEX, 'extra.txt': 'x' });
    expect(() => openBundle({ ...b, zip: other })).toThrow(/does not match its catalog\.json checksum/);
    const flipped = Buffer.from(b.zip);
    flipped[flipped.length - 30] = flipped[flipped.length - 30]! ^ 0xff;
    expect(() => openBundle({ ...b, zip: flipped })).toThrow(/does not match its catalog\.json checksum/);
    expect(() => openBundle({ ...b, zip: b.zip.subarray(0, b.zip.length - 1) })).toThrow(/does not match its catalog\.json checksum/);
    // the catalog.json of another release next to this archive
    const newer = buildBundle({ 'index.json': INDEX, 'demo/README.md': 'v2' }, { serial: 6 });
    expect(() => openBundle({ meta: newer.meta, zip: b.zip })).toThrow(/does not match its catalog\.json checksum/);
  });

  it('refuses metadata that breaks the schema, and an archive without index.json', () => {
    const good = { schemaVersion: 1, serial: 7, commit: 'abcdef0', createdAt: '2026-10-01T12:00:00Z', zip: { sha256: 'a'.repeat(64), bytes: 100 }, packages: 0 };
    for (const [patch, re] of [
      [{ schemaVersion: 2 }, /invalid/],
      [{ serial: 0 }, /invalid/],
      [{ serial: 1.5 }, /invalid/],
      [{ commit: 'NOT-HEX' }, /invalid/],
      [{ createdAt: 'yesterday' }, /invalid/],
      [{ zip: { sha256: 'short', bytes: 100 } }, /invalid/],
      [{ extra: true }, /invalid/],
    ] as const) {
      expect(() => parseBundleMeta(Buffer.from(JSON.stringify({ ...good, ...patch }))), JSON.stringify(patch)).toThrow(re);
    }
    expect(() => parseBundleMeta(Buffer.from('{nope'))).toThrow(/not JSON/);
    expect(() => openBundle({ meta: Buffer.from('{nope'), zip: writeZip({ 'index.json': INDEX }) })).toThrow(/not JSON/);
    expect(() => parseBundleMeta(Buffer.alloc(70 * 1024, 32))).toThrow(/exceeds/);
    const noIndex = buildBundle({ 'demo/README.md': '# demo\n', 'other/README.md': 'x' }, { serial: 9 });
    expect(() => openBundle(noIndex)).toThrow(/no index\.json/);
  });
});

// pnpm package resolves "latest" once and downloads both files from that fixed tag (no mixed bundle).
describe('catalog release tags', () => {
  const base = 'https://github.com/carlosalaniz/harbor-apps/releases';
  it('derives the releases base from a .../releases/latest/download URL', () => {
    expect(catalogReleasesBase(OFFICIAL_CATALOG_URL)).toBe(base);
    expect(catalogReleasesBase(`${base}/latest/download/`)).toBe(base);
    expect(() => catalogReleasesBase('https://example.test/catalog')).toThrow(/releases\/latest\/download/);
  });

  it('reads c<serial> from the Location of releases/latest and pins the download URL', () => {
    expect(catalogTagFromLocation(`${base}/tag/c1791000000`, base)).toBe(1_791_000_000);
    expect(catalogTagFromLocation('/carlosalaniz/harbor-apps/releases/tag/c42', base)).toBe(42); // relative Location
    expect(catalogDownloadBase(base, 42)).toBe(`${base}/download/c42`);
    for (const bad of [null, '', `${base}/tag/v0.28.0`, `${base}/tag/c`, `${base}/tag/c0`, `${base}/tag/c12x`, base, 'https://github.com/someone-else/harbor-apps/releases/tag/c42', `${base}/tag/c42/extra`]) {
      expect(() => catalogTagFromLocation(bad, base)).toThrow(/latest catalog release/);
    }
  });
});
