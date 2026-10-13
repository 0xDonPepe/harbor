import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkTargetVersion, manualInstallCommand, readLocalRelease, refuseFlagsInUnit, verifyReleaseFiles } from '../../src/bootstrap/selfupdate-apply.js';
import { selfUpdateUnit } from '../../src/bootstrap/systemd.js';
import { HarborError } from '../../src/errors.js';
import { RELEASE_KEYS } from '../../src/release-keys.js';
import { checkSignature, decodeSignature, pinnedKeyIdFor, releaseSigningKey, signDetached, signFile, signingKeyFromEnv } from '../../src/signing.js';
import { takeSigningEnv } from '../../scripts/signing-env.mjs';
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
  it('the pinned release keys are Ed25519, and install.sh embeds the very same ones, in order', () => {
    expect(RELEASE_KEYS.map((k) => k.id)).toEqual(['harbor-2026-10']);
    for (const k of RELEASE_KEYS) expect(createPublicKey(k.pem).asymmetricKeyType).toBe('ed25519');
    const sh = readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
    const block = /^HARBOR_RELEASE_KEYS='([^']+)'$/m.exec(sh)?.[1];
    expect(block).toBeDefined();
    const embedded = block!.match(/-----BEGIN PUBLIC KEY-----\n[^-]+\n-----END PUBLIC KEY-----/g)!.map((p) => p + '\n');
    expect(embedded).toEqual(RELEASE_KEYS.map((k) => k.pem));
  });
});

describe('release signing (scripts/package.mjs, throwaway key)', () => {
  it('reads the key from HARBOR_SIGNING_KEY (the multi-line PEM, as harbor-apps reads it) or HARBOR_SIGNING_KEY_FILE', () => {
    expect(signingKeyFromEnv({})).toBeNull();
    expect(signingKeyFromEnv({ HARBOR_SIGNING_KEY: A.privatePem })).toBe(A.privatePem);
    expect(signingKeyFromEnv({ HARBOR_SIGNING_KEY: `\n${A.privatePem.trim()}\n\n` })).toBe(A.privatePem);
    // a one-line secret with literal \n is not unescaped here either: it fails loudly, like harbor-apps' openssl step
    const oneLine = A.privatePem.trim().replace(/\n/g, '\\n');
    expect(() => releaseSigningKey({ HARBOR_SIGNING_KEY: oneLine }, { require: true, keys: [A.key] })).toThrow(/not a PEM private key/);
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
  it('--require-signature fails without a key or with a key Harbor does not pin; without it an unpinned key only warns', () => {
    expect(() => releaseSigningKey({}, { require: true, keys: [A.key] })).toThrow(/^--require-signature: set HARBOR_SIGNING_KEY/);
    expect(() => releaseSigningKey({ HARBOR_SIGNING_KEY: B.privatePem }, { require: true, keys: [A.key] })).toThrow(/not one Harbor pins/);
    expect(releaseSigningKey({ HARBOR_SIGNING_KEY: A.privatePem }, { require: true, keys: [B.key, A.key] })).toEqual({ pem: A.privatePem, keyId: 'a-FIXTURE' });
    expect(releaseSigningKey({}, { require: false, keys: [A.key] })).toBeNull();
    expect(releaseSigningKey({ HARBOR_SIGNING_KEY: B.privatePem }, { require: false, keys: [A.key] })).toEqual({ pem: B.privatePem, keyId: null });
    // the real pinned key list refuses a throwaway key in CI mode
    expect(() => releaseSigningKey({ HARBOR_SIGNING_KEY: A.privatePem }, { require: true })).toThrow(/not one Harbor pins/);
  });
  it('package.mjs takes the key out of the environment before any child process runs', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin', HARBOR_SIGNING_KEY: A.privatePem, HARBOR_SIGNING_KEY_FILE: '/x/k.pem' };
    expect(takeSigningEnv(env)).toEqual({ HARBOR_SIGNING_KEY: A.privatePem, HARBOR_SIGNING_KEY_FILE: '/x/k.pem' });
    expect(env).toEqual({ PATH: '/usr/bin' });
    expect(takeSigningEnv({})).toEqual({});
    // package.mjs calls it on process.env at the top, before `pnpm build` (the first child)
    const script = readFileSync(path.join(ROOT, 'scripts/package.mjs'), 'utf8');
    const taken = script.indexOf('takeSigningEnv(process.env)');
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(script.indexOf("run('pnpm', ['build'])"));
    expect(script.slice(taken).match(/process\.env\.HARBOR_SIGNING_KEY/)).toBeNull();
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
    expect(missing.nextAction).toBe('Nothing was changed. Every release from 0.32.0 on carries SHA256SUMS.sig; if this one stays without it, do not install it.');
    expect(refusal(() => verifyReleaseFiles({ version, name, archive, sums, sig: null, local: true }, { keys })).nextAction).toMatch(/must sit next to the archive.*--allow-unsigned/);
    // SHA256SUMS rewritten to match a different archive, old signature kept
    const evilSums = Buffer.from(`${createHash('sha256').update('evil').digest('hex')}  ${name}\n`);
    expect(refusal(() => verifyReleaseFiles({ version, name, archive: Buffer.from('evil'), sums: evilSums, sig }, { keys })).message).toMatch(/does not match its SHA256SUMS\.sig/);
    expect(refusal(() => verifyReleaseFiles({ version, name, archive, sums, sig: Buffer.from(signDetached(sums, B.privatePem)) }, { keys })).message).toMatch(/signed by a key this Harbor does not trust \(trusted: a-FIXTURE\)/);
    expect(refusal(() => verifyReleaseFiles({ version, name, archive, sums, sig: Buffer.from('garbage') }, { keys })).message).toMatch(/is not an Ed25519 signature/);
    // the real pinned keys refuse a throwaway signature
    expect(refusal(() => verifyReleaseFiles({ version, name, archive, sums, sig })).message).toMatch(/trusted: harbor-2026-10/);
  });
  it('--allow-unsigned accepts only a MISSING signature, of a local archive or a release before 0.32.0; a bad one is still refused', () => {
    expect(verifyReleaseFiles({ version, name, archive, sums, sig: null, local: true }, { keys, allowUnsigned: true })).toMatchObject({ signedBy: null });
    expect(refusal(() => verifyReleaseFiles({ version, name, archive, sums, sig: Buffer.from(signDetached(sums, B.privatePem)), local: true }, { keys, allowUnsigned: true })).message).toMatch(/does not match/);
    // a GitHub release from 0.32.0 on always needs its signature, even with --allow-unsigned
    expect(refusal(() => verifyReleaseFiles({ version, name, archive, sums, sig: null }, { keys, allowUnsigned: true })).message).toMatch(/is not signed/);
    const oldName = 'harbor-0.31.0-linux-x64.tar.gz';
    const oldSums = Buffer.from(`${createHash('sha256').update(archive).digest('hex')}  ${oldName}\n`);
    expect(verifyReleaseFiles({ version: '0.31.0', name: oldName, archive, sums: oldSums, sig: null }, { keys, allowUnsigned: true })).toMatchObject({ signedBy: null });
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
  it('reads SHA256SUMS and SHA256SUMS.sig from beside a local --archive', () => {
    const dir = tmp();
    const f = (n: string) => path.join(dir, n);
    writeFileSync(f(name), archive);
    expect(() => readLocalRelease({ archive: f(name), sums: f('SHA256SUMS'), sig: f('SHA256SUMS.sig') })).toThrow(/SHA256SUMS must sit next to/);
    writeFileSync(f('SHA256SUMS'), sums);
    expect(readLocalRelease({ archive: f(name), sums: f('SHA256SUMS'), sig: f('SHA256SUMS.sig') })).toMatchObject({ sig: null, local: true });
    writeFileSync(f('SHA256SUMS.sig'), sig);
    const files = readLocalRelease({ archive: f(name), sums: f('SHA256SUMS'), sig: f('SHA256SUMS.sig') });
    expect(verifyReleaseFiles({ version, name, ...files }, { keys })).toMatchObject({ signedBy: 'a-FIXTURE' });
    expect(() => readLocalRelease({ archive: f('missing.tar.gz'), sums: f('SHA256SUMS'), sig: f('SHA256SUMS.sig') })).toThrow(/not found/);
  });
  it('the console path offers and starts only a newer release whose signed files are all published', async () => {
    const feed = new FakeReleaseFeed();
    const starter = new FakeUnitStarter();
    const svc = new SelfUpdateService('0.32.0', feed, starter, tmp(), systemClock, quiet);
    const info = (v: string, sigUrl: string | null) => ({ version: v, tag: `v${v}`, publishedAt: null, notes: null, url: null, archiveUrl: `https://x/harbor-${v}-linux-x64.tar.gz`, sumsUrl: 'https://x/SHA256SUMS', sigUrl });
    // mid-upload (CI uploads the assets one after another): not offered yet, said plainly, never started
    feed.info = info('0.33.0', null);
    expect(await svc.check()).toMatchObject({ available: false, pending: 'Harbor 0.33.0 is still being published (SHA256SUMS.sig not uploaded yet); Harbor offers it once its signed files are all there', latest: { version: '0.33.0' } });
    await expect(svc.apply('admin')).rejects.toThrow(/^Harbor 0\.33\.0 is still being published/);
    // the downgrade refusal of the console path: an older (or the same) release is never "newer"
    feed.info = info('0.31.0', 'https://x/SHA256SUMS.sig');
    expect(await svc.check()).toMatchObject({ available: false, pending: null });
    await expect(svc.apply('admin')).rejects.toThrow(/no newer Harbor release/);
    feed.info = info('0.32.0', 'https://x/SHA256SUMS.sig');
    await svc.check();
    await expect(svc.apply('admin')).rejects.toThrow(/no newer Harbor release/);
    expect(starter.started).toEqual([]);
    feed.info = info('0.33.0', 'https://x/SHA256SUMS.sig');
    expect(await svc.check()).toMatchObject({ available: true, pending: null });
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
  // run the real functions from install.sh (verify_sig, version_lt, fetch_sig, check_release_sig, die, warn),
  // with throwaway keys in place of the release keys
  const sh = readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  const fn = (name: string) => {
    const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(sh) ?? new RegExp(`^${name}\\(\\) +\\{ .*\\}$`, 'm').exec(sh);
    if (!m) throw new Error(`install.sh has no ${name}()`);
    return m[0];
  };
  const firstSigned = /^FIRST_SIGNED=(.+)$/m.exec(sh)?.[1];
  const run = (body: string, opts: { keys?: string[]; env?: Record<string, string> } = {}) => {
    const dir = path.dirname(OPENSSL!.startsWith('/') ? OPENSSL! : '/usr/bin/openssl');
    const keys = (opts.keys ?? [A.key.pem]).map((k) => k.trim()).join('\n');
    const script = [`set -eu`, `FIRST_SIGNED=${firstSigned}`, `HARBOR_RELEASE_KEYS='${keys}'`, ...['say', 'warn', 'die', 'verify_sig', 'version_lt', 'fetch_sig', 'check_release_sig'].map(fn), body, ''].join('\n');
    const env: Record<string, string> = { PATH: `${dir}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '/tmp', ...(opts.env ?? {}) };
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const release = (sigBy: string | null) => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'SHA256SUMS'), 'aa  harbor-0.40.0-linux-x64.tar.gz\n');
    if (sigBy) writeFileSync(path.join(dir, 'SHA256SUMS.sig'), signDetached(readFileSync(path.join(dir, 'SHA256SUMS')), sigBy));
    return dir;
  };

  it('accepts the signed SHA256SUMS and refuses a changed one, a foreign signature and garbage', () => {
    const dir = tmp();
    const sums = path.join(dir, 'SHA256SUMS');
    writeFileSync(sums, 'aa  harbor-0.40.0-linux-x64.tar.gz\n');
    writeFileSync(path.join(dir, 'good.sig'), signDetached(readFileSync(sums), A.privatePem));
    writeFileSync(path.join(dir, 'foreign.sig'), signDetached(readFileSync(sums), B.privatePem));
    writeFileSync(path.join(dir, 'garbage.sig'), 'not a signature\n');
    expect(run(`verify_sig '${sums}' '${dir}/good.sig' '${dir}'`).status).toBe(0);
    expect(run(`verify_sig '${sums}' '${dir}/foreign.sig' '${dir}'`).status).toBe(1);
    expect(run(`verify_sig '${sums}' '${dir}/garbage.sig' '${dir}'`).status).toBe(1);
    // the real embedded keys refuse a throwaway signature
    expect(run(`verify_sig '${sums}' '${dir}/good.sig' '${dir}'`, { keys: RELEASE_KEYS.map((k) => k.pem) }).status).toBe(1);
    writeFileSync(sums, 'ab  harbor-0.40.0-linux-x64.tar.gz\n');
    expect(run(`verify_sig '${sums}' '${dir}/good.sig' '${dir}'`).status).toBe(1);
  });
  it('accepts a signature by any embedded key (a rotation ships the next key first)', () => {
    const dir = release(B.privatePem);
    const sums = path.join(dir, 'SHA256SUMS');
    expect(run(`verify_sig '${sums}' '${dir}/SHA256SUMS.sig' '${dir}'`, { keys: [A.key.pem, B.key.pem] }).status).toBe(0);
    expect(run(`verify_sig '${sums}' '${dir}/SHA256SUMS.sig' '${dir}'`, { keys: [B.key.pem, A.key.pem] }).status).toBe(0);
    expect(run(`verify_sig '${sums}' '${dir}/SHA256SUMS.sig' '${dir}'`, { keys: [A.key.pem] }).status).toBe(1);
  });
  it('orders versions numerically (HARBOR_ALLOW_UNSIGNED only below 0.32.0)', () => {
    expect(firstSigned).toBe('0.32.0');
    expect(run('version_lt 0.31.0 0.32.0').status).toBe(0);
    expect(run('version_lt 0.9.9 0.32.0').status).toBe(0);
    expect(run('version_lt 0.32.0 0.32.0').status).toBe(1);
    expect(run('version_lt 0.100.0 0.32.0').status).toBe(1);
  });

  describe('check_release_sig decides before the checksum is trusted', () => {
    const decide = (dir: string, version: string, env: Record<string, string> = {}) => run(`VERSION=${version}\ncheck_release_sig '${dir}'\necho "SIGNED=$SIGNED"`, { env });

    it('a good signature passes; a bad one stops even with HARBOR_ALLOW_UNSIGNED=1', () => {
      expect(decide(release(A.privatePem), '0.40.0')).toMatchObject({ status: 0, out: 'SIGNED=signature OK\n' });
      const bad = decide(release(B.privatePem), '0.40.0', { HARBOR_ALLOW_UNSIGNED: '1', HARBOR_VERSION: '0.40.0' });
      expect(bad.status).toBe(1);
      expect(bad.err).toMatch(/does not match its signature \(SHA256SUMS\.sig\)/);
      expect(decide(release(B.privatePem), '0.31.0', { HARBOR_ALLOW_UNSIGNED: '1', HARBOR_VERSION: '0.31.0' }).status).toBe(1);
    });
    it('an unsigned release from 0.32.0 on stops, whatever is set', () => {
      for (const env of [{}, { HARBOR_ALLOW_UNSIGNED: '1' }, { HARBOR_ALLOW_UNSIGNED: '1', HARBOR_VERSION: '0.40.0' }]) {
        const r = decide(release(null), '0.40.0', env);
        expect(r.status).toBe(1);
        expect(r.err).toMatch(/Harbor 0\.40\.0 has no SHA256SUMS\.sig; refusing an unsigned release/);
      }
    });
    it('HARBOR_ALLOW_UNSIGNED=1 installs an older release only when HARBOR_VERSION asked for it, with a loud warning', () => {
      const ok = decide(release(null), '0.31.0', { HARBOR_ALLOW_UNSIGNED: '1', HARBOR_VERSION: '0.31.0' });
      expect(ok).toMatchObject({ status: 0, out: 'SIGNED=UNSIGNED (HARBOR_ALLOW_UNSIGNED=1)\n' });
      expect(ok.err).toMatch(/HARBOR_ALLOW_UNSIGNED=1: Harbor 0\.31\.0 has NO signature/);
      // asked for, but not allowed: says how
      const asked = decide(release(null), '0.31.0', { HARBOR_VERSION: '0.31.0' });
      expect(asked.status).toBe(1);
      expect(asked.err).toMatch(/older than 0\.32\.0, the first signed release\. To install it anyway, on purpose: HARBOR_VERSION=0\.31\.0 HARBOR_ALLOW_UNSIGNED=1/);
      // the newest release is still unsigned (0.32.0 not published yet): the override is not offered
      const newest = decide(release(null), '0.31.0', { HARBOR_ALLOW_UNSIGNED: '1' });
      expect(newest.status).toBe(1);
      expect(newest.err).toMatch(/the newest Harbor release \(0\.31\.0\) is older than 0\.32\.0.*try again in a few minutes/);
    });
    it('a local HARBOR_ARCHIVE without SHA256SUMS.sig is refused at any version, even with HARBOR_ALLOW_UNSIGNED=1', () => {
      for (const version of ['0.31.0', '0.40.0']) {
        const r = decide(release(null), version, { HARBOR_ARCHIVE: `/tmp/harbor-${version}-linux-x64.tar.gz`, HARBOR_ALLOW_UNSIGNED: '1', HARBOR_VERSION: version });
        expect(r.status).toBe(1);
        expect(r.err).toMatch(/has no SHA256SUMS\.sig next to it; refusing an unsigned archive\. For an archive you built yourself, extract it and run: sudo/);
      }
      expect(decide(release(A.privatePem), '0.40.0', { HARBOR_ARCHIVE: '/tmp/harbor-0.40.0-linux-x64.tar.gz' })).toMatchObject({ status: 0, out: 'SIGNED=signature OK\n' });
    });
    it('a signature download that fails (not a 404) stops the install with one HTTP code', () => {
      const dir = tmp();
      const r = run(`VERSION=0.40.0\nfetch_sig 'http://127.0.0.1:1/SHA256SUMS.sig' '${dir}/SHA256SUMS.sig'`);
      expect(r.status).toBe(1);
      expect(r.err).toMatch(/could not download SHA256SUMS\.sig of Harbor 0\.40\.0 \(HTTP 000\); nothing was installed/);
      expect(existsSync(path.join(dir, 'SHA256SUMS.sig'))).toBe(false);
    });
  });
});
