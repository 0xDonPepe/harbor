import { describe, expect, it } from 'vitest';
import { ntfyHeaderValue } from '../../src/notify/notifier.js';

// A notification title with an emoji or Cyrillic made fetch throw before it left the machine; ntfy reads RFC 2047.
describe('ntfy title header', () => {
  it('keeps plain ASCII as it is', () => {
    expect(ntfyHeaderValue('Update of memos failed; the previous version is back')).toBe('Update of memos failed; the previous version is back');
  });
  it('encodes anything else as an RFC 2047 word that a header can carry and that decodes back', () => {
    for (const title of ['Фото connected', 'Backup ✓', 'Tüte', 'nueva versión 🎉']) {
      const v = ntfyHeaderValue(title);
      expect(v).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(() => new Headers({ title: v })).not.toThrow();
      expect(Buffer.from(v.slice(10, -2), 'base64').toString('utf8')).toBe(title);
    }
    expect(() => new Headers({ title: 'Фото' })).toThrow(); // what used to be sent
  });
});
