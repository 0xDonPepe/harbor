import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GcmShapeError, gcmDecipher, gcmOpen, gcmShapeOk } from '../../src/gcm.js';
import { HarborError } from '../../src/errors.js';
import { createSealedMachineKey, unsealMachineKey, zeroMachineKey } from '../../src/auth/machine-key.js';
import { unwrapMasterKeyForMachine, wrapMasterKeyForMachine } from '../../src/storage/app-home.js';
import { openRecoveryBundle, sealRecoveryBundle } from '../../src/storage/recovery-bundle.js';
import { readZip, writeZip } from '../../src/packages/zip.js';

// Decision 169: AES-256-GCM decryption pins a 16-byte tag and a 12-byte nonce everywhere.
describe('AES-256-GCM shape checks', () => {
  const key = randomBytes(32);
  const seal = (nonceLen = 12) => {
    const nonce = randomBytes(nonceLen);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([c.update(Buffer.from('harbor secret')), c.final()]);
    return { nonce, ct, tag: c.getAuthTag() };
  };

  it('opens what Harbor writes', () => {
    const { nonce, ct, tag } = seal();
    expect(gcmOpen(key, nonce, tag, ct).toString()).toBe('harbor secret');
  });

  it('refuses a truncated tag before decrypting (Node alone would accept a 4-byte tag)', () => {
    const { nonce, ct, tag } = seal();
    expect(gcmShapeOk(nonce, tag.subarray(0, 4))).toBe(false);
    expect(() => gcmDecipher(key, nonce, tag.subarray(0, 4))).toThrow(GcmShapeError);
    expect(() => gcmOpen(key, nonce, tag.subarray(0, 12), ct)).toThrow(/tag has the wrong length/);
  });

  it('refuses a nonce of another length and a short key', () => {
    const odd = seal(16);
    expect(() => gcmOpen(key, odd.nonce, odd.tag, odd.ct)).toThrow(/nonce has the wrong length/);
    const { nonce, ct, tag } = seal();
    expect(() => gcmOpen(key.subarray(0, 16), nonce, tag, ct)).toThrow(/key has the wrong length/);
  });

  it('machine key: a sealed blob with a short tag is damaged, not a wrong password', async () => {
    const { sealed, machineKey } = await createSealedMachineKey('admin password here');
    zeroMachineKey(machineKey);
    const short = { ...sealed, tag: sealed.tag.slice(0, 8) };
    await expect(unsealMachineKey(short, 'admin password here')).rejects.toSatisfy((e: unknown) => HarborError.is(e, 'INVALID_PACKAGE') && /malformed nonce or tag/.test((e as Error).message));
    const longNonce = { ...sealed, nonce: sealed.nonce + 'abcd' };
    await expect(unsealMachineKey(longNonce, 'admin password here')).rejects.toSatisfy((e: unknown) => HarborError.is(e, 'INVALID_PACKAGE'));
  });

  it('machine-wrapped app key: a short tag is refused', () => {
    const machineKey = randomBytes(32);
    const wrapped = wrapMasterKeyForMachine(randomBytes(32), machineKey);
    expect(unwrapMasterKeyForMachine(wrapped, machineKey).length).toBe(32);
    expect(() => unwrapMasterKeyForMachine({ ...wrapped, tag: wrapped.tag.slice(0, 8) }, machineKey)).toThrow(/malformed nonce or tag/);
  });

  it('recovery file: a short tag is a corrupt header', async () => {
    const bundle = await sealRecoveryBundle(new Map([['harbor.db', Buffer.from('db')]]), 'correct horse recovery');
    const outer = readZip(bundle);
    const env = JSON.parse(outer.get('recovery.json')!.toString('utf8')) as { tag: string };
    const forged = writeZip({ 'recovery.json': Buffer.from(JSON.stringify({ ...env, tag: env.tag.slice(0, 8) })), 'recovery.bin': outer.get('recovery.bin')! });
    await expect(openRecoveryBundle(forged, 'correct horse recovery')).rejects.toThrow(/header is corrupt/);
    expect((await openRecoveryBundle(bundle, 'correct horse recovery')).get('harbor.db')?.toString()).toBe('db');
  });
});
