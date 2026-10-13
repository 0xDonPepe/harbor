import { describe, expect, it } from 'vitest';
import { confirmHostKey, hostKeyFingerprint, isHostKeyFingerprint, knownHostsFor, parseScannedHostKeys } from '../../src/backups/restic.js';
import { HarborError } from '../../src/errors.js';

// Decision 169: SFTP places pin a server key only after the operator confirmed it.
// A throwaway public key made for this test (`ssh-keygen -t ed25519`); its fingerprint as `ssh-keygen -lf` printed it.
const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIDBpn0+1PVBj6620Xj5M4lPrT+OEA8V6XnWIncflA1nl';
const ED_FP = 'SHA256:DzwKyJuhIlkHK5oF+ojc37E6AchnZ0x3UEibFoncIdg';
const RSA = 'AAAAB3NzaC1yc2EAAAADAQABAAABAQFIXTUREfixture';
const scan = ['# nas.lan:22 SSH-2.0-OpenSSH_9.6', `nas.lan ssh-rsa ${RSA}`, `nas.lan ssh-ed25519 ${ED}`, ''].join('\n');

describe('SFTP server keys', () => {
  it('fingerprints a key exactly like ssh-keygen -lf', () => {
    expect(hostKeyFingerprint(ED)).toBe(ED_FP);
    expect(isHostKeyFingerprint(ED_FP)).toBe(true);
    expect(isHostKeyFingerprint(`${ED_FP}=`)).toBe(true);
    expect(isHostKeyFingerprint(`nas.lan ssh-ed25519 ${ED}`)).toBe(false);
    expect(isHostKeyFingerprint('')).toBe(false);
  });

  it('reads what ssh-keyscan printed, strongest key first', () => {
    const keys = parseScannedHostKeys(scan);
    expect(keys.map((k) => k.type)).toEqual(['ssh-ed25519', 'ssh-rsa']);
    expect(keys[0]).toEqual({ type: 'ssh-ed25519', fingerprint: ED_FP, line: `ssh-ed25519 ${ED}` });
  });

  it('pins nothing without a confirmation: the error carries the fingerprints', () => {
    try {
      confirmHostKey('', scan, 'nas.lan:22');
      expect.unreachable();
    } catch (e) {
      expect(HarborError.is(e, 'HOST_KEY_UNCONFIRMED')).toBe(true);
      expect((e as HarborError).details).toEqual([ED_FP, hostKeyFingerprint(RSA)]);
      expect((e as Error).message).toBe(`Harbor has not talked to nas.lan:22 before. Its server key is ${ED_FP} (ED25519)`);
      expect((e as { backupCode?: string }).backupCode).toBe('host-key-unconfirmed');
    }
  });

  it('pins exactly the confirmed key, and refuses one the server does not show', () => {
    const pinned = confirmHostKey(ED_FP, scan, 'nas.lan:22');
    expect(pinned).toBe(`ssh-ed25519 ${ED}`);
    expect(knownHostsFor('nas.lan', 22, pinned)).toBe(`nas.lan ssh-ed25519 ${ED}\n`);
    expect(() => confirmHostKey(`SHA256:${'B'.repeat(43)}`, scan, 'nas.lan:22')).toThrow(/different server key/);
    expect(() => confirmHostKey(ED_FP, '', 'nas.lan:22')).toThrow(/cannot read the server key/);
  });

  it('a host whose name starts like a key type (ssh-nas.lan) is not taken for the type', () => {
    for (const host of ['ssh-nas.lan', 'ssh-nas', 'ecdsa-box.lan', 'sk-nas.lan']) {
      const keys = parseScannedHostKeys(`${host} ssh-ed25519 ${ED}\n`);
      expect(keys, host).toEqual([{ type: 'ssh-ed25519', fingerprint: ED_FP, line: `ssh-ed25519 ${ED}` }]);
      expect(confirmHostKey(ED_FP, `${host} ssh-ed25519 ${ED}\n`, `${host}:22`)).toBe(`ssh-ed25519 ${ED}`);
      expect(knownHostsFor(host, 22, `${host} ssh-ed25519 ${ED}`)).toBe(`${host} ssh-ed25519 ${ED}\n`);
    }
    expect(knownHostsFor('nas.lan', 2222, `ssh-ed25519 ${ED}`)).toBe(`[nas.lan]:2222 ssh-ed25519 ${ED}\n`);
  });
});
