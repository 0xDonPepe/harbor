// Decision 165: the local CA Harbor asks every device to trust can only vouch for this machine's .local names,
// its bare host name and private addresses (critical name constraints, pathlen:0). A leaked CA key cannot sign a
// certificate a trusting device would accept for any other site. A CA from before 0.31.0 is reported as not
// limited, and replacing it deletes the old key.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureTlsCerts, readTlsState } from '../../src/system/lan-https.js';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const verify = (ca: string, cert: string): boolean => {
  try {
    execFileSync('openssl', ['verify', '-CAfile', ca, cert], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!hasOpenssl)('local certificate authority (decision 165)', () => {
  it('mints a name-constrained CA whose leaf covers only signable names, and refuses to vouch for other sites', async () => {
    const state = mkdtempSync(path.join(tmpdir(), 'harbor-ca-'));
    try {
      const st = await ensureTlsCerts(state, ['harbor.local', 'mybox.local', '192.168.1.20', '203.0.113.9']);
      expect(st.caLimited).toBe(true);
      expect(st.hosts).toEqual(['harbor.local', 'mybox.local', '192.168.1.20']); // a public address is never in the cert
      const tls = path.join(state, 'tls');
      const text = execFileSync('openssl', ['x509', '-in', path.join(tls, 'ca.crt'), '-noout', '-text'], { encoding: 'utf8' });
      expect(text).toMatch(/Name Constraints: critical/);
      expect(text).toMatch(/pathlen:0/);
      expect(verify(path.join(tls, 'ca.crt'), path.join(tls, 'server.crt'))).toBe(true);
      // a certificate for someone else's site, signed with this CA's own key, does not verify
      execFileSync('openssl', ['ecparam', '-genkey', '-name', 'prime256v1', '-out', path.join(tls, 'evil.key')]);
      execFileSync('openssl', ['req', '-new', '-key', path.join(tls, 'evil.key'), '-subj', '/CN=bank.example.com', '-out', path.join(tls, 'evil.csr')]);
      writeFileSync(path.join(tls, 'evil.ext'), 'subjectAltName=DNS:bank.example.com\nbasicConstraints=CA:FALSE\n');
      execFileSync('openssl', ['x509', '-req', '-in', path.join(tls, 'evil.csr'), '-CA', path.join(tls, 'ca.crt'), '-CAkey', path.join(tls, 'ca.key'), '-CAcreateserial', '-out', path.join(tls, 'evil.crt'), '-days', '30', '-extfile', path.join(tls, 'evil.ext')], { stdio: 'ignore' });
      expect(verify(path.join(tls, 'ca.crt'), path.join(tls, 'evil.crt'))).toBe(false);
      // the bare host name of this machine is permitted too
      expect(text.toLowerCase()).toContain(`dns:${hostname().toLowerCase().replace(/\.local$/, '')}`);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it('an older CA reads as not limited until it is replaced; replacing it changes the fingerprint and the key', async () => {
    const state = mkdtempSync(path.join(tmpdir(), 'harbor-ca-old-'));
    try {
      const first = await ensureTlsCerts(state, ['harbor.local']);
      rmSync(path.join(state, 'tls', 'ca.json')); // what a CA minted before 0.31.0 looks like
      expect(readTlsState(state)?.caLimited).toBe(false);
      const oldKey = readFileSync(path.join(state, 'tls', 'ca.key'));
      expect((await ensureTlsCerts(state, ['harbor.local'])).fingerprint).toBe(first.fingerprint); // nothing changes by itself
      const fresh = await ensureTlsCerts(state, ['harbor.local'], { replaceCa: true });
      expect(fresh.caLimited).toBe(true);
      expect(fresh.fingerprint).not.toBe(first.fingerprint);
      expect(readFileSync(path.join(state, 'tls', 'ca.key')).equals(oldKey)).toBe(false);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
