import { describe, expect, it } from 'vitest';
import { appUrlFrom } from '../../web/src/app/app-url.js';

const urls = { loopback: 'http://127.0.0.1:18080/', lan: 'http://harbor.local:18080/', lanSecure: 'https://harbor.local:38080/' };

describe('where Open takes you: the console scheme decides', () => {
  it('from an http console (untrusted browser or ?skiphttps) the plain LAN address, on the host the browser used', () => {
    expect(appUrlFrom(urls, 'loopback', { protocol: 'http:', hostname: 'harbor.local' })).toBe('http://harbor.local:18080/');
    expect(appUrlFrom(urls, 'loopback', { protocol: 'http:', hostname: '192.168.1.20' })).toBe('http://192.168.1.20:18080/');
  });
  it('from an https console the secure address', () => {
    expect(appUrlFrom(urls, 'loopback', { protocol: 'https:', hostname: 'harbor.local' })).toBe('https://harbor.local:38080/');
  });
  it('falls back to whichever LAN address exists, then loopback', () => {
    expect(appUrlFrom({ loopback: urls.loopback, lanSecure: urls.lanSecure }, 'loopback', { protocol: 'http:', hostname: 'harbor.local' })).toBe('https://harbor.local:38080/');
    expect(appUrlFrom({ loopback: urls.loopback, lan: urls.lan }, 'loopback', { protocol: 'https:', hostname: 'harbor.local' })).toBe('http://harbor.local:18080/');
    expect(appUrlFrom({ loopback: urls.loopback }, 'loopback', { protocol: 'http:', hostname: 'harbor.local' })).toBe(urls.loopback);
  });
  it('a loopback console opens loopback over http, the secure address over https', () => {
    expect(appUrlFrom(urls, 'loopback', { protocol: 'http:', hostname: '127.0.0.1' })).toBe(urls.loopback);
    expect(appUrlFrom(urls, 'loopback', { protocol: 'https:', hostname: 'localhost' })).toBe(urls.lanSecure);
  });
  it('a tailnet or public main address always wins', () => {
    expect(appUrlFrom({ ...urls, public: 'https://cloud.example.com/' }, 'public', { protocol: 'http:', hostname: 'harbor.local' })).toBe('https://cloud.example.com/');
  });
});
