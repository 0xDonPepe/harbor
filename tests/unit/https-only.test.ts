// HTTPS only (decision 167): the pure parts — the redirect target, Caddy's :80 routes, the lock-out guard's view
// of a request, the relay marker in the rendered Compose file and what the relay then serves, and the package
// format's new optional `endpoints.<id>.cookies`.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { arrivedOverHttps } from '../../src/api/server.js';
import { renderCaddyConfig } from '../../src/exposure/caddy.js';
import { endpointCookieModes, httpsRedirectLocation, lanBoundPorts, runtimeLanAccess } from '../../src/system/lan-https.js';
import { LAN_PEER_RANGES } from '../../src/system/lan.js';
import { validateManifestShape } from '../../src/packages/manifest.js';
import { MINIMAL_MANIFEST } from './helpers.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';

describe('plain-http redirect', () => {
  it('sends every request to the same host and path over https', () => {
    expect(httpsRedirectLocation({ method: 'GET', url: '/apps?x=1', headers: { host: 'harbor.local' } }, 443)).toBe('https://harbor.local/apps?x=1');
    expect(httpsRedirectLocation({ method: 'POST', url: '/v1/sessions', headers: { host: '192.168.1.20:80' } }, 443)).toBe('https://192.168.1.20/v1/sessions');
    expect(httpsRedirectLocation({ method: 'GET', url: '/', headers: { host: '[fe80::1]:80' } }, 18443)).toBe('https://[fe80::1]:18443/');
  });
  it('keeps the CA download and the probe on http (GET only), and leaves a bad Host to the guards', () => {
    expect(httpsRedirectLocation({ method: 'GET', url: '/v1/network/https/ca.crt', headers: { host: 'harbor.local' } })).toBeNull();
    expect(httpsRedirectLocation({ method: 'GET', url: '/v1/network/https/probe?t=1', headers: { host: 'harbor.local' } })).toBeNull();
    expect(httpsRedirectLocation({ method: 'POST', url: '/v1/network/https/ca.crt', headers: { host: 'harbor.local' } }, 443)).toBe('https://harbor.local/v1/network/https/ca.crt');
    expect(httpsRedirectLocation({ method: 'GET', url: '/', headers: { host: 'evil.example/x' } })).toBeNull();
    expect(httpsRedirectLocation({ method: 'GET', url: '/', headers: {} })).toBeNull();
  });
});

describe("Caddy's :80 route with HTTPS only", () => {
  type Route = { '@id': string; match: { host: string[]; remote_ip: { ranges: string[] }; method?: string[]; path?: string[] }[]; handle: Record<string, unknown>[] };
  const lanRoutes = (httpsOnly: boolean) => (renderCaddyConfig([], { lan: { hosts: ['harbor.local', '192.168.1.20'], consolePort: 18000, httpsOnly } }) as { apps: { http: { servers: Record<string, { routes: Route[] }> } } }).apps.http.servers['harbor_lan']!.routes;
  it('proxies only the CA download and the probe, and redirects the rest (307, same host + uri), LAN peers only', () => {
    const [keep, redirect] = lanRoutes(true);
    expect(keep!.match[0]).toMatchObject({ method: ['GET'], path: ['/v1/network/https/ca.crt', '/v1/network/https/probe'], remote_ip: { ranges: LAN_PEER_RANGES } });
    expect(keep!.handle[0]).toMatchObject({ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:18000' }] });
    expect(redirect!.match[0]!.remote_ip.ranges).toEqual(LAN_PEER_RANGES);
    expect(redirect!.match[0]!.host).toEqual(['192.168.1.20', 'harbor.local']);
    expect(redirect!.handle[0]).toEqual({ handler: 'static_response', status_code: 307, headers: { Location: ['https://{http.request.host}{http.request.uri}'], 'Cache-Control': ['no-store'] } });
  });
  it('is the plain proxy route when off', () => {
    const routes = lanRoutes(false);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.handle[0]).toMatchObject({ handler: 'reverse_proxy' });
  });
});

describe('lock-out guard: did this request arrive over https?', () => {
  const req = (remoteAddress: string, headers: Record<string, string> = {}, encrypted = false) => ({ socket: { remoteAddress, encrypted }, headers });
  it('yes: TLS socket, loopback proxy saying https, a local program with no proxy', () => {
    expect(arrivedOverHttps(req('192.168.1.50', {}, true))).toBe(true);
    expect(arrivedOverHttps(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.50', 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(arrivedOverHttps(req('::1'))).toBe(true);
  });
  it('no: plain http from the LAN, through a proxy on :80, or a LAN peer claiming https', () => {
    expect(arrivedOverHttps(req('::ffff:192.168.1.50'))).toBe(false);
    expect(arrivedOverHttps(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.50', 'x-forwarded-proto': 'http' }))).toBe(false);
    expect(arrivedOverHttps(req('192.168.1.50', { 'x-forwarded-proto': 'https' }))).toBe(false);
  });
});

describe('relay marker in the runtime file', () => {
  const write = (lines: string[]) => {
    const state = mkdtempSync(path.join(tmpdir(), 'harbor-relay-'));
    const id = '44444444-4444-4444-8444-444444444444';
    mkdirSync(path.join(state, 'instances', id, 'runtime'), { recursive: true });
    writeFileSync(path.join(state, 'instances', id, 'runtime', 'compose.yaml'), lines.join('\n'));
    return { state, id };
  };
  it('a loopback-bound app with x-harbor.lanAccess: relay is served by the relay', () => {
    const { state, id } = write(['x-harbor: { lanAccess: relay }', 'services:', '  web:', '    ports:', '      - { target: 80, published: "18080", host_ip: 127.0.0.1, protocol: tcp, mode: host }']);
    expect([...lanBoundPorts(state, id)]).toEqual([18080]);
    expect(runtimeLanAccess(state, id)).toBe('relay');
  });
  it('without the marker a loopback-bound app stays closed (decision 165), and a 0.0.0.0 app is "lan"', () => {
    const closed = write(['services:', '  web:', '    ports:', '      - { target: 80, published: "18080", host_ip: 127.0.0.1, protocol: tcp, mode: host }']);
    expect(lanBoundPorts(closed.state, closed.id).size).toBe(0);
    expect(runtimeLanAccess(closed.state, closed.id)).toBe('loopback');
    const lan = write(['services:', '  web:', '    ports:', '      - { target: 80, published: "18080", host_ip: 0.0.0.0, protocol: tcp, mode: host }']);
    expect(runtimeLanAccess(lan.state, lan.id)).toBe('lan');
    expect(runtimeLanAccess(lan.state, '55555555-5555-4555-8555-555555555555')).toBeNull();
  });
});

describe('endpoints.<id>.cookies (package format, decision 167)', () => {
  it('is optional, accepts isolated | shared, refuses anything else', () => {
    const withCookies = (v: string) => MINIMAL_MANIFEST.replace(/browserContext: (\w+)/, `browserContext: $1\n    cookies: ${v}`);
    const parse = (text: string) => validateManifestShape(parseRestrictedYaml(Buffer.from(text), 'manifest.yaml'));
    expect(withCookies('shared')).toContain('cookies: shared');
    expect(parse(MINIMAL_MANIFEST).endpoints['web']!.cookies).toBeUndefined();
    expect(parse(withCookies('shared')).endpoints['web']!.cookies).toBe('shared');
    expect(parse(withCookies('isolated')).endpoints['web']!.cookies).toBe('isolated');
    expect(() => parse(withCookies('open'))).toThrow();
  });
  it('the relay reads it from the release snapshot (default isolated)', () => {
    const state = mkdtempSync(path.join(tmpdir(), 'harbor-cookiemode-'));
    const id = '66666666-6666-4666-8666-666666666666';
    mkdirSync(path.join(state, 'instances', id, 'release'), { recursive: true });
    writeFileSync(path.join(state, 'instances', id, 'release', 'manifest.yaml'), 'endpoints:\n  web: {service: web, cookies: shared}\n  api: {service: web}\n');
    expect(endpointCookieModes(state, id)).toEqual({ web: 'shared', api: 'isolated' });
    expect(endpointCookieModes(state, '77777777-7777-4777-8777-777777777777')).toEqual({});
  });
});
