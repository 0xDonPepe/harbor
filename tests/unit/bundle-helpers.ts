import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../../src/packages/inventory.js';
import { writeZip } from '../../src/packages/zip.js';

// Signed catalog bundles for tests (decision 158). Keys are generated per test run: nothing here is a
// real signing key, and the official public key never verifies these bundles.

export interface TestSigner {
  publicKey: string; // SPKI DER, base64 (the config.catalog.publicKeys format)
  privateKey: KeyObject;
}

export function testSigner(): TestSigner {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
}

// Every file of a catalog directory (index.json + package folders), keyed by relative path.
export function catalogFiles(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (!rel && (name === 'catalog.json' || name === 'catalog.json.sig')) continue;
      if (statSync(path.join(dir, r)).isDirectory()) walk(r);
      else out[r] = readFileSync(path.join(dir, r));
    }
  };
  walk('');
  return out;
}

// Raise one package's revision in a catalog file map, keeping release.json hashes and index.json in step.
export function bumpRevision(files: Record<string, Buffer>, id: string, revision: string, opts: { minHarbor?: string } = {}): Record<string, Buffer> {
  const out = { ...files };
  const manifest = out[`${id}/manifest.yaml`]!.toString('utf8').replace(/revision: "[^"]+"/, `revision: "${revision}"`);
  out[`${id}/manifest.yaml`] = Buffer.from(manifest);
  const rel = JSON.parse(out[`${id}/release.json`]!.toString('utf8')) as { package: { revision: string }; files: Record<string, { sha256: string }> };
  rel.package.revision = revision;
  rel.files['manifest.yaml'] = { sha256: sha256Hex(Buffer.from(manifest)) };
  out[`${id}/release.json`] = Buffer.from(JSON.stringify(rel, null, 2));
  const index = JSON.parse(out['index.json']!.toString('utf8')) as { packages: Record<string, { revision: string; minHarbor?: string }> };
  index.packages[id]!.revision = revision;
  if (opts.minHarbor) index.packages[id]!.minHarbor = opts.minHarbor;
  out['index.json'] = Buffer.from(JSON.stringify(index, null, 2));
  return out;
}

export interface TestBundle {
  meta: Buffer;
  sig: string;
  zip: Buffer;
}

export function buildBundle(files: Record<string, Buffer | string>, signer: TestSigner, opts: { serial: number; commit?: string; createdAt?: string; metaPatch?: Record<string, unknown> }): TestBundle {
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]!]));
  const zip = writeZip(sorted);
  const index = JSON.parse(Buffer.from(files['index.json'] ?? '{"packages":{}}').toString('utf8')) as { packages?: Record<string, unknown> };
  const meta = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      serial: opts.serial,
      commit: opts.commit ?? 'abcdef0123456789abcdef0123456789abcdef01',
      createdAt: opts.createdAt ?? '2026-10-01T12:00:00Z',
      zip: { sha256: sha256Hex(zip), bytes: zip.length },
      packages: Object.keys(index.packages ?? {}).length,
      ...(opts.metaPatch ?? {}),
    }),
  );
  return { meta, sig: sign(null, meta, signer.privateKey).toString('base64'), zip };
}
