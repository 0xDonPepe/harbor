import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkTargetVersion, manualInstallCommand, refuseFlagsInUnit, verifyReleaseFiles } from '../../src/bootstrap/selfupdate-apply.js';
import { selfUpdateUnit } from '../../src/bootstrap/systemd.js';
import { HarborError } from '../../src/errors.js';
import { RELEASE_KEYS } from '../../src/release-keys.js';
import { checkSignature, decodeSignature, pinnedKeyIdFor, signDetached, signFile, signingKeyFromEnv } from '../../src/signing.js';
import { FakeUnitStarter, SelfUpdateService, FakeReleaseFeed } from '../../src/system/selfupdate.js';
import { systemClock } from '../../src/util.js';
import { testKeyPair } from './bundle-helpers.js';

// Decision 168: one Ed25519 key signs Harbor releases (SHA256SUMS.sig) and the official catalog (catalog.json.sig).
// Every test here uses throwaway keys; the real private key never leaves its owner.
const ROOT = path.resolve(import.meta.dirname, '../..');
const A = testKeyPair('a-FIXTURE');
const B = testKeyPair('b-FIXTURE');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'harbor-signing-'));
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

describe('signature check (shared helper)', () => {
  const data = Buffer.from('0123abcd  harbor-0.32.0-linux-x64.tar.gz\n');
  const sig = signDetached(data, A.privatePem);

  it('a good signature names the key that made it; the .sig format is base64 + newline', () => {
    expect(sig).toMatch(/^[A-Za-z0-9+/]{86}==\n$/);
    expect(checkSignature(data, sig, [A.key])).toEqual({ ok: true, keyId: 'a-FIXTURE' });
    expect(checkSignature(data, Buffer.from(sig), [B.key, A.key])).toEqual({ ok: true, keyId: 'a-FIXTURE' }); // any pinned key
  });
  it('a tampered file, another key, a missing or malformed signature are refused', () => {
    expect(checkSignature(Buffer.from(data.toString().replace('0123', '0124')), sig, [A.key])).toEqual({ ok: false, reason: 'untrusted' });
    expect(checkSignature(data, sig, [B.key])).toEqual({ ok: false, reason: 'untrusted' });
    expect(checkSignature(data, sig, [])).toEqual({ ok: false, reason: 'untrusted' });
    expect(checkSignature(data, null, [A.key])).toEqual({ ok: false, reason: 'missing' });
    for (const bad of ['', 'not base64!', sig.slice(0, 40), Buffer.alloc(64).toString('hex'), 'A'.repeat(2000)]) expect(checkSignature(data, bad, [A.key])).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSignature(sig)?.length).toBe(64);
  });
  it('a pinned entry that is not an Ed25519 public key never verifies anything', () => {
    expect(checkSignature(data, sig, [{ id: 'junk', pem: 'not a pem' }, A.key])).toEqual({ ok: true, keyId: 'a-FIXTURE' });
    expect(checkSignature(data, sig, [{ id: 'junk', pem: 'not a pem' }])).toEqual({ ok: false, reason: 'untrusted' });
  });
  it('the pinned release key is Ed25519, and install.sh embeds the very same one', () => {
    expect(RELEASE_KEYS.map((k) => k.id)).toEqual(['harbor-2026-10']);
    for (const k of RELEASE_KEYS) expect(createPublicKey(k.pem).asymmetricKeyType).toBe('ed25519');
    const sh = readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
    const embedded = /HARBOR_RELEASE_KEY='(-----BEGIN PUBLIC KEY-----\n[^']+\n-----END PUBLIC KEY-----)'/.exec(sh)?.[1];
    expect(embedded).toBeDefined();
    expect(embedded + '\n').toBe(RELEASE_KEYS[0]!.pem);
  });
});

describe('release signing (scripts/package.mjs, throwaway key)', () => {
  it('reads the key from HARBOR_SIGNING_KEY (PEM text, also with literal \\n) or HARBOR_SIGNING_KEY_FILE', () => {
    expect(signingKeyFromEnv({})).toBeNull();
    expect(signingKeyFromEnv({ HARBOR_SIGNING_KEY: A.privatePem })).toBe(A.privatePem);
    expect(signingKeyFromEnv({ HARBOR_SIGNING_KEY: A.privatePem.trim().replace(/\n/g, '\\n') })).toBe(A.privatePem);
    const dir = tmp();
    writeFileSync(path.join(dir, 'k.pem'), A.privatePem, { mode: 0o600 });
    expect(signingKeyFromEnv({ HARBOR_SIGNING_KEY_FILE: path.join(dir, 'k.pem') })).toBe(A.privatePem);
    expect(() => signingKeyFromEnv({ HARBOR_SIGNING_KEY_FILE: path.join(dir, 'missing.pem') })).toThrow(/cannot be read/);
  });
  it('signs SHA256SUMS into SHA256SUMS.sig and reports whether a pinned key verifies it', () => {
    const dir = tmp();
    const sums = path.join(dir, 'SHA256SUMS');
    writeFileSync(sums, 'aa  harbor-9.9.9-linux-x64.tar.gz\n');
    expect(signFile(sums, A.privatePem, [A.key])).toEqual({ sigFile: `${sums}.sig`, keyId: 'a-FIXTURE' });
    expect(checkSignature(readFileSync(sums), readFileSync(`${sums}.sig`), [A.key])).toEqual({ ok: true, keyId: 'a-FIXTURE' });
    // a key Harbor does not pin still signs, but the caller learns boxes would refuse it (CI then fails)
    expect(signFile(sums, B.privatePem, [A.key]).keyId).toBeNull();
    expect(pinnedKeyIdFor(A.privatePem, [B.key, A.key])).toBe('a-FIXTURE');
    expect(pinnedKeyIdFor(B.privatePem, [A.key])).toBeNull();
    expect(pinnedKeyIdFor(A.privatePem)).toBeNull(); // a throwaway key is never the real one
    expect(() => signDetached(Buffer.from('x'), 'not a key')).toThrow(/not a PEM private key/);
  });
});

describe('self-update refuses what was not signed, and never downgrades (decision 168)', () => {
  const version = '0.40.0';
  const name = `harbor-${version}-linux-x64.tar.gz`;
  const archive = Buffer.from('pretend tarball');
  const sums = Buffer.from(`${createHash('sha256').update(archive).digest('hex')}  ${name}\n`);
  const sig = Buffer.from(signDetached(sums, A.privatePem));
  const keys = [A.key];
  const refusal = (fn: () => unknown): HarborError => {
    try {
      fn();
    } catch (e) {
      if (e instanceof HarborError) return e;
      throw e;
    }
    throw new Error('expected a refusal');
  };

  it('a signed release passes: signature first, then the archive checksum', () => {
    expect(verifyReleaseFiles({ version, name, archive, sums, sig }, { keys })).toMatchObject({ signedBy: 'a-FIXTURE' });
    // the signature is good but the archive was swapped
    expect(refusal(() => verifyReleaseFiles({ version, name, archive: Buffer.from('evil'), sums, sig }, { keys })).message).toMatch(/^checksum mismatch/);
  });
  it('a missing, bad or foreign signature is refused before the checksums are trusted', () => {
    const missing = refusal(() => verifyReleaseFiles({ version, name, archive, sums, sig: null }, { keys }));
    expect(missing.message).toBe('refusing Harbor 0.40.0: SHA256SUMS of Harbor 0.40.0 is not signed (no SHA256SUMS.sig)');
    expect(missing.nextAction).toMatch(/--allow-unsigned/);
    // SHA256SUMS rewritten to match a different archive, old signature kept
    const evilSums = Buffer.from(`${createHash('sha256').update('evil').digest('hex')}  ${name}\n`);
    expect(refusal(() => verifyReleaseFiles({ version, name, archive: Buffer.from('evil'), sums: evilSums, sig }, { keys })).message).toMatch(/does not match its SHA256SUMS\.sig/);
    expect(refusal(() => verifyReleaseFiles({ version, name, archive, sums, sig: Buffer.from(signDetached(sums, B.privatePem)) }, { keys })).message).toMatch(/signed by a key this Harbor does not trust \(trusted: a-FIXTURE\)/);
    expect(refusal(() => verifyReleaseFiles({ version, name, archive, sums, sig: Buffer.from('garbage') }, { keys })).message).toMatch(/is not an Ed25519 signature/);
    // the real pinned keys refuse a throwaway signature
    expect(refusal(() => verifyReleaseFiles({ version, name, archive, sums, sig })).message).toMatch(/trusted: harbor-2026-10/);
  });
  it('--allow-unsigned accepts only a MISSING signature; a bad one is still refused', () => {
    expect(verifyReleaseFiles({ version, name, archive, sums, sig: null }, { keys, allowUnsigned: true })).toMatchObject({ signedBy: null });
    expect(refusal(() => verifyReleaseFiles({ version, name, archive, sums, sig: Buffer.from(signDetached(sums, B.privatePem)) }, { keys, allowUnsigned: true })).message).toMatch(/does not match/);
    // an old, unsigned release: the refusal says how to install it on purpose
    const old = refusal(() => verifyReleaseFiles({ version: '0.31.0', name: 'harbor-0.31.0-linux-x64.tar.gz', archive, sums, sig: null }, { keys }));
    expect(old.nextAction).toContain('sudo /opt/harbor/bin/harbor self-update apply --to 0.31.0 --allow-downgrade --allow-unsigned');
  });
  it('a lower version is refused unless --allow-downgrade; the same version (a repair) is fine', () => {
    const e = refusal(() => checkTargetVersion('0.31.0', '0.32.0', false));
    expect(e.message).toBe('Harbor 0.31.0 is older than the running 0.32.0; self-update never downgrades');
    expect(e.nextAction).toContain('--allow-downgrade --allow-unsigned');
    expect(() => checkTargetVersion('0.31.0', '0.32.0', true)).not.toThrow();
    expect(() => checkTargetVersion('0.32.0', '0.32.0', false)).not.toThrow();
    expect(() => checkTargetVersion('0.33.0', '0.32.0', false)).not.toThrow();
    expect(() => checkTargetVersion('0.10.0', '0.9.0', false)).not.toThrow(); // numeric, not text order
    expect(() => checkTargetVersion('0.9.0', '0.10.0', false)).toThrow(/never downgrades/);
    expect(() => checkTargetVersion('0.32.0 --allow-downgrade', '0.32.0', false)).toThrow(/not a release version/);
    expect(manualInstallCommand('0.33.0')).toBe('sudo /opt/harbor/bin/harbor self-update apply --to 0.33.0 --allow-downgrade');
  });
  it('the unit the console starts can never pass the --allow-* flags', () => {
    expect(selfUpdateUnit()).toContain('Environment=HARBOR_SELF_UPDATE_UNIT=1');
    expect(selfUpdateUnit()).toContain('ExecStart=/opt/harbor/bin/harbor self-update apply --to %i\n');
    const unit = { HARBOR_SELF_UPDATE_UNIT: '1' };
    expect(() => refuseFlagsInUnit(unit, { allowDowngrade: true })).toThrow(/--allow-downgrade cannot be used by the update the console starts/);
    expect(() => refuseFlagsInUnit(unit, { allowUnsigned: true })).toThrow(/--allow-unsigned cannot/);
    expect(() => refuseFlagsInUnit(unit, {})).not.toThrow();
    expect(() => refuseFlagsInUnit({}, { allowDowngrade: true, allowUnsigned: true })).not.toThrow();
  });
  it('the console path starts only a newer, signed release', async () => {
    const feed = new FakeReleaseFeed();
    const starter = new FakeUnitStarter();
    const svc = new SelfUpdateService('0.32.0', feed, starter, tmp(), systemClock, quiet);
    const info = (v: string, sigUrl: string | null) => ({ version: v, tag: `v${v}`, publishedAt: null, notes: null, url: null, archiveUrl: `https://x/harbor-${v}-linux-x64.tar.gz`, sumsUrl: 'https://x/SHA256SUMS', sigUrl });
    feed.info = info('0.33.0', null);
    await svc.check();
    await expect(svc.apply('admin')).rejects.toThrow(/release 0\.33\.0 is not signed \(no SHA256SUMS\.sig\)/);
    feed.info = info('0.31.0', 'https://x/SHA256SUMS.sig');
    await svc.check();
    await expect(svc.apply('admin')).rejects.toThrow(/no newer Harbor release/);
    expect(starter.started).toEqual([]);
    feed.info = info('0.33.0', 'https://x/SHA256SUMS.sig');
    await svc.check();
    await svc.apply('admin');
    expect(starter.started).toEqual(['harbor-self-update@0.33.0.service']);
  });
});

// install.sh checks SHA256SUMS.sig with `openssl pkeyutl -verify -rawin` (OpenSSL 3, as on Ubuntu 24.04).
// macOS ships LibreSSL, which lacks it: the test then looks for a Homebrew OpenSSL 3, and skips when none works.
function opensslWithEd25519(): string | null {
  const candidates = ['openssl', '/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/opt/homebrew/opt/openssl@3/bin/openssl', '/usr/local/opt/openssl@3/bin/openssl'];
  const dir = tmp();
  const data = path.join(dir, 'data');
  writeFileSync(data, 'probe\n');
  writeFileSync(path.join(dir, 'pub.pem'), A.key.pem);
  writeFileSync(path.join(dir, 'sig.bin'), Buffer.from(signDetached(readFileSync(data), A.privatePem).trim(), 'base64'));
  for (const c of candidates) {
    if (c.startsWith('/') && !existsSync(c)) continue;
    const r = spawnSync(c, ['pkeyutl', '-verify', '-pubin', '-inkey', path.join(dir, 'pub.pem'), '-rawin', '-in', data, '-sigfile', path.join(dir, 'sig.bin')], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}
const OPENSSL = opensslWithEd25519();

describe.skipIf(!OPENSSL)('install.sh verifies SHA256SUMS.sig with openssl (decision 168)', () => {
  // run the real verify_sig / version_lt functions from install.sh, with a throwaway key in place of the release key
  const sh = readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  const fn = (name: string) => {
    const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(sh);
    if (!m) throw new Error(`install.sh has no ${name}()`);
    return m[0];
  };
  const run = (body: string, key = A.key.pem) => {
    const dir = path.dirname(OPENSSL!.startsWith('/') ? OPENSSL! : '/usr/bin/openssl');
    const script = `set -eu\nHARBOR_RELEASE_KEY='${key.trim()}'\n${fn('verify_sig')}\n${fn('version_lt')}\n${body}\n`;
    return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` } }).status;
  };

  it('accepts the signed SHA256SUMS and refuses a changed one, a foreign signature and garbage', () => {
    const dir = tmp();
    const sums = path.join(dir, 'SHA256SUMS');
    writeFileSync(sums, 'aa  harbor-0.40.0-linux-x64.tar.gz\n');
    writeFileSync(path.join(dir, 'good.sig'), signDetached(readFileSync(sums), A.privatePem));
    writeFileSync(path.join(dir, 'foreign.sig'), signDetached(readFileSync(sums), B.privatePem));
    writeFileSync(path.join(dir, 'garbage.sig'), 'not a signature\n');
    expect(run(`verify_sig '${sums}' '${dir}/good.sig' '${dir}'`)).toBe(0);
    expect(run(`verify_sig '${sums}' '${dir}/foreign.sig' '${dir}'`)).toBe(1);
    expect(run(`verify_sig '${sums}' '${dir}/garbage.sig' '${dir}'`)).toBe(1);
    // the real embedded key refuses a throwaway signature
    expect(run(`verify_sig '${sums}' '${dir}/good.sig' '${dir}'`, RELEASE_KEYS[0]!.pem)).toBe(1);
    writeFileSync(sums, 'ab  harbor-0.40.0-linux-x64.tar.gz\n');
    expect(run(`verify_sig '${sums}' '${dir}/good.sig' '${dir}'`)).toBe(1);
  });
  it('orders versions numerically (HARBOR_ALLOW_UNSIGNED only below 0.32.0)', () => {
    expect(run('version_lt 0.31.0 0.32.0')).toBe(0);
    expect(run('version_lt 0.9.9 0.32.0')).toBe(0);
    expect(run('version_lt 0.32.0 0.32.0')).toBe(1);
    expect(run('version_lt 0.100.0 0.32.0')).toBe(1);
  });
});
