import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_CATALOG_PUBLIC_KEY, OFFICIAL_CATALOG_URL, catalogDownloadBase, catalogReleasesBase, catalogTagFromLocation, openBundle, parseBundleMeta, verifyBundleMeta, verifyBundleSignature } from '../../src/packages/catalog-bundle.js';
import { writeZip } from '../../src/packages/zip.js';
import { buildBundle, testSigner } from './bundle-helpers.js';

const INDEX = JSON.stringify({ schemaVersion: 1, packages: {} });

describe('official catalog bundles (decision 158)', () => {
  const signer = testSigner();
  const keys = [signer.publicKey];

  it('opens a bundle signed by a pinned key and returns its files', () => {
    const b = buildBundle({ 'index.json': INDEX, 'demo/README.md': '# demo\n' }, signer, { serial: 1_760_000_000 });
    const { meta, files } = openBundle(b, keys);
    expect(meta).toMatchObject({ schemaVersion: 1, serial: 1_760_000_000, packages: 0 });
    expect([...files.keys()].sort()).toEqual(['demo/README.md', 'index.json']);
    // any listed key may sign; surrounding whitespace in the .sig file is fine
    expect(openBundle({ ...b, sig: `\n${b.sig}\n` }, [testSigner().publicKey, signer.publicKey]).meta.serial).toBe(1_760_000_000);
  });

  it('refuses a bad signature, the wrong key, a malformed key and tampered metadata', () => {
    const b = buildBundle({ 'index.json': INDEX }, signer, { serial: 5 });
    expect(() => openBundle({ ...b, sig: Buffer.alloc(64, 1).toString('base64') }, keys)).toThrow(/signature does not verify/);
    expect(() => openBundle({ ...b, sig: 'not base64 at all' }, keys)).toThrow(/signature does not verify/);
    expect(() => openBundle(b, [testSigner().publicKey])).toThrow(/signature does not verify/);
    expect(() => openBundle(b, [OFFICIAL_CATALOG_PUBLIC_KEY])).toThrow(/signature does not verify/);
    expect(verifyBundleSignature(b.meta, b.sig, ['AAAA', 'bm90IGEga2V5'])).toBe(false);
    const tampered = Buffer.from(b.meta.toString('utf8').replace('"serial":5', '"serial":6'));
    expect(() => openBundle({ ...b, meta: tampered }, keys)).toThrow(/signature does not verify/);
    // a key of another type in the list is ignored, never an error
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(verifyBundleSignature(b.meta, b.sig, [ec])).toBe(false);
    expect(verifyBundleSignature(b.meta, b.sig, [])).toBe(false);
  });

  it('refuses an archive that does not match the signed checksum or size', () => {
    const b = buildBundle({ 'index.json': INDEX }, signer, { serial: 5 });
    const other = writeZip({ 'index.json': INDEX, 'extra.txt': 'x' });
    expect(() => openBundle({ ...b, zip: other }, keys)).toThrow(/does not match its signed checksum/);
    const flipped = Buffer.from(b.zip);
    flipped[flipped.length - 30] = flipped[flipped.length - 30]! ^ 0xff;
    expect(() => openBundle({ ...b, zip: flipped }, keys)).toThrow(/does not match its signed checksum/);
  });

  it('refuses signed metadata that breaks the schema, and an archive without index.json', () => {
    const resign = (meta: Record<string, unknown>) => {
      const bytes = Buffer.from(JSON.stringify(meta));
      return { bytes, sig: sign(null, bytes, signer.privateKey).toString('base64') };
    };
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
      const m = resign({ ...good, ...patch });
      expect(() => verifyBundleMeta(m.bytes, m.sig, keys), JSON.stringify(patch)).toThrow(re);
    }
    const notJson = Buffer.from('{nope');
    expect(() => verifyBundleMeta(notJson, sign(null, notJson, signer.privateKey).toString('base64'), keys)).toThrow(/not JSON/);
    expect(() => parseBundleMeta(Buffer.alloc(70 * 1024, 32))).toThrow(/exceeds/);
    const noIndex = buildBundle({ 'demo/README.md': '# demo\n', 'other/README.md': 'x' }, signer, { serial: 9 });
    expect(() => openBundle(noIndex, keys)).toThrow(/no index\.json/);
  });
});

// pnpm package resolves "latest" once and downloads all three files from that fixed tag (no mixed bundle).
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
