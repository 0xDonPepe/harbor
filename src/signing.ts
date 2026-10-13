import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { RELEASE_KEYS, type ReleaseKey } from './release-keys.js';

// Signed Harbor releases and the signed official catalog (decision 168). One Ed25519 key signs both:
//   SHA256SUMS.sig     base64 of the Ed25519 signature over the exact bytes of SHA256SUMS (release assets)
//   catalog.json.sig   the same over the exact bytes of catalog.json (catalog release assets)
// A signature counts when ANY pinned key (src/release-keys.ts) verifies it, so a rotation can ship the next key
// first. The same check runs in the root self-update step, the daemon's catalog download and `pnpm package`;
// install.sh does it with openssl. Pure node:crypto, no I/O except the two small file helpers at the end.

export const SIG_SUFFIX = '.sig';
// a signature file is ~90 bytes of base64; anything much larger is not one
export const MAX_SIGNATURE_BYTES = 1024;

export type SignatureVerdict = { ok: true; keyId: string } | { ok: false; reason: 'missing' | 'malformed' | 'untrusted' };

// Strict: base64 of exactly 64 bytes, surrounding whitespace (a trailing newline) allowed.
export function decodeSignature(text: Buffer | string): Buffer | null {
  if (text.length > MAX_SIGNATURE_BYTES) return null;
  const s = (Buffer.isBuffer(text) ? text.toString('utf8') : text).trim();
  if (!/^[A-Za-z0-9+/]{85}[AQgw]==$/.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  return b.length === 64 ? b : null;
}

function publicKey(k: ReleaseKey): KeyObject | null {
  try {
    const pub = createPublicKey(k.pem);
    return pub.asymmetricKeyType === 'ed25519' ? pub : null;
  } catch {
    return null;
  }
}

// `sig` null = there was no signature file.
export function checkSignature(data: Buffer, sig: Buffer | string | null, keys: readonly ReleaseKey[] = RELEASE_KEYS): SignatureVerdict {
  if (sig === null) return { ok: false, reason: 'missing' };
  const raw = decodeSignature(sig);
  if (!raw) return { ok: false, reason: 'malformed' };
  for (const k of keys) {
    const pub = publicKey(k);
    if (pub && verify(null, data, pub, raw)) return { ok: true, keyId: k.id };
  }
  return { ok: false, reason: 'untrusted' };
}

// One sentence for a refused signature: `what` names the signed file ("SHA256SUMS of Harbor 0.32.0").
export function signatureProblem(what: string, sigName: string, reason: Exclude<SignatureVerdict, { ok: true }>['reason'], keys: readonly ReleaseKey[] = RELEASE_KEYS): string {
  switch (reason) {
    case 'missing':
      return `${what} is not signed (no ${sigName})`;
    case 'malformed':
      return `${what} has a ${sigName} that is not an Ed25519 signature`;
    case 'untrusted':
      return `${what} does not match its ${sigName}: the file was changed, or it was signed by a key this Harbor does not trust (trusted: ${keys.map((k) => k.id).join(', ') || 'none'})`;
  }
}

// ---- signing (release builds only: scripts/package.mjs, tests with throwaway keys) ----

function privateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (e) {
    throw new Error(`the signing key is not a PEM private key (${(e as Error).message})`, { cause: e });
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the signing key is ${key.asymmetricKeyType ?? 'unknown'}, not Ed25519`);
  return key;
}

// base64 + newline: the exact content of a .sig file.
export function signDetached(data: Buffer, privateKeyPem: string): string {
  return sign(null, data, privateKey(privateKeyPem)).toString('base64') + '\n';
}

// The pinned key that matches this private key, or null (a key Harbor would refuse).
export function pinnedKeyIdFor(privateKeyPem: string, keys: readonly ReleaseKey[] = RELEASE_KEYS): string | null {
  const der = createPublicKey(privateKey(privateKeyPem)).export({ type: 'spki', format: 'der' });
  for (const k of keys) {
    const pub = publicKey(k);
    if (pub && pub.export({ type: 'spki', format: 'der' }).equals(der)) return k.id;
  }
  return null;
}

// HARBOR_SIGNING_KEY (the PEM text, how CI passes the secret) or HARBOR_SIGNING_KEY_FILE (a path). Null = unset.
export function signingKeyFromEnv(env: Record<string, string | undefined>, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): string | null {
  const text = env.HARBOR_SIGNING_KEY?.trim();
  if (text) return text.replace(/\\n/g, '\n') + '\n';
  const file = env.HARBOR_SIGNING_KEY_FILE?.trim();
  if (!file) return null;
  try {
    return read(file);
  } catch (e) {
    throw new Error(`HARBOR_SIGNING_KEY_FILE ${file} cannot be read (${(e as Error).message})`, { cause: e });
  }
}

// Sign `file` into `file.sig` and check the result with the pinned keys. Returns the key id that verifies it,
// or null when the key is not one Harbor pins (boxes would refuse the signature).
export function signFile(file: string, privateKeyPem: string, keys: readonly ReleaseKey[] = RELEASE_KEYS): { sigFile: string; keyId: string | null } {
  const data = readFileSync(file);
  const sig = signDetached(data, privateKeyPem);
  const sigFile = file + SIG_SUFFIX;
  writeFileSync(sigFile, sig, { mode: 0o644 });
  const v = checkSignature(data, sig, keys);
  return { sigFile, keyId: v.ok ? v.keyId : null };
}
