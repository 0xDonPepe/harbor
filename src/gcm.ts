import { createDecipheriv, type DecipherGCM } from 'node:crypto';

// Decision 169: every AES-256-GCM decryption in Harbor goes through here. Node accepts a short
// authentication tag (down to 4 bytes) and any nonce length unless told otherwise, which turns a
// forged blob into a much easier guess. Harbor only ever writes 12-byte nonces and 16-byte tags,
// so anything else is refused before a decipher exists.
export const GCM_KEY_BYTES = 32;
export const GCM_NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;

export class GcmShapeError extends Error {
  constructor(what: string) {
    super(`AES-256-GCM ${what} has the wrong length`);
    this.name = 'GcmShapeError';
  }
}

/** True when nonce and tag have the only lengths Harbor writes. */
export function gcmShapeOk(nonce: Buffer, tag: Buffer): boolean {
  return nonce.length === GCM_NONCE_BYTES && tag.length === GCM_TAG_BYTES;
}

/** A decipher pinned to a 16-byte tag, with the tag set. Throws GcmShapeError on a wrong key, nonce or tag length. */
export function gcmDecipher(key: Buffer, nonce: Buffer, tag: Buffer): DecipherGCM {
  if (key.length !== GCM_KEY_BYTES) throw new GcmShapeError('key');
  if (nonce.length !== GCM_NONCE_BYTES) throw new GcmShapeError('nonce');
  if (tag.length !== GCM_TAG_BYTES) throw new GcmShapeError('tag');
  const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: GCM_TAG_BYTES });
  d.setAuthTag(tag);
  return d;
}

/** Decrypt and authenticate in one call. */
export function gcmOpen(key: Buffer, nonce: Buffer, tag: Buffer, ciphertext: Buffer): Buffer {
  const d = gcmDecipher(key, nonce, tag);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}
