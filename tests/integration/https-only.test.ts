// HTTPS only (decision 167): only allowed while secure addresses are on and from a request that arrived over https
// (or from this machine); the plain-http LAN console then redirects everything to https except the CA download and
// the probe; Caddy's :80 route does the same; apps re-render on loopback with the relay marker on their next restart
// and the relay keeps serving them; turning it off is always allowed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { InstanceSummary, NetworkHttpsDto, PackageImportResultDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { cookieTag } from '../../src/system/cookie-firewall.js';
import { lanHttpsPort } from '../../src/system/lan-https.js';
import { isPrivateIPv4 } from '../../src/system/lan.js';
import { freePort, startHarness, type Harness } from './harness.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// node:http, not fetch: fetch drops a custom Host header
function plain(port: number, method: string, pathname: string): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path: pathname, headers: { host: `harbor.local:${port}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

// A real LAN peer: this machine's own private IPv4 address as the source (not loopback), straight to the LAN listener.
const lanAddress = () => Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && isPrivateIPv4(a.address))?.address ?? null;
function fromLanPeer(ip: string, port: number, token: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest({ host: ip, port, localAddress: ip, method: 'PUT', path: '/v1/network/https', headers: { host: `harbor.local:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.on('data', (d: Buffer) => (text += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const ports = (stateDir: string, id: string) => {
  const doc = parseYaml(readFileSync(path.join(stateDir, 'instances', id, 'runtime', 'compose.yaml'), 'utf8')) as { 'x-harbor'?: unknown; services: Record<string, { ports?: { host_ip: string }[] }> };
  return { hostIps: Object.values(doc.services).flatMap((s) => (s.ports ?? []).map((p) => p.host_ip)), marker: doc['x-harbor'] };
};

describe('HTTPS only', () => {
  const ok = hasOpenssl();
  let h: Harness;
  let lanPort = 0;
  let app: InstanceSummary;
  beforeAll(async () => {
    lanPort = await freePort();
    h = await startHarness({ portRange: { from: 18300, to: 18330 }, config: { lan: { enabled: true, port: lanPort } } });
    const r = await h.api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(r.op.state).toBe('succeeded');
    app = (await h.api.instances()).find((i) => i.packageId === 'excalidraw')!;
  });
  afterAll(async () => h.close());

  it('is off by default and needs secure addresses on', async () => {
    const st = await h.api.expect<NetworkHttpsDto>(200, 'GET', '/v1/network/https');
    expect(st.httpsOnly).toBe(false);
    await h.api.expectError(409, 'INVALID_STATE', 'PUT', '/v1/network/https', { enabled: false, httpsOnly: true });
  });

  it('refuses to turn on from a plain-http request that came through a proxy, allows https and this machine', async () => {
    if (!ok) return;
    await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: true });
    // a browser on the LAN talking plain http to the daemon's own LAN listener (no proxy in between)
    const ip = lanAddress();
    if (ip) {
      const peer = await fromLanPeer(ip, lanPort, h.token, { enabled: true, httpsOnly: true });
      expect(peer.status, peer.body).toBe(409);
      expect(peer.body).toMatch(/over https/);
      expect((await h.api.expect<NetworkHttpsDto>(200, 'GET', '/v1/network/https')).httpsOnly).toBe(false);
    }
    // what Caddy's :80 route sends for a LAN browser: loopback peer, X-Forwarded-For, X-Forwarded-Proto http
    const viaHttp = await h.api.expectError(409, 'INVALID_STATE', 'PUT', '/v1/network/https', { enabled: true, httpsOnly: true }, { 'x-forwarded-for': '192.168.1.50', 'x-forwarded-proto': 'http' });
    expect(viaHttp.error.message).toMatch(/over https/);
    expect((await h.api.expect<NetworkHttpsDto>(200, 'GET', '/v1/network/https')).httpsOnly).toBe(false);
    // Caddy's :443 route (X-Forwarded-Proto https from loopback) may
    const viaHttps = await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: true, httpsOnly: true }, { 'x-forwarded-for': '192.168.1.50', 'x-forwarded-proto': 'https' });
    expect(viaHttps.httpsOnly).toBe(true);
    // the app installed before still listens on every interface until it restarts
    expect(viaHttps.rebindToApply).toEqual([app.name]);
    // turning off is always allowed, even over plain http; then on again from this machine (no proxy headers)
    expect((await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: true, httpsOnly: false }, { 'x-forwarded-for': '192.168.1.50', 'x-forwarded-proto': 'http' })).httpsOnly).toBe(false);
    expect((await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: true, httpsOnly: true })).httpsOnly).toBe(true);
    // PUT without httpsOnly keeps it
    expect((await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: true })).httpsOnly).toBe(true);
  }, 60_000);

  it('the plain-http LAN console redirects to https except the CA download and the probe', async () => {
    if (!ok) return;
    const home = await plain(lanPort, 'GET', '/apps?x=1');
    expect(home.status).toBe(307);
    expect(home.headers.location).toBe('https://harbor.local/apps?x=1');
    expect(home.headers['cache-control']).toBe('no-store');
    expect((await plain(lanPort, 'POST', '/v1/sessions')).status).toBe(307);
    const ca = await plain(lanPort, 'GET', '/v1/network/https/ca.crt');
    expect(ca.status).toBe(200);
    expect(ca.headers['content-type']).toContain('pem');
    const probe = await plain(lanPort, 'GET', '/v1/network/https/probe?t=2');
    expect(probe.status).toBe(200);
    expect(probe.headers['content-type']).toBe('image/png');
  });

  it("Caddy's :80 route redirects the same way and keeps its LAN-peer matcher", async () => {
    if (!ok) return;
    await new Promise((r) => setTimeout(r, 1_500)); // observer ticks re-apply Caddy
    const lan = (h.caddy.config as { apps: { http: { servers: Record<string, { routes: { '@id': string; match: { remote_ip?: unknown; path?: string[] }[]; handle: { handler: string; status_code?: number }[] }[] }> } } }).apps.http.servers['harbor_lan']!;
    const keep = lan.routes.find((r) => r['@id'] === 'lan-console-http-keep')!;
    expect(keep.match[0]!.path).toEqual(['/v1/network/https/ca.crt', '/v1/network/https/probe']);
    expect(keep.match[0]!.remote_ip).toBeDefined();
    const redirect = lan.routes.find((r) => r['@id'] === 'lan-console')!;
    expect(redirect.handle[0]).toMatchObject({ handler: 'static_response', status_code: 307 });
    expect(redirect.match[0]!.remote_ip).toBeDefined();
  }, 10_000);

  it('a restart re-binds the app to loopback with the relay marker; the relay keeps serving it and the plain LAN address goes away', async () => {
    if (!ok) return;
    expect(ports(h.stateDir, app.id).hostIps).toEqual(['0.0.0.0']);
    const r = await h.api.run({ kind: 'restart', instanceId: app.id });
    expect(r.op.state).toBe('succeeded');
    expect(ports(h.stateDir, app.id)).toEqual({ hostIps: ['127.0.0.1'], marker: { lanAccess: 'relay' } });
    const st = await h.api.expect<NetworkHttpsDto>(200, 'GET', '/v1/network/https');
    expect(st.rebindToApply).toEqual([]);
    await new Promise((res) => setTimeout(res, 1_200));
    expect(h.daemon.ctx.lanHttps!.ports()).toContain(lanHttpsPort(app.endpoints[0]!.hostPort));
    const inst = (await h.api.instances()).find((i) => i.id === app.id)!;
    expect(inst.endpoints[0]!.urls.lan).toBeUndefined();
    expect(inst.endpoints[0]!.urls.lanSecure).toMatch(/^https:\/\//);
  }, 60_000);

  it('turning it off is allowed and names the apps a restart moves back; secure addresses off ends it too', async () => {
    if (!ok) return;
    const off = await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: true, httpsOnly: false });
    expect(off.httpsOnly).toBe(false);
    expect(off.rebindToApply).toEqual([app.name]);
    // the relay still carries the loopback-bound app until it restarts
    await new Promise((res) => setTimeout(res, 1_200));
    expect(h.daemon.ctx.lanHttps!.ports()).toContain(lanHttpsPort(app.endpoints[0]!.hostPort));
    expect((await plain(lanPort, 'GET', '/')).status).not.toBe(307);
    await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: true, httpsOnly: true });
    const allOff = await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: false });
    expect(allOff.httpsOnly).toBe(false);
  }, 30_000);
});

// Review fixes (decision 167): the relay policy reconcile builds from installed apps (manifest `cookies:` per
// endpoint, plain and secure ports per instance), and a Compose re-render with no restart (another app's link)
// keeps the binding the running containers have, so rebindToApply still names them.
describe('HTTPS only with linked apps, and the relay policy from state', () => {
  const ok = hasOpenssl();
  let h: Harness;
  const head = (id: string, extra = '') => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: ${id}
  description: ${id} for the HTTPS-only tests
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary
${extra}health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
`;
  const provider = head('docsapp', '    cookies: shared\n');
  const consumer =
    head('gatewayish') +
    `links:
  - id: docs
    purpose: The documents app it reads
    provider: {packages: [docsapp]}
    bindings:
      - {service: web, environment: DOCS_BASE_URL}
`;
  const upload = (m: string) => h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: 'p.zip', dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': m, 'compose.yaml': 'services:\n  web:\n    image: nginx:1.27-alpine\n' }).toString('base64')}` });
  const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name)!;
  const post = (port: number, origin: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = httpsRequest({ host: '127.0.0.1', port, method: 'POST', path: '/save', rejectUnauthorized: false, agent: false, headers: { host: `harbor.local:${port}`, origin, 'content-length': 0 } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });

  beforeAll(async () => {
    h = await startHarness({ portRange: { from: 18340, to: 18370 }, config: { lan: { enabled: true, port: await freePort() } } });
  });
  afterAll(async () => h.close());

  it("a link re-render keeps the provider's running binding; rebindToApply still names it", async () => {
    if (!ok) return;
    await upload(provider);
    await upload(consumer);
    expect((await h.api.run({ kind: 'install', packageId: 'docsapp' })).op.state).toBe('succeeded');
    const docs = await byName('docsapp');
    expect(ports(h.stateDir, docs.id)).toEqual({ hostIps: ['0.0.0.0'], marker: undefined });
    await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: true, httpsOnly: true });
    const { op } = await h.api.run({ kind: 'install', packageId: 'gatewayish' });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const gw = await byName('gatewayish');
    expect(ports(h.stateDir, gw.id)).toEqual({ hostIps: ['127.0.0.1'], marker: { lanAccess: 'relay' } });
    // docsapp's file was re-rendered for the link, but its containers still publish on every interface
    expect(readFileSync(path.join(h.stateDir, 'instances', docs.id, 'runtime', 'compose.yaml'), 'utf8')).toContain('external: true');
    expect(ports(h.stateDir, docs.id)).toEqual({ hostIps: ['0.0.0.0'], marker: undefined });
    expect((await h.api.expect<NetworkHttpsDto>(200, 'GET', '/v1/network/https')).rebindToApply).toEqual(['docsapp']);
  }, 60_000);

  it("reconcile gives the relay each endpoint's manifest mode and every Harbor port's instance, and refuses a cross-app POST", async () => {
    if (!ok) return;
    const docs = await byName('docsapp');
    const gw = await byName('gatewayish');
    const docsPlain = docs.endpoints[0]!.hostPort;
    const gwPlain = gw.endpoints[0]!.hostPort;
    const [docsSecure, gwSecure] = [lanHttpsPort(docsPlain), lanHttpsPort(gwPlain)];
    await new Promise((r) => setTimeout(r, 1_200)); // an observer tick reconciles the relays
    const relay = h.daemon.ctx.lanHttps!;
    expect(relay.ports()).toEqual(expect.arrayContaining([docsSecure, gwSecure]));
    const d = relay.policy(docsSecure)!;
    const g = relay.policy(gwSecure)!;
    expect(d.ep).toMatchObject({ tag: cookieTag(docs.id), cookies: 'shared' });
    expect(g.ep).toMatchObject({ tag: cookieTag(gw.id), cookies: 'isolated' });
    expect(Object.fromEntries([docsPlain, docsSecure, gwPlain, gwSecure].map((p) => [p, g.portTags.get(p)]))).toEqual({ [docsPlain]: cookieTag(docs.id), [docsSecure]: cookieTag(docs.id), [gwPlain]: cookieTag(gw.id), [gwSecure]: cookieTag(gw.id) });
    // through the real listeners: docsapp's page (secure or plain address) posting to gatewayish is refused
    expect(await post(gwSecure, `https://harbor.local:${docsSecure}`)).toBe(403);
    expect(await post(gwSecure, `http://harbor.local:${docsPlain}`)).toBe(403);
    expect(await post(gwSecure, `https://harbor.local:${gwSecure}`)).not.toBe(403);
  }, 30_000);
});

