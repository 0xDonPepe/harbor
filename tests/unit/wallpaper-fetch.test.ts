import { describe, expect, it } from 'vitest';
import { MAX_REDIRECTS, RealFetcher } from '../../src/appearance/fetcher.js';
import { assertPublicHttpsUrl, isPublicAddress } from '../../src/appearance/url-guard.js';

// Decision 169: the wallpaper fetcher never reaches this machine or the home network, not even through a redirect.
const PUBLIC = '93.184.215.14';
const dns: Record<string, string[]> = {
  'images.example.com': [PUBLIC],
  'cdn.example.com': ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
  'rebind.example.com': ['10.0.0.5'],
  'mixed.example.com': [PUBLIC, '192.168.1.10'],
};
const resolve = async (h: string) => {
  const a = dns[h];
  if (!a) throw new Error('ENOTFOUND');
  return a;
};

type Hop = { status: number; location?: string; body?: string };
function fakeFetch(routes: Record<string, Hop>) {
  const calls: { url: string; method: string; headers: Record<string, string>; redirect: string | undefined; body?: string }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    const r = routes[u];
    if (!r) return new Response('nope', { status: 404 });
    return new Response(r.body ?? '', { status: r.status, headers: r.location ? { location: r.location } : {} });
  }) as typeof fetch;
  return { impl, calls };
}

describe('wallpaper URL guard', () => {
  it('knows public from local addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.100', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1', '255.255.255.255']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of [PUBLIC, '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(a), a).toBe(true);
    expect(isPublicAddress('not-an-ip')).toBe(false);
  });

  it('judges IPv6 forms that carry an IPv4 address by that address, in hex as URLs and DNS write them', () => {
    const refused = [
      '64:ff9b::7f00:1', // NAT64 of 127.0.0.1
      '64:ff9b::a00:1', // NAT64 of 10.0.0.1
      '64:ff9b::127.0.0.1',
      '::7f00:1', // IPv4-compatible 127.0.0.1
      '::127.0.0.1',
      '::a9fe:a9fe', // 169.254.169.254
      '::ffff:0:7f00:1', // IPv4-translated (SIIT)
      '::ffff:0:a00:1',
      '::ffff:0:10.0.0.1',
      '2002:7f00:1::1', // 6to4 of 127.0.0.1
      '2002:c0a8:101::1', // 6to4 of 192.168.1.1
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
      '0:0:0:0:0:ffff:7f00:1',
    ];
    for (const a of refused) expect(isPublicAddress(a), a).toBe(false);
    for (const a of ['64:ff9b::808:808', '2002:808:808::1', '::ffff:0:808:808']) expect(isPublicAddress(a), a).toBe(true);
  });

  it('refuses those forms as URL literals too (the URL parser rewrites them to hex first)', async () => {
    for (const u of ['https://[64:ff9b::127.0.0.1]/', 'https://[64:ff9b::10.0.0.1]/', 'https://[::127.0.0.1]/', 'https://[::ffff:0:10.0.0.1]/', 'https://[2002:7f00:1::1]/']) {
      await expect(assertPublicHttpsUrl(u, resolve), u).rejects.toThrow(/local or private/);
    }
    // and when a name resolves to one of them
    await expect(assertPublicHttpsUrl('https://nat64.example.com/', async () => ['64:ff9b::a00:1'])).rejects.toThrow(/resolves to a local or private address/);
  });

  it('allows https to a public name or address, refuses everything else', async () => {
    await expect(assertPublicHttpsUrl('https://images.example.com/a.jpg', resolve)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicHttpsUrl(`https://${PUBLIC}/a.jpg`, resolve)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicHttpsUrl('https://cdn.example.com/a.jpg', resolve)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicHttpsUrl('http://images.example.com/a.jpg', resolve)).rejects.toThrow(/only https/);
    await expect(assertPublicHttpsUrl('file:///etc/passwd', resolve)).rejects.toThrow(/only https/);
    await expect(assertPublicHttpsUrl('https://127.0.0.1:8080/', resolve)).rejects.toThrow(/local or private/);
    await expect(assertPublicHttpsUrl('https://[::1]/', resolve)).rejects.toThrow(/local or private/);
    await expect(assertPublicHttpsUrl('https://169.254.169.254/latest/meta-data', resolve)).rejects.toThrow(/local or private/);
    await expect(assertPublicHttpsUrl('https://localhost/', resolve)).rejects.toThrow(/local name/);
    await expect(assertPublicHttpsUrl('https://harbor.local/', resolve)).rejects.toThrow(/local name/);
    await expect(assertPublicHttpsUrl('https://rebind.example.com/', resolve)).rejects.toThrow(/resolves to a local or private address \(10\.0\.0\.5\)/);
    await expect(assertPublicHttpsUrl('https://mixed.example.com/', resolve)).rejects.toThrow(/192\.168\.1\.10/);
    await expect(assertPublicHttpsUrl('https://user:pw@images.example.com/', resolve)).rejects.toThrow(/credentials/);
  });
});

describe('RealFetcher redirects', () => {
  it('follows a redirect to a public https URL by hand, checking each hop', async () => {
    const f = fakeFetch({
      'https://images.example.com/a.jpg': { status: 302, location: '/b.jpg' },
      'https://images.example.com/b.jpg': { status: 301, location: 'https://cdn.example.com/c.jpg' },
      'https://cdn.example.com/c.jpg': { status: 200, body: 'JPEG' },
    });
    const r = await new RealFetcher({ fetchImpl: f.impl, resolve }).fetch('https://images.example.com/a.jpg');
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('JPEG');
    expect(f.calls.map((c) => c.url)).toEqual(['https://images.example.com/a.jpg', 'https://images.example.com/b.jpg', 'https://cdn.example.com/c.jpg']);
    expect(f.calls.every((c) => c.redirect === 'manual')).toBe(true);
  });

  it('refuses a redirect into the home network, to plain http, or to a name that resolves privately', async () => {
    for (const location of ['https://127.0.0.1/admin', 'http://images.example.com/x.jpg', 'https://rebind.example.com/x.jpg', 'https://192.168.1.1/', 'https://[fd00::1]/']) {
      const f = fakeFetch({ 'https://images.example.com/a.jpg': { status: 302, location } });
      await expect(new RealFetcher({ fetchImpl: f.impl, resolve }).fetch('https://images.example.com/a.jpg'), location).rejects.toThrow(/refusing|only https/);
      expect(f.calls).toHaveLength(1); // the private hop was never requested
    }
  });

  it('refuses the first URL too, and stops after the hop limit', async () => {
    const f0 = fakeFetch({});
    await expect(new RealFetcher({ fetchImpl: f0.impl, resolve }).fetch('https://10.0.0.1/a.jpg')).rejects.toThrow(/local or private/);
    expect(f0.calls).toHaveLength(0);
    const loop: Record<string, Hop> = {};
    for (let i = 0; i <= MAX_REDIRECTS + 1; i++) loop[`https://images.example.com/${i}`] = { status: 302, location: `/${i + 1}` };
    const f = fakeFetch(loop);
    await expect(new RealFetcher({ fetchImpl: f.impl, resolve }).fetch('https://images.example.com/0')).rejects.toThrow(/too many redirects/);
    expect(f.calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('drops the authorization header on a redirect to another host and turns a 302 POST into a GET', async () => {
    const f = fakeFetch({
      'https://images.example.com/token': { status: 302, location: 'https://cdn.example.com/token' },
      'https://cdn.example.com/token': { status: 200, body: '{}' },
    });
    await new RealFetcher({ fetchImpl: f.impl, resolve }).fetch('https://images.example.com/token', { method: 'POST', body: 'grant_type=client_credentials', headers: { authorization: 'Basic FIXTURE' } });
    expect(f.calls[0]).toMatchObject({ method: 'POST', body: 'grant_type=client_credentials' });
    expect(f.calls[0]!.headers['authorization']).toBe('Basic FIXTURE');
    expect(f.calls[1]!.method).toBe('GET');
    expect(f.calls[1]!.body).toBeUndefined();
    expect(f.calls[1]!.headers['authorization']).toBeUndefined();
  });
});
