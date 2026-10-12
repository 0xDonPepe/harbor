import { describe, expect, it } from 'vitest';
import { httpsTarget, skipHttpsRequested } from '../../web/src/app/https-target.js';

function mem(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}
const loc = (hostname: string, search = '', protocol = 'http:') => ({ protocol, hostname, pathname: '/', search, hash: '#/settings/network' });

// Decision 164: the console moves to https only for a name the certificate covers; ?skiphttps keeps it on http.
describe('https redirect', () => {
  it('targets the same name over https, keeping the route and dropping skiphttps', () => {
    expect(httpsTarget(loc('harbor.local', '?a=1&skiphttps=false'), ['harbor.local', 'box.local'])).toBe('https://harbor.local/?a=1#/settings/network');
    expect(httpsTarget(loc('192.168.1.20'), ['harbor.local', '192.168.1.20'])).toBe('https://192.168.1.20/#/settings/network');
  });
  it('never moves a name the certificate does not cover, or a page already on https', () => {
    expect(httpsTarget(loc('localhost'), ['harbor.local'])).toBeNull();
    expect(httpsTarget(loc('harbor.local', '', 'https:'), ['harbor.local'])).toBeNull();
  });
  it('?skiphttps sticks for the tab; ?skiphttps=false clears it', () => {
    const s = mem();
    expect(skipHttpsRequested('', s)).toBe(false);
    expect(skipHttpsRequested('?skiphttps=true', s)).toBe(true);
    expect(skipHttpsRequested('', s)).toBe(true);
    expect(skipHttpsRequested('?skiphttps=false', s)).toBe(false);
    expect(skipHttpsRequested('?skiphttps', s)).toBe(true);
  });
});
