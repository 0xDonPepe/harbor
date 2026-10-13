// Cookie firewall (decision 167): the pure rewrite of Set-Cookie and the Cookie filter the LAN HTTPS relay applies.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cookieTag, filterCookieHeader, isCrossAppRequest, loadCookieKey, rewriteSetCookies, taggedName } from '../../src/system/cookie-firewall.js';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const A = cookieTag('11111111-1111-4111-8111-111111111111');
const B = cookieTag('22222222-2222-4222-8222-222222222222');

// What a browser sends back for a Set-Cookie it accepted (name=value only).
const jar = (headers: string[]) => headers.map((h) => h.split(';')[0]!).join('; ');

describe('cookie tag + key', () => {
  it('is 8 hex chars, stable per instance id, different between instances', () => {
    expect(A).toMatch(/^[0-9a-f]{8}$/);
    expect(cookieTag('11111111-1111-4111-8111-111111111111')).toBe(A);
    expect(A).not.toBe(B);
  });
  it('creates a 32-byte key once (0600) and reads the same one back', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-cookie-key-'));
    const k1 = loadCookieKey(dir);
    expect(k1.length).toBe(32);
    expect(statSync(path.join(dir, 'cookie-firewall.key')).mode & 0o777).toBe(0o600);
    expect(loadCookieKey(dir).equals(k1)).toBe(true);
    expect(readFileSync(path.join(dir, 'cookie-firewall.key')).equals(k1)).toBe(true);
    writeFileSync(path.join(dir, 'cookie-firewall.key'), 'short');
    expect(() => loadCookieKey(dir)).toThrow(/32 bytes/);
  });
  it('keeps a __Host- / __Secure- prefix in front of the tag', () => {
    expect(taggedName('1a2b3c4d', '__Host-sid')).toBe('__Host-hb_1a2b3c4d__sid');
    expect(taggedName('1a2b3c4d', '__Secure-sid')).toBe('__Secure-hb_1a2b3c4d__sid');
    expect(taggedName('1a2b3c4d', 'sid')).toBe('hb_1a2b3c4d__sid');
  });
});

describe('Set-Cookie rewrite', () => {
  it('tags and signs HttpOnly cookies, forces Secure, drops Domain, keeps the other attributes', () => {
    const r = rewriteSetCookies('sid=abc123; Path=/app; Domain=harbor.local; HttpOnly; SameSite=Lax; Max-Age=3600; Partitioned', { tag: A, key: KEY });
    expect(r.headers).toHaveLength(1);
    const h = r.headers[0]!;
    expect(h).toMatch(new RegExp(`^hb_${A}__sid=abc123\\.[A-Za-z0-9_-]{22}; `));
    expect(h).toContain('Path=/app');
    expect(h).toContain('HttpOnly');
    expect(h).toContain('SameSite=Lax');
    expect(h).toContain('Max-Age=3600');
    expect(h).toContain('Partitioned');
    expect(h).toMatch(/; Secure$/);
    expect(h.toLowerCase()).not.toContain('domain=');
    expect(r.isolatedNames).toEqual(['sid']);
  });
  it('passes non-HttpOnly cookies unchanged (the app\'s own scripts read them)', () => {
    const r = rewriteSetCookies(['theme=dark; Path=/', 'csrf=tok; Secure; SameSite=Strict'], { tag: A, key: KEY });
    expect(r.headers).toEqual(['theme=dark; Path=/', 'csrf=tok; Secure; SameSite=Strict']);
    expect(r.plainNames).toEqual(['theme', 'csrf']);
  });
  it('handles several Set-Cookie headers in one response', () => {
    const r = rewriteSetCookies(['a=1; HttpOnly', 'b=2', '__Host-c=3; Path=/; Secure; HttpOnly'], { tag: A, key: KEY });
    expect(r.headers.map((h) => h.split('=')[0])).toEqual([`hb_${A}__a`, 'b', `__Host-hb_${A}__c`]);
  });
  it('a deletion carries the same tag (and also goes out untagged, clearing an older untagged cookie)', () => {
    for (const del of ['sid=; Path=/; HttpOnly; Max-Age=0', 'sid=deleted; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly', 'sid=; Path=/; Max-Age=0']) {
      const r = rewriteSetCookies(del, { tag: A, key: KEY });
      expect(r.headers[0]).toBe(del);
      expect(r.headers[1]).toMatch(new RegExp(`^hb_${A}__sid=`));
      expect(r.headers[1]).toContain('Path=/');
      expect(r.isolatedNames).toEqual([]);
    }
  });
  it("drops a non-HttpOnly cookie named like a tagged one (it could only overwrite another app's)", () => {
    const r = rewriteSetCookies([`hb_${B}__sid=x; Path=/`, `__Host-hb_${B}__sid=; Path=/; Max-Age=0`, 'ok=1'], { tag: A, key: KEY });
    expect(r.headers).toEqual(['ok=1']);
    expect(r.refused).toEqual([`hb_${B}__sid`, `__Host-hb_${B}__sid`]);
  });
  it('leaves a cookie that would exceed 4096 bytes unchanged and reports its name only', () => {
    const big = 'x'.repeat(4080);
    const r = rewriteSetCookies(`big=${big}; HttpOnly`, { tag: A, key: KEY });
    expect(r.headers).toEqual([`big=${big}; HttpOnly`]);
    expect(r.oversize).toEqual(['big']);
    expect(r.isolatedNames).toEqual([]);
  });
});

describe('Cookie filter', () => {
  const setA = rewriteSetCookies(['sid=alpha; HttpOnly', '__Host-tok=t1; Path=/; Secure; HttpOnly'], { tag: A, key: KEY }).headers;
  const setB = rewriteSetCookies(['sid=bravo; HttpOnly'], { tag: B, key: KEY }).headers;

  it('gives an app its own cookies back under their original names', () => {
    expect(filterCookieHeader(jar(setA), { tag: A, key: KEY }).cookie).toBe('sid=alpha; __Host-tok=t1');
  });
  it("drops another app's tagged cookies", () => {
    const r = filterCookieHeader(jar([...setA, ...setB]), { tag: B, key: KEY });
    expect(r.cookie).toBe('sid=bravo');
    expect(r.dropped).toBe(2);
  });
  it('drops forged tags: a wrong signature, a missing signature, a signature from another key', () => {
    const forged = rewriteSetCookies(['sid=evil; HttpOnly'], { tag: A, key: OTHER_KEY }).headers;
    const r = filterCookieHeader(`hb_${A}__sid=evil.AAAAAAAAAAAAAAAAAAAAAA; hb_${A}__x=nosig; ${jar(forged)}; plain=1`, { tag: A, key: KEY });
    expect(r.cookie).toBe('plain=1');
    expect(r.dropped).toBe(3);
  });
  it('a signed value cannot be moved to another name', () => {
    const [, sig] = setA[0]!.split(';')[0]!.split('=');
    expect(filterCookieHeader(`hb_${A}__admin=${sig}`, { tag: A, key: KEY }).cookie).toBeUndefined();
  });
  it('drops an untagged cookie that shadows one of the app\'s signed names', () => {
    expect(filterCookieHeader(`sid=planted; ${jar(setA)}`, { tag: A, key: KEY }).cookie).toBe('sid=alpha; __Host-tok=t1');
    expect(filterCookieHeader('sid=planted; theme=dark', { tag: A, key: KEY, isolatedNames: new Set(['sid']) }).cookie).toBe('theme=dark');
  });
  it('passes untagged cookies, keeps their order, and returns undefined when nothing is left', () => {
    expect(filterCookieHeader('a=1; b=2', { tag: A, key: KEY }).cookie).toBe('a=1; b=2');
    expect(filterCookieHeader(jar(setB), { tag: A, key: KEY }).cookie).toBeUndefined();
    expect(filterCookieHeader(undefined, { tag: A, key: KEY }).cookie).toBeUndefined();
  });
  it('a shared endpoint keeps untagged cookies but never sees an isolated app\'s', () => {
    expect(filterCookieHeader(`x=1; ${jar(setA)}`, { tag: null, key: KEY }).cookie).toBe('x=1');
  });
});

describe('cross-app requests', () => {
  const ports = new Map<number, string>([
    [18080, A],
    [38080, A],
    [18090, B],
    [38090, B],
  ]);
  it('refuses unsafe methods and WebSocket handshakes from another Harbor app on the same host', () => {
    expect(isCrossAppRequest({ method: 'POST', origin: 'https://harbor.local:38090', host: 'harbor.local:38080' }, A, ports)).toBe(true);
    expect(isCrossAppRequest({ method: 'DELETE', origin: 'http://harbor.local:18090', host: 'harbor.local:38080' }, A, ports)).toBe(true);
    expect(isCrossAppRequest({ method: 'GET', origin: 'https://harbor.local:38090', host: 'harbor.local:38080', upgrade: true }, A, ports)).toBe(true);
  });
  it('lets same-app, absent, console, other-host and safe-method requests through', () => {
    expect(isCrossAppRequest({ method: 'POST', origin: 'https://harbor.local:38080', host: 'harbor.local:38080' }, A, ports)).toBe(false);
    expect(isCrossAppRequest({ method: 'POST', origin: 'http://harbor.local:18080', host: 'harbor.local:38080' }, A, ports)).toBe(false);
    expect(isCrossAppRequest({ method: 'POST', host: 'harbor.local:38080' }, A, ports)).toBe(false);
    expect(isCrossAppRequest({ method: 'POST', origin: 'https://harbor.local', host: 'harbor.local:38080' }, A, ports)).toBe(false);
    expect(isCrossAppRequest({ method: 'POST', origin: 'https://other.local:38090', host: 'harbor.local:38080' }, A, ports)).toBe(false);
    expect(isCrossAppRequest({ method: 'GET', origin: 'https://harbor.local:38090', host: 'harbor.local:38080' }, A, ports)).toBe(false);
    expect(isCrossAppRequest({ method: 'POST', origin: 'https://harbor.local:9999', host: 'harbor.local:38080' }, A, ports)).toBe(false);
  });
});
