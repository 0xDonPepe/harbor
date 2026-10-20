// Decision 184: VPN and offline apps. The pure halves: the WireGuard file Harbor accepts, the nftables ruleset and
// `ip` rules the root step loads, the state it validates, and the mode an app runs with.
import { describe, expect, it } from 'vitest';
import { coversIpv4Internet, DEFAULT_KEEPALIVE, DNS_FALLBACK, isWireguardKey, parseEndpoint, parseWgDump, parseWireguardConfig, tunnelDns, tunnelSummary, wgSetconfText } from '../../src/egress/wireguard.js';
import { OFFLINE_DNS_ADDRESS, renderedDns, VPN_DNS_ADDRESS, catchAllRouteArgs, effectiveInternet, harborRulePriorities, ipRuleArgs, ipRuleDeleteArgs, isAppSubnet, MARK_MASK, MARK_OFFLINE, MARK_VPN, nftDeleteScript, nftRuleset, ROUTE_TABLE, TUNNEL_IF, tunnelRouteArgs, validateEgressState, within } from '../../src/egress/rules.js';
import { HarborError } from '../../src/errors.js';
import { validateManifestShape } from '../../src/packages/manifest.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { MINIMAL_COMPOSE, MINIMAL_MANIFEST } from './helpers.js';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { identityFor } from '../../src/planner/identity.js';
import { renderCompose } from '../../src/planner/render.js';
import { parse as parseYaml } from 'yaml';
import { plannedConfigureInternet, plannedInstallInternet, plannedUpdateInternet } from '../../src/planner/internet.js';

import { fixtureKey, PROVIDER_CONF } from '../fixtures/wireguard.js';

const PRIV = fixtureKey('wgPRIVATE');
const PUB = fixtureKey('wgSERVER');
const PSK = fixtureKey('wgPSK');

const AID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function refusal(fn: () => unknown): HarborError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HarborError);
    return e as HarborError;
  }
  throw new Error('expected a refusal');
}

describe('WireGuard configuration', () => {
  it('reads a provider export', () => {
    const c = parseWireguardConfig(PROVIDER_CONF);
    expect(c.privateKey).toBe(PRIV);
    expect(c.addresses).toEqual(['10.66.12.34/32', 'fc00:bbbb:bbbb:bb01::3:c21/128']);
    expect(c.dns).toEqual(['10.64.0.1']);
    expect(c.mtu).toBeNull();
    expect(c.peer).toEqual({ publicKey: PUB, presharedKey: null, endpoint: '185.65.134.82:51820', allowedIps: ['0.0.0.0/0', '::/0'], persistentKeepalive: DEFAULT_KEEPALIVE });
    expect(isWireguardKey(PRIV)).toBe(true);
  });

  it('accepts lower-case keys, CRLF, a BOM, a name endpoint, a preshared key, MTU and search domains in DNS', () => {
    const text = `${String.fromCharCode(0xfeff)}[interface]\r\nprivatekey = ${PRIV}\r\naddress = 10.2.0.2/32\r\ndns = 10.2.0.1, vpn.example\r\nmtu = 1380\r\n\r\n[peer]\r\npublickey = ${PUB}\r\npresharedkey = ${PSK}\r\nallowedips = 0.0.0.0/1, 128.0.0.0/1\r\nendpoint = nl.vpn.example:51820\r\npersistentkeepalive = 15\r\n`;
    const c = parseWireguardConfig(text);
    expect(c.dns).toEqual(['10.2.0.1']);
    expect(c.mtu).toBe(1380);
    expect(c.peer.presharedKey).toBe(PSK);
    expect(c.peer.endpoint).toBe('nl.vpn.example:51820');
    expect(c.peer.persistentKeepalive).toBe(15);
  });

  it('refuses keys that run commands or change routing, naming them', () => {
    for (const k of ['PostUp', 'PreUp', 'PostDown', 'PreDown', 'Table', 'FwMark', 'SaveConfig']) {
      const e = refusal(() => parseWireguardConfig(PROVIDER_CONF.replace('DNS = 10.64.0.1', `DNS = 10.64.0.1\n${k} = iptables -A FORWARD -j ACCEPT`)));
      expect(e.message).toContain(k);
      expect(e.nextAction).toContain(`Delete the ${k} line`);
    }
  });

  it('refuses unknown keys, a second peer, a split tunnel, bad keys and an IPv6-only address', () => {
    expect(refusal(() => parseWireguardConfig(PROVIDER_CONF.replace('DNS =', 'Foo = 1\nDNS ='))).message).toContain('Foo');
    expect(refusal(() => parseWireguardConfig(PROVIDER_CONF + `\n[Peer]\nPublicKey = ${PUB}\nAllowedIPs = 0.0.0.0/0\nEndpoint = 1.2.3.4:1\n`)).message).toContain('more than one [Peer]');
    expect(refusal(() => parseWireguardConfig(PROVIDER_CONF.replace('0.0.0.0/0, ::/0', '10.0.0.0/8'))).message).toContain('whole internet');
    expect(refusal(() => parseWireguardConfig(PROVIDER_CONF.replace(PRIV, 'not-a-key'))).message).toContain('PrivateKey');
    expect(refusal(() => parseWireguardConfig(PROVIDER_CONF.replace('10.66.12.34/32, ', ''))).message).toContain('IPv4');
    expect(refusal(() => parseWireguardConfig(PROVIDER_CONF.replace('185.65.134.82:51820', '185.65.134.82'))).message).toContain('Endpoint');
    expect(refusal(() => parseWireguardConfig('')).message).toContain('empty');
    expect(refusal(() => parseWireguardConfig(`[Peer]\nPublicKey = ${PUB}`)).message).toContain('[Peer] before [Interface]');
    expect(refusal(() => parseWireguardConfig(PROVIDER_CONF.replace('[Peer]', '').replace(`PublicKey = ${PUB}`, ''))).message).toMatch(/AllowedIPs|no \[Peer\]/);
    expect(refusal(() => parseWireguardConfig(PROVIDER_CONF.replace('DNS = 10.64.0.1', 'MTU = 9000'))).message).toContain('MTU');
  });

  it('keeps keepalives on (0 and off fall back to the default)', () => {
    expect(parseWireguardConfig(PROVIDER_CONF.replace('Endpoint', 'PersistentKeepalive = 0\nEndpoint')).peer.persistentKeepalive).toBe(DEFAULT_KEEPALIVE);
    expect(parseWireguardConfig(PROVIDER_CONF.replace('Endpoint', 'PersistentKeepalive = off\nEndpoint')).peer.persistentKeepalive).toBe(DEFAULT_KEEPALIVE);
  });

  it('writes only what wg setconf takes, and a summary without any private material', () => {
    const c = parseWireguardConfig(PROVIDER_CONF.replace('Endpoint', `PresharedKey = ${PSK}\nEndpoint`));
    const wg = wgSetconfText(c);
    expect(wg).toContain(`PrivateKey = ${PRIV}`);
    expect(wg).toContain(`PresharedKey = ${PSK}`);
    expect(wg).not.toMatch(/Address|DNS|MTU/);
    const s = tunnelSummary(c);
    expect(JSON.stringify(s)).not.toContain(PRIV);
    expect(JSON.stringify(s)).not.toContain(PSK);
    expect(s).toEqual({ endpoint: '185.65.134.82:51820', addresses: ['10.66.12.34/32', 'fc00:bbbb:bbbb:bb01::3:c21/128'], dns: ['10.64.0.1'], dnsFallback: false, mtu: 1420, peerPublicKey: PUB });
  });

  it('falls back to Quad9 through the tunnel when the file names no resolver', () => {
    const c = parseWireguardConfig(PROVIDER_CONF.replace('DNS = 10.64.0.1\n', ''));
    expect(tunnelDns(c)).toBe(DNS_FALLBACK);
    expect(tunnelSummary(c)).toMatchObject({ dns: [DNS_FALLBACK], dnsFallback: true });
  });

  it('parses endpoints and AllowedIPs coverage', () => {
    expect(parseEndpoint('[2a03:1b20::1]:51820')).toEqual({ host: '2a03:1b20::1', port: 51820 });
    expect(parseEndpoint('host:0')).toBeNull();
    expect(parseEndpoint('bad host:1')).toBeNull();
    expect(coversIpv4Internet(['0.0.0.0/1', '128.0.0.0/1'])).toBe(true);
    expect(coversIpv4Internet(['0.0.0.0/1'])).toBe(false);
  });

  it('reads wg show dump', () => {
    const dump = `${PRIV}\t${fixtureKey('wgIFACE')}\t41234\toff\n${PUB}\t(none)\t185.65.134.82:51820\t0.0.0.0/0\t1792000000\t12345\t678\t25\n`;
    expect(parseWgDump(dump)).toEqual({ interfacePublicKey: fixtureKey('wgIFACE'), endpoint: '185.65.134.82:51820', latestHandshake: 1792000000, rxBytes: 12345, txBytes: 678 });
    expect(parseWgDump(`${PRIV}\t${fixtureKey('wgIFACE')}\t41234\toff\n${PUB}\t(none)\t(none)\t0.0.0.0/0\t0\t0\t0\t25\n`)).toMatchObject({ latestHandshake: null, endpoint: null });
  });
});

describe('egress rules', () => {
  const state = { format: 1 as const, apps: [{ instanceId: AID, mode: 'vpn' as const, subnets: ['172.18.0.0/16'] }, { instanceId: BID, mode: 'offline' as const, subnets: ['172.20.0.0/16'] }] };

  it('marks only what an app opens, towards outside its own network', () => {
    const r = nftRuleset(state, { dns: '10.64.0.1', tunnel: true });
    expect(r.startsWith('table inet harbor_egress {}\ndelete table inet harbor_egress\n')).toBe(true);
    expect(r).toContain(`ip saddr 172.18.0.0/16 ip daddr != 172.18.0.0/16 ct direction original meta mark set meta mark & 0xf0ffffff | 0x01000000 comment "${AID} vpn"`);
    expect(r).toContain(`ip saddr 172.20.0.0/16 ip daddr != 172.20.0.0/16 ct direction original meta mark set meta mark & 0xf0ffffff | 0x02000000 comment "${BID} offline"`);
    // the app's bridge gateway is inside its subnet but is this machine: marked too
    expect(r).toContain(`ip saddr 172.20.0.0/16 fib daddr type local ct direction original meta mark set meta mark & 0xf0ffffff | 0x02000000 comment "${BID} offline to this machine"`);
    expect(MARK_VPN & MARK_MASK).toBe(MARK_VPN);
    expect(MARK_OFFLINE & MARK_MASK).toBe(MARK_OFFLINE);
  });

  it('sends VPN apps\' DNS to the tunnel resolver and refuses everything else outside the tunnel', () => {
    const r = nftRuleset(state, { dns: '10.64.0.1', tunnel: true });
    expect(r).toContain('udp dport 53 dnat ip to 10.64.0.1');
    expect(r).toContain('tcp dport 53 dnat ip to 10.64.0.1');
    const forward = r.slice(r.indexOf('chain egress_forward'), r.indexOf('chain egress_input'));
    const order = ['"offline"', `oifname "${TUNNEL_IF}" accept`, '"dns outside the tunnel"', '"this network"', '"kill switch"'].map((s) => forward.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r).toContain(`oifname "${TUNNEL_IF}" masquerade`);
    expect(r.slice(r.indexOf('chain egress_input'))).toContain('0x02000000 reject');
  });

  it('the host\'s own lookups for VPN apps (Docker\'s resolver) are marked, rewritten into the tunnel, and never leave beside it', () => {
    const r = nftRuleset(state, { dns: '10.64.0.1', tunnel: true });
    expect(r).toContain(`chain egress_route {\n    type route hook output priority mangle; policy accept;\n    ip daddr ${VPN_DNS_ADDRESS} th dport 53 meta mark set meta mark & 0xf0ffffff | 0x01000000`);
    expect(r).toContain(`ip daddr ${VPN_DNS_ADDRESS} th dport 53 dnat ip to 10.64.0.1`);
    expect(r).toContain('chain egress_output {\n    type filter hook output priority filter - 5; policy accept;\n    meta mark & 0x0f000000 == 0x01000000 oifname != "hb-vpn0" reject');
    const none = nftRuleset(state, { dns: null, tunnel: false });
    expect(none).not.toContain(`dnat ip to`);
    // without a tunnel the host's lookup is not marked (a marked packet with no route is dropped silently and the app
    // waits out its timeouts) but refused at once on the output path
    expect(none).not.toContain(`ip daddr ${VPN_DNS_ADDRESS} th dport 53 meta mark set`);
    expect(none).toContain(`ip daddr ${VPN_DNS_ADDRESS} reject with icmpx port-unreachable`);
    expect(renderedDns('vpn')).toEqual([VPN_DNS_ADDRESS]);
    expect(renderedDns('offline')).toEqual([OFFLINE_DNS_ADDRESS]);
    expect(renderedDns('direct')).toBeNull();
    expect(OFFLINE_DNS_ADDRESS.startsWith('127.')).toBe(true);
  });

  it('without a tunnel nothing is accepted towards it, and DNS is refused on this machine at once', () => {
    const r = nftRuleset(state, { dns: null, tunnel: false });
    expect(r).not.toContain('dnat');
    expect(r).toContain('meta mark & 0x0f000000 == 0x01000000 udp dport 53 redirect');
    expect(r.slice(r.indexOf('chain egress_input'))).toContain('0x01000000 th dport 53 reject with icmpx port-unreachable');
    expect(r).not.toContain(`oifname "${TUNNEL_IF}" accept`);
    expect(r).toContain('"kill switch"');
  });

  it('refuses a DNS server that is not an IPv4 address', () => {
    expect(() => nftRuleset(state, { dns: '10.64.0.1; drop', tunnel: true })).toThrow(HarborError);
  });

  it('routes VPN-marked packets: tunnel DNS first, then this network, then the tunnel table', () => {
    expect(ipRuleArgs('10.64.0.1')).toEqual([
      ['rule', 'add', 'priority', '5160', 'to', '10.64.0.1/32', 'fwmark', '0x01000000/0x0f000000', 'lookup', String(ROUTE_TABLE)],
      ['rule', 'add', 'priority', '5170', 'fwmark', '0x01000000/0x0f000000', 'lookup', 'main', 'suppress_prefixlength', '0'],
      ['rule', 'add', 'priority', '5180', 'fwmark', '0x01000000/0x0f000000', 'lookup', String(ROUTE_TABLE)],
    ]);
    expect(ipRuleArgs(null)).toHaveLength(2);
    expect(ipRuleDeleteArgs().map((a) => a[3])).toEqual(['5160', '5170', '5180']);
    expect(catchAllRouteArgs()).toEqual(['route', 'replace', 'unreachable', 'default', 'table', '4842', 'metric', '4294967295']);
    expect(tunnelRouteArgs()).toContain(TUNNEL_IF);
    expect(harborRulePriorities('0:\tfrom all lookup local\n5170:\tfrom all fwmark 0x1000000/0xf000000 lookup main suppress_prefixlength 0\n5270:\tfrom all lookup 52\n')).toEqual([5170]);
    expect(nftDeleteScript()).toBe('table inet harbor_egress {}\ndelete table inet harbor_egress\n');
  });

  it('validates the state root is handed', () => {
    expect(validateEgressState({ format: 1, apps: [state.apps[1], state.apps[0]] }).apps.map((a) => a.instanceId)).toEqual([AID, BID]);
    const bad = (apps: unknown) => () => validateEgressState({ format: 1, apps });
    expect(bad([{ instanceId: 'x', mode: 'vpn', subnets: ['172.18.0.0/16'] }])).toThrow('bad instance id');
    expect(bad([{ instanceId: AID, mode: 'direct', subnets: ['172.18.0.0/16'] }])).toThrow('bad mode');
    expect(bad([{ instanceId: AID, mode: 'vpn', subnets: ['172.18.0.0/16"; flush ruleset'] }])).toThrow('bad subnets');
    expect(bad([{ instanceId: AID, mode: 'vpn', subnets: ['8.8.8.0/24'] }])).toThrow('bad subnets');
    expect(bad([{ instanceId: AID, mode: 'vpn', subnets: ['172.18.0.1/16'] }])).toThrow('bad subnets');
    expect(bad([{ instanceId: AID, mode: 'vpn', subnets: [] }])).toThrow('bad subnets');
    expect(bad([{ instanceId: AID, mode: 'vpn', subnets: ['172.18.0.0/16'] }, { instanceId: BID, mode: 'offline', subnets: ['172.18.4.0/24'] }])).toThrow('claimed twice');
    expect(() => validateEgressState({ format: 2, apps: [] })).toThrow('format');
  });

  it('knows app subnets and containment', () => {
    expect(isAppSubnet('172.18.0.0/16')).toBe(true);
    expect(isAppSubnet('192.168.16.0/20')).toBe(true);
    expect(isAppSubnet('10.0.0.0/8')).toBe(true);
    expect(isAppSubnet('172.18.0.0')).toBe(false);
    expect(isAppSubnet('100.64.0.0/10')).toBe(false);
    expect(isAppSubnet('fd00::/64')).toBe(false);
    expect(within('172.18.4.0/24', '172.18.0.0/16')).toBe(true);
    expect(within('172.19.0.0/16', '172.18.0.0/16')).toBe(false);
  });
});

describe('effective internet mode', () => {
  it('follows the choice, then the package, then direct; every-app VPN only moves direct', () => {
    expect(effectiveInternet(null, null, false)).toBe('direct');
    expect(effectiveInternet(null, 'offline', false)).toBe('offline');
    expect(effectiveInternet('direct', 'offline', false)).toBe('direct');
    expect(effectiveInternet(null, null, true)).toBe('vpn');
    expect(effectiveInternet('direct', 'vpn', true)).toBe('vpn');
    expect(effectiveInternet('offline', null, true)).toBe('offline');
  });
});

describe('internet access in plans', () => {
  const ctx = { allApps: false, vpnReady: true, running: true };
  it('install: the package default is not a choice; the review can pick another', () => {
    expect(plannedInstallInternet({}, 'app', undefined, ctx)).toEqual({ internet: { from: null, to: 'direct', choice: null, packageDefault: 'direct', vpnReady: true }, changes: [], warnings: [] });
    expect(plannedInstallInternet({ network: { internet: 'offline' } }, 'app', 'offline', ctx).internet.choice).toBeNull();
    const vpn = plannedInstallInternet({}, 'app', 'vpn', { allApps: false, vpnReady: false });
    expect(vpn.internet).toMatchObject({ to: 'vpn', choice: 'vpn' });
    expect(vpn.changes).toEqual(['Internet access: Through the VPN (your choice); nothing it opens leaves this machine outside the tunnel']);
    expect(vpn.warnings).toEqual(['No VPN is set up: app has no internet until you add one in Settings → VPN.']);
    expect(plannedInstallInternet({}, 'app', undefined, { allApps: true, vpnReady: true }).changes[0]).toContain('(every app goes through the VPN)');
  });
  it('configure: from → to, nothing when unchanged, default follows the package again', () => {
    expect(plannedConfigureInternet('direct', null, 'default', 'app', ctx)).toBeNull();
    expect(plannedConfigureInternet('direct', 'vpn', 'vpn', 'app', ctx)).toBeNull();
    expect(plannedConfigureInternet('offline', 'direct', 'default', 'app', ctx)?.internet).toEqual({ from: 'direct', to: 'offline', choice: null, packageDefault: 'offline', vpnReady: true });
    // choosing direct explicitly while it is already direct by default: stays, but now a choice of its own
    expect(plannedConfigureInternet('direct', null, 'direct', 'app', ctx)?.changes).toEqual(['Internet access stays Direct']);
    expect(plannedConfigureInternet('direct', null, 'offline', 'app', ctx)?.changes).toEqual(['Internet access: Direct → Offline (your choice). app restarts so its lookups follow too (same data, ports and addresses)']);
    expect(plannedConfigureInternet('direct', null, 'offline', 'app', { ...ctx, running: false })?.changes).toEqual(['Internet access: Direct → Offline (your choice). It applies when app next starts']);
    expect(plannedConfigureInternet('direct', null, 'direct', 'app', { allApps: true, vpnReady: true, running: true })?.changes).toEqual(['Internet access stays Through the VPN (every app goes through the VPN)']);
  });
  it('update: only an app that follows the package moves, and only when the mode really changes', () => {
    expect(plannedUpdateInternet({}, { network: { internet: 'offline' } }, null, 'app', ctx)?.internet).toMatchObject({ from: 'direct', to: 'offline' });
    expect(plannedUpdateInternet({}, { network: { internet: 'offline' } }, 'direct', 'app', ctx)).toBeNull();
    expect(plannedUpdateInternet({}, { network: { internet: 'vpn' } }, null, 'app', { allApps: true, vpnReady: true })).toBeNull();
    expect(plannedUpdateInternet({ network: { internet: 'vpn' } }, { network: { internet: 'vpn' } }, null, 'app', ctx)).toBeNull();
  });
});

describe('package format: network.internet (decision 185)', () => {
  const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'manifest.yaml');
  it('is optional, takes direct, vpn or offline, and nothing else', () => {
    expect(validateManifestShape(y(MINIMAL_MANIFEST)).network).toBeUndefined();
    for (const m of ['direct', 'vpn', 'offline']) expect(validateManifestShape(y(`${MINIMAL_MANIFEST}network:\n  internet: ${m}\n`)).network).toEqual({ internet: m });
    expect(() => validateManifestShape(y(`${MINIMAL_MANIFEST}network:\n  internet: tor\n`))).toThrow();
    expect(() => validateManifestShape(y(`${MINIMAL_MANIFEST}network:\n  allow: [example.com]\n`))).toThrow();
  });
});

describe('rendering internet access (pure)', () => {
  const identity = identityFor('0a0a0a0a-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111');
  const endpoints = [{ id: 'web', service: 'web', containerPort: 80, hostPort: 18080 }];
  const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'x');
  const render = (internet?: 'direct' | 'vpn' | 'offline') => parseYaml(renderCompose({ manifest: validateManifestShape(y(MINIMAL_MANIFEST)), compose: validateComposeSource(y(MINIMAL_COMPOSE)), identity, endpoints, secretValues: null, ...(internet ? { internet } : {}) }).yaml) as { services: Record<string, { dns?: string[] }> };
  it('gives VPN and offline apps Harbor\'s resolver and leaves direct apps exactly as before', () => {
    expect(render().services['web']!.dns).toBeUndefined();
    expect(render('direct').services['web']!.dns).toBeUndefined();
    expect(render('vpn').services['web']!.dns).toEqual([VPN_DNS_ADDRESS]);
    expect(render('offline').services['web']!.dns).toEqual([OFFLINE_DNS_ADDRESS]);
  });
});
