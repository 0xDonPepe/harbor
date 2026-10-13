// LAN HTTPS pure surface (decision 109): deterministic secure ports, host
// coverage, SAN rendering. Cert minting itself needs openssl + a state dir
// and is proved by the integration test; these stay fast and hermetic.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { forwardHeaders, lanBoundPorts, lanHttpsConsoleUrl, lanHttpsHosts, lanHttpsPort, lanHttpsUrl, sanExt } from '../../src/system/lan-https.js';
import { endpointUrls } from '../../src/exposure/urls.js';

describe('LAN HTTPS ports', () => {
  it('adds the fixed offset and refuses overflow', () => {
    expect(lanHttpsPort(18080)).toBe(38080);
    expect(() => lanHttpsPort(60000)).toThrow(/no secure port/);
  });
  it('renders console + app secure addresses', () => {
    expect(lanHttpsConsoleUrl('harbor.local')).toBe('https://harbor.local/');
    expect(lanHttpsUrl('harbor.local', 18080)).toBe('https://harbor.local:38080/');
  });
});

describe('LAN HTTPS hosts', () => {
  it('always covers harbor.local + hostname.local + bare hostname, plus LAN IPv4', () => {
    const hosts = lanHttpsHosts('MyBox', ['192.168.1.7', '10.0.0.2', '::1', 'fe80::1']);
    expect(hosts).toContain('harbor.local');
    expect(hosts).toContain('mybox.local');
    expect(hosts).toContain('mybox');
    expect(hosts).toContain('192.168.1.7');
    expect(hosts).toContain('10.0.0.2');
    expect(hosts).not.toContain('::1');
    expect(lanHttpsHosts('harbor.local', [])).toContain('harbor.local');
  });
  it('renders a server-auth SAN extension with IP entries as IP:', () => {
    const ext = sanExt(['harbor.local', '192.168.1.7']);
    expect(ext).toContain('DNS:harbor.local');
    expect(ext).toContain('IP:192.168.1.7');
    expect(ext).toContain('CA:FALSE');
    expect(ext).toContain('serverAuth');
  });
});

describe('endpoint lanSecure urls', () => {
  const alloc = { id: 'web', service: 'web', containerPort: 80, hostPort: 18080 };
  it('adds lanSecure alongside lan when the secure host is known', () => {
    const urls = endpointUrls(alloc, [], 'mybox.local', { host: 'mybox.local' });
    expect(urls.lan).toBe('http://mybox.local:18080/');
    expect(urls.lanSecure).toBe('https://mybox.local:38080/');
  });
  it('omits lanSecure when HTTPS is off', () => {
    const urls = endpointUrls(alloc, [], 'mybox.local', null);
    expect(urls.lan).toBe('http://mybox.local:18080/');
    expect(urls.lanSecure).toBeUndefined();
  });
});

describe('LAN HTTPS relay scope (decision 165)', () => {
  it('only LAN-bound TCP endpoints get a secure twin', () => {
    const state = mkdtempSync(path.join(tmpdir(), 'harbor-bound-'));
    const id = '22222222-2222-4222-8222-222222222222';
    mkdirSync(path.join(state, 'instances', id, 'runtime'), { recursive: true });
    writeFileSync(path.join(state, 'instances', id, 'runtime', 'compose.yaml'), [
      'services:',
      '  web:',
      '    ports:',
      '      - { target: 80, published: "18080", host_ip: 0.0.0.0, protocol: tcp, mode: host }',
      '      - { target: 81, published: "18081", host_ip: 127.0.0.1, protocol: tcp, mode: host }',
      '      - { target: 51820, published: "51820", host_ip: 0.0.0.0, protocol: udp, mode: host }',
    ].join('\n'));
    expect([...lanBoundPorts(state, id)]).toEqual([18080]);
    expect(lanBoundPorts(state, '33333333-3333-4333-8333-333333333333').size).toBe(0);
  });
});

describe('LAN HTTPS relay headers (decision 165)', () => {
  it('drops client-sent forwarding headers and states the real peer', () => {
    const h = forwardHeaders({ headers: { host: 'harbor.local:38080', 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4', forwarded: 'for=1.2.3.4', cookie: 'a=b' }, socket: { remoteAddress: '::ffff:192.168.1.7' } } as never, 18080);
    expect(h).toEqual({ host: '127.0.0.1:18080', cookie: 'a=b', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'harbor.local:38080', 'x-forwarded-for': '192.168.1.7' });
  });
});
