import { createPublicKey, verify } from 'node:crypto';
import { compile, formatErrors } from '../contracts/validate.js';
import { SHA256_HEX_PATTERN } from '../contracts/patterns.js';
import { HarborError } from '../errors.js';
import { sha256Hex } from './inventory.js';
import { readZip, type ZipLimits } from './zip.js';

// The official app catalog (decision 158) lives in its own repository (carlosalaniz/harbor-apps). Its CI
// publishes one bundle per change as three release assets:
//   catalog.zip       index.json + <id>/{manifest.yaml,compose.yaml,README.md,release.json,assets}
//   catalog.json      metadata below; the only signed bytes (it pins the zip by sha256 and size)
//   catalog.json.sig  base64 ed25519 signature over the exact catalog.json bytes
// Harbor trusts a bundle only when the signature verifies against a pinned public key. Pure: no I/O.

export const OFFICIAL_CATALOG_URL = 'https://github.com/carlosalaniz/harbor-apps/releases/latest/download';
// SPKI DER (base64) of the harbor-apps signing key. The private half is a CI secret of that repository.
export const OFFICIAL_CATALOG_PUBLIC_KEY = 'MCowBQYDK2VwAyEAOPBvp5o15hIL9coLYqT1I+FprDVBszRZuT8Sfx52HZM=';

export const BUNDLE_FILES = { zip: 'catalog.zip', meta: 'catalog.json', sig: 'catalog.json.sig' } as const;
export const BUNDLE_ZIP_LIMITS: ZipLimits = { maxEntries: 4096, maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 96 * 1024 * 1024 };
export const MAX_BUNDLE_ZIP_BYTES = 96 * 1024 * 1024;
export const MAX_BUNDLE_META_BYTES = 64 * 1024;

export interface CatalogBundleMeta {
  schemaVersion: 1;
  // monotonic: the committer time (unix seconds) of the catalog commit; a bundle never replaces a newer one
  serial: number;
  commit: string;
  createdAt: string;
  zip: { sha256: string; bytes: number };
  packages: number;
}

const META_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'serial', 'commit', 'createdAt', 'zip', 'packages'],
  properties: {
    schemaVersion: { const: 1 },
    serial: { type: 'integer', minimum: 1 },
    commit: { type: 'string', pattern: '^[a-f0-9]{7,64}$' },
    createdAt: { type: 'string', format: 'date-time' },
    zip: {
      type: 'object',
      additionalProperties: false,
      required: ['sha256', 'bytes'],
      properties: { sha256: { type: 'string', pattern: SHA256_HEX_PATTERN }, bytes: { type: 'integer', minimum: 22, maximum: MAX_BUNDLE_ZIP_BYTES } },
    },
    packages: { type: 'integer', minimum: 0 },
  },
} as const;

export function parseBundleMeta(bytes: Buffer, label = BUNDLE_FILES.meta): CatalogBundleMeta {
  if (bytes.length > MAX_BUNDLE_META_BYTES) throw new HarborError('INVALID_PACKAGE', `${label} exceeds ${MAX_BUNDLE_META_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw new HarborError('INVALID_PACKAGE', `${label} is not JSON: ${(e as Error).message}`);
  }
  const validate = compile<CatalogBundleMeta>(META_SCHEMA);
  if (!validate(value)) throw new HarborError('INVALID_PACKAGE', `${label} invalid: ${formatErrors(validate.errors)[0]}`, { details: formatErrors(validate.errors) });
  return value;
}

// True when `signature` (base64, surrounding whitespace ignored) is a valid ed25519 signature of `meta`
// by any of `publicKeys` (SPKI DER, base64). Never throws on a malformed signature or key: that is "no".
export function verifyBundleSignature(meta: Buffer, signature: string, publicKeys: readonly string[]): boolean {
  const sig = Buffer.from(signature.trim(), 'base64');
  if (sig.length !== 64) return false;
  for (const k of publicKeys) {
    try {
      const key = createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType === 'ed25519' && verify(null, meta, key, sig)) return true;
    } catch {
      /* a bad key never verifies */
    }
  }
  return false;
}

// Verify a downloaded bundle end to end and return its files (catalog layout, index.json at the root).
export function openBundle(input: { meta: Buffer; sig: string; zip: Buffer }, publicKeys: readonly string[]): { meta: CatalogBundleMeta; files: Map<string, Buffer> } {
  if (!verifyBundleSignature(input.meta, input.sig, publicKeys)) {
    throw new HarborError('INVALID_PACKAGE', 'the app catalog signature does not verify', { nextAction: 'Nothing was changed. The catalog stays on the version already on this machine.' });
  }
  const meta = parseBundleMeta(input.meta);
  if (input.zip.length !== meta.zip.bytes || sha256Hex(input.zip) !== meta.zip.sha256) {
    throw new HarborError('INVALID_PACKAGE', 'the app catalog archive does not match its signed checksum', { nextAction: 'Nothing was changed. Harbor tries again at the next check.' });
  }
  const files = readZip(input.zip, BUNDLE_ZIP_LIMITS);
  if (!files.has('index.json')) throw new HarborError('INVALID_PACKAGE', 'the app catalog archive has no index.json at its root');
  return { meta, files };
}
