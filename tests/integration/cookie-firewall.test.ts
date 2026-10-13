// Cookie firewall (decision 167) end to end through the LAN HTTPS relay: two apps on one host name behind two
// secure ports, a browser-like cookie jar scoped by host (not port, like a real browser), and the relay between.
// B's server never receives A's session; a cookie B's script plants for A is dropped at A; a POST from B's page to
// A is refused; a `cookies: shared` endpoint keeps its own cookies untagged but never sees A's.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieTag, loadCookieKey } from '../../src/system/cookie-firewall.js';
import { ensureTlsCerts, LanHttpsServers, tlsKeyPair, type RelayEndpoint } from '../../src/system/lan-https.js';
import { freePort } from './harness.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// A browser's jar for one host: every port shares it (that is the problem the firewall solves).
class Jar {
  cookies = new Map<string, string>();
  take(setCookie: string[] | undefined): void {
    for (const h of setCookie ?? []) {
      const [pair, ...attrs] = h.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const gone = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
      if (gone) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([n, v]) => `${n}=${v}`).join('; ');
  }
}

const names = (cookie: string | undefined) => (cookie ?? '').split('; ').filter(Boolean).sort();

interface Seen {
  method: string;
  url: string;
  cookie: string | undefined;
}

function fakeApp(seen: Seen[], setCookies: Record<string, string[]>): Server {
  const app = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', cookie: req.headers.cookie });
    res.writeHead(200, { 'content-type': 'text/plain', ...(setCookies[req.url ?? ''] ? { 'set-cookie': setCookies[req.url ?? '']! } : {}) });
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  app.on('upgrade', (req, socket) => {
    seen.push({ method: 'UPGRADE', url: req.url ?? '', cookie: req.headers.cookie });
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: ws=1; HttpOnly\r\n\r\n');
  });
  return app;
}

function call(port: number, opts: { method?: string; path?: string; jar: Jar; origin?: string; upgrade?: boolean; headers?: Record<string, string> }): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const cookie = opts.jar.header();
    const req = httpsRequest({
      host: '127.0.0.1',
      port,
      path: opts.path ?? '/',
      method: opts.method ?? 'GET',
      rejectUnauthorized: false,
      agent: false,
      headers: {
        host: `harbor.local:${port}`,
        ...(cookie ? { cookie } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.headers ?? {}),
        ...(opts.upgrade ? { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } : {}),
      },
    });
    req.on('upgrade', (res, socket: Socket) => {
      opts.jar.take(res.headers['set-cookie']);
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' });
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => {
        opts.jar.take(res.headers['set-cookie']);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('cookie firewall through the LAN HTTPS relay', () => {
  const ok = hasOpenssl();
  let dir = '';
  const servers = new LanHttpsServers();
  const apps: Server[] = [];
  const seenA: Seen[] = [];
  const seenB: Seen[] = [];
  const seenC: Seen[] = [];
  const seenD: Seen[] = [];
  let portA = 0;
  let portB = 0;
  let portC = 0;
  let portD = 0; // a second, `cookies: shared` endpoint of A's own instance
  const tagA = cookieTag('aaaaaaaa-1111-4111-8111-111111111111');
  const tagB = cookieTag('bbbbbbbb-2222-4222-8222-222222222222');
  const tagC = cookieTag('cccccccc-3333-4333-8333-333333333333');

  beforeAll(async () => {
    if (!ok) return;
    dir = mkdtempSync(path.join(tmpdir(), 'harbor-cookies-'));
    await ensureTlsCerts(dir, ['harbor.local']);
    const { key, cert } = tlsKeyPair(dir);
    const specs: [Seen[], Record<string, string[]>][] = [
      [seenA, { '/login': ['sid=alpha-session; Path=/; HttpOnly; SameSite=Lax', 'theme=dark; Path=/'], '/logout': ['sid=; Path=/; HttpOnly; Max-Age=0'] }],
      [seenB, { '/login': ['sid=bravo-session; Path=/; HttpOnly'] }],
      [seenC, { '/login': ['shared_sid=charlie; Path=/; HttpOnly'], '/plant': [`hb_${tagA}__sid=evil; Path=/; HttpOnly`] }],
      [seenD, { '/login': ['sid=delta; Path=/; HttpOnly'] }],
    ];
    const appPorts: number[] = [];
    for (const [seen, sets] of specs) {
      const app = fakeApp(seen, sets);
      await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
      apps.push(app);
      appPorts.push((app.address() as AddressInfo).port);
    }
    [portA, portB, portC, portD] = [await freePort(), await freePort(), await freePort(), await freePort()];
    const ep = (tag: string, cookies: RelayEndpoint['cookies'], label: string): RelayEndpoint => ({ tag, cookies, label });
    servers.setPolicy({
      key: loadCookieKey(dir),
      bySecurePort: new Map([
        [portA, ep(tagA, 'isolated', 'Alpha')],
        [portB, ep(tagB, 'isolated', 'Bravo')],
        [portC, ep(tagC, 'shared', 'Charlie')],
        [portD, ep(tagA, 'shared', 'Alpha')],
      ]),
      portTags: new Map([
        [portA, tagA],
        [appPorts[0]!, tagA],
        [portB, tagB],
        [appPorts[1]!, tagB],
        [portC, tagC],
        [appPorts[2]!, tagC],
        [portD, tagA],
        [appPorts[3]!, tagA],
      ]),
    });
    await servers.ensureAppProxy(portA, appPorts[0]!, key, cert);
    await servers.ensureAppProxy(portB, appPorts[1]!, key, cert);
    await servers.ensureAppProxy(portC, appPorts[2]!, key, cert);
    await servers.ensureAppProxy(portD, appPorts[3]!, key, cert);
  });
  afterAll(async () => {
    if (!ok) return;
    await servers.closeAll();
    for (const a of apps) {
      a.closeAllConnections();
      await new Promise<void>((r) => a.close(() => r()));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("B's server never receives A's session, and A gets it back under its own name", async () => {
    if (!ok) return;
    const jar = new Jar();
    const login = await call(portA, { path: '/login', jar });
    expect(login.status).toBe(200);
    // the browser holds a tagged, signed, Secure cookie, and A's non-HttpOnly cookie unchanged
    const stored = [...jar.cookies.keys()];
    expect(stored).toContain(`hb_${tagA}__sid`);
    expect(stored).toContain('theme');
    expect(jar.cookies.get(`hb_${tagA}__sid`)).toMatch(/^alpha-session\./);
    expect((login.headers['set-cookie'] ?? []).find((c) => c.startsWith('hb_'))).toMatch(/; Secure$/);
    await call(portA, { path: '/me', jar });
    expect(names(seenA.at(-1)!.cookie)).toEqual(['sid=alpha-session', 'theme=dark']);
    await call(portB, { path: '/login', jar });
    await call(portB, { path: '/me', jar });
    expect(names(seenB.at(-1)!.cookie)).toEqual(['sid=bravo-session', 'theme=dark']);
    for (const s of seenB) expect(s.cookie ?? '').not.toContain('alpha');
    // A still sees only its own session after B logged in on the same host
    await call(portA, { path: '/me', jar });
    expect(names(seenA.at(-1)!.cookie)).toEqual(['sid=alpha-session', 'theme=dark']);
  });

  it("a cookie B's script plants for A is dropped (forged tag, or an untagged shadow of A's name)", async () => {
    if (!ok) return;
    const jar = new Jar();
    await call(portA, { path: '/login', jar });
    jar.cookies.set(`hb_${tagA}__admin`, 'yes.AAAAAAAAAAAAAAAAAAAAAA');
    jar.cookies.set('sid', 'planted-by-b');
    await call(portA, { path: '/me', jar });
    expect(names(seenA.at(-1)!.cookie)).toEqual(['sid=alpha-session', 'theme=dark']);
  });

  it('logout clears the tagged cookie', async () => {
    if (!ok) return;
    const jar = new Jar();
    await call(portA, { path: '/login', jar });
    await call(portA, { path: '/logout', jar });
    expect([...jar.cookies.keys()]).not.toContain(`hb_${tagA}__sid`);
  });

  it("refuses a POST and a WebSocket from another app's page; same-app and no-Origin requests pass", async () => {
    if (!ok) return;
    const jar = new Jar();
    const cross = await call(portA, { method: 'POST', path: '/transfer', jar, origin: `https://harbor.local:${portB}` });
    expect(cross.status).toBe(403);
    expect(cross.headers['content-type']).toContain('text/plain');
    expect(seenA.some((s) => s.url === '/transfer')).toBe(false);
    const ws = await call(portA, { path: '/socket', jar, origin: `https://harbor.local:${portB}`, upgrade: true });
    expect(ws.status).toBe(403);
    expect((await call(portA, { method: 'POST', path: '/save', jar, origin: `https://harbor.local:${portA}` })).status).toBe(200);
    expect((await call(portA, { method: 'POST', path: '/save2', jar })).status).toBe(200);
  });

  it("WebSocket handshakes get the same cookie filter (and the app's 101 Set-Cookie is tagged)", async () => {
    if (!ok) return;
    const jar = new Jar();
    await call(portA, { path: '/login', jar });
    await call(portB, { path: '/login', jar });
    const ws = await call(portB, { path: '/socket', jar, upgrade: true });
    expect(ws.status).toBe(101);
    expect(seenB.at(-1)!.method).toBe('UPGRADE');
    expect(names(seenB.at(-1)!.cookie)).toEqual(['sid=bravo-session', 'theme=dark']);
    expect([...jar.cookies.keys()]).toContain(`hb_${tagB}__ws`);
  });

  it('a `cookies: shared` endpoint keeps its own cookies untagged but never receives an isolated app\'s', async () => {
    if (!ok) return;
    const jar = new Jar();
    await call(portA, { path: '/login', jar });
    await call(portC, { path: '/login', jar });
    expect(jar.cookies.get('shared_sid')).toBe('charlie');
    await call(portC, { path: '/me', jar });
    expect(names(seenC.at(-1)!.cookie)).toEqual(['shared_sid=charlie', 'theme=dark']);
  });

  // Review fixes (decision 167)
  it("an untagged session from before 0.32.0 is cleared the first time A sets its tagged one, so B never receives it", async () => {
    if (!ok) return;
    const jar = new Jar();
    jar.cookies.set('sid', 'alpha-before-upgrade');
    await call(portA, { path: '/login', jar });
    expect(jar.cookies.has('sid')).toBe(false);
    expect([...jar.cookies.keys()]).toContain(`hb_${tagA}__sid`);
    await call(portB, { path: '/me', jar });
    expect(seenB.at(-1)!.cookie ?? '').not.toContain('alpha');
  });

  it("a shared endpoint of A's own instance keeps its own untagged cookie of a name A's isolated endpoint also uses", async () => {
    if (!ok) return;
    const jar = new Jar();
    await call(portA, { path: '/login', jar });
    await call(portD, { path: '/login', jar });
    await call(portD, { path: '/me', jar });
    expect(names(seenD.at(-1)!.cookie)).toEqual(['sid=delta', 'theme=dark']);
    // the isolated endpoint still gets only its signed one
    await call(portA, { path: '/me', jar });
    expect(names(seenA.at(-1)!.cookie)).toEqual(['sid=alpha-session', 'theme=dark']);
  });

  it("a shared endpoint cannot set a cookie under A's tagged name (it would log A out)", async () => {
    if (!ok) return;
    const jar = new Jar();
    await call(portA, { path: '/login', jar });
    const signed = jar.cookies.get(`hb_${tagA}__sid`);
    const r = await call(portC, { path: '/plant', jar });
    expect(r.headers['set-cookie'] ?? []).toEqual([]);
    expect(jar.cookies.get(`hb_${tagA}__sid`)).toBe(signed);
  });

  it('refuses a POST with Origin null that the browser calls same-site (a redirect hop through another app)', async () => {
    if (!ok) return;
    const jar = new Jar();
    const r = await call(portA, { method: 'POST', path: '/transfer-null', jar, origin: 'null', headers: { 'sec-fetch-site': 'same-site' } });
    expect(r.status).toBe(403);
    expect(seenA.some((s) => s.url === '/transfer-null')).toBe(false);
    expect((await call(portA, { method: 'POST', path: '/own', jar, origin: `https://harbor.local:${portA}`, headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
  });
});
