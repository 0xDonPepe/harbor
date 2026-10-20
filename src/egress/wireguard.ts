// WireGuard configuration files (decision 184): the wg-quick format VPN providers export, reduced to what a
// kernel interface needs. PURE: no I/O.
//
// wg-quick runs PreUp/PostUp/PreDown/PostDown as root shell commands and acts on Table/FwMark/SaveConfig; Harbor
// never runs wg-quick, and refuses those keys (and any other it does not know) rather than ignoring them, so what
// the operator pasted is exactly what Harbor uses.
import { isIP } from 'node:net';
import { HarborError } from '../errors.js';

export interface WireguardConfig {
  privateKey: string;
  listenPort: number | null;
  // tunnel addresses, as written (CIDR or a bare address)
  addresses: string[];
  dns: string[];
  mtu: number | null;
  peer: {
    publicKey: string;
    presharedKey: string | null;
    endpoint: string;
    allowedIps: string[];
    persistentKeepalive: number;
  };
}

// What the console and the CLI may show: no private key, no preshared key.
export interface TunnelSummary {
  endpoint: string;
  addresses: string[];
  dns: string[];
  // true when the file named no DNS server and Harbor uses DNS_FALLBACK through the tunnel
  dnsFallback: boolean;
  mtu: number;
  peerPublicKey: string;
}

export const DEFAULT_MTU = 1420;
export const DEFAULT_KEEPALIVE = 25;
// Quad9, reached through the tunnel, when the provider's file names no resolver
export const DNS_FALLBACK = '9.9.9.9';
export const MAX_CONFIG_BYTES = 16 * 1024;

const KEY_PATTERN = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/;
const INTERFACE_KEYS = new Set(['privatekey', 'listenport', 'address', 'dns', 'mtu']);
const PEER_KEYS = new Set(['publickey', 'presharedkey', 'endpoint', 'allowedips', 'persistentkeepalive']);
// wg-quick keys that run commands or change routing on their own: named in the refusal so the operator knows why
const REFUSED_KEYS = new Set(['preup', 'postup', 'predown', 'postdown', 'table', 'fwmark', 'saveconfig']);

function bad(message: string, nextAction = 'Download the WireGuard configuration again from your VPN provider and paste it unchanged.'): HarborError {
  return new HarborError('INVALID_REQUEST', message, { nextAction });
}

export function isWireguardKey(v: string): boolean {
  return KEY_PATTERN.test(v);
}

// "10.64.1.2/32", "fc00::2/128" or a bare address
export function parseCidr(v: string): { address: string; prefix: number; family: 4 | 6 } | null {
  const m = /^([^/\s]+)(?:\/(\d{1,3}))?$/.exec(v.trim());
  if (!m) return null;
  const family = isIP(m[1]!);
  if (family !== 4 && family !== 6) return null;
  const max = family === 4 ? 32 : 128;
  const prefix = m[2] === undefined ? max : Number(m[2]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { address: m[1]!, prefix, family };
}

// host:port, [v6]:port; the host may be a DNS name (wg resolves it when the tunnel comes up)
export function parseEndpoint(v: string): { host: string; port: number } | null {
  const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9.-]{1,253})):(\d{1,5})$/.exec(v.trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  const host = m[1] ?? m[2]!;
  if (m[1] !== undefined && isIP(host) !== 6) return null;
  if (m[2] !== undefined && isIP(host) === 0 && !/^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(host)) return null;
  return { host, port };
}

function list(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// The whole IPv4 internet must go into the tunnel: a split configuration would leave the apps without most of it.
export function coversIpv4Internet(allowedIps: string[]): boolean {
  const set = new Set(allowedIps.map((a) => a.replace(/\s+/g, '')));
  return set.has('0.0.0.0/0') || (set.has('0.0.0.0/1') && set.has('128.0.0.0/1'));
}

export function parseWireguardConfig(text: string): WireguardConfig {
  if (typeof text !== 'string' || !text.trim()) throw bad('the WireGuard configuration is empty');
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) throw bad(`the WireGuard configuration is larger than ${MAX_CONFIG_BYTES / 1024} KiB`);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) throw bad('the WireGuard configuration contains control characters');
  }
  let section: 'interface' | 'peer' | null = null;
  let peers = 0;
  const iface: Record<string, string[]> = {};
  const peer: Record<string, string[]> = {};
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const head = /^\[([A-Za-z]+)\]$/.exec(line);
    if (head) {
      const name = head[1]!.toLowerCase();
      if (name === 'interface') {
        if (section !== null) throw bad(`line ${i + 1}: [Interface] must come first and only once`);
        section = 'interface';
      } else if (name === 'peer') {
        if (section === null) throw bad(`line ${i + 1}: [Peer] before [Interface]`);
        peers += 1;
        if (peers > 1) throw bad('the configuration has more than one [Peer]; Harbor uses one VPN server', 'Export a configuration for a single server from your VPN provider.');
        section = 'peer';
      } else throw bad(`line ${i + 1}: unknown section [${head[1]}]`);
      return;
    }
    const kv = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) throw bad(`line ${i + 1} is not "Key = value"`);
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    if (section === null) throw bad(`line ${i + 1}: ${kv[1]} outside a section`);
    if (REFUSED_KEYS.has(key)) throw bad(`${kv[1]} is not accepted: Harbor brings the tunnel up itself and never runs commands from the file`, `Delete the ${kv[1]} line and try again.`);
    const allowed = section === 'interface' ? INTERFACE_KEYS : PEER_KEYS;
    if (!allowed.has(key)) throw bad(`line ${i + 1}: ${kv[1]} is not a key Harbor knows in [${section === 'interface' ? 'Interface' : 'Peer'}]`);
    if (!value) throw bad(`line ${i + 1}: ${kv[1]} has no value`);
    const target = section === 'interface' ? iface : peer;
    (target[key] ??= []).push(value);
  });
  if (!peers) throw bad('the configuration has no [Peer] (the VPN server)');
  const one = (rec: Record<string, string[]>, key: string, label: string, required: boolean): string | null => {
    const v = rec[key];
    if (!v?.length) {
      if (required) throw bad(`${label} is missing`);
      return null;
    }
    if (v.length > 1) throw bad(`${label} appears more than once`);
    return v[0]!;
  };
  const privateKey = one(iface, 'privatekey', 'PrivateKey', true)!;
  if (!isWireguardKey(privateKey)) throw bad('PrivateKey is not a WireGuard key (44 characters of base64)');
  const listenPortRaw = one(iface, 'listenport', 'ListenPort', false);
  const listenPort = listenPortRaw === null ? null : Number(listenPortRaw);
  if (listenPort !== null && (!/^\d{1,5}$/.test(listenPortRaw!) || listenPort < 1 || listenPort > 65535)) throw bad('ListenPort must be a port number');
  const addresses = (iface['address'] ?? []).flatMap(list);
  if (!addresses.length) throw bad('Address is missing (the tunnel address your provider gave you)');
  for (const a of addresses) if (!parseCidr(a)) throw bad(`Address ${a} is not an IP address`);
  if (!addresses.some((a) => parseCidr(a)!.family === 4)) throw bad('Address needs an IPv4 address: Harbor\'s app networks use IPv4');
  // DNS may also hold search domains (wg-quick hands them to resolvconf): those are not resolvers, so they are left out
  const dns = (iface['dns'] ?? []).flatMap(list).filter((d) => isIP(d) !== 0);
  const dns4 = dns.filter((d) => isIP(d) === 4);
  const mtuRaw = one(iface, 'mtu', 'MTU', false);
  const mtu = mtuRaw === null ? null : Number(mtuRaw);
  if (mtu !== null && (!/^\d{3,4}$/.test(mtuRaw!) || mtu < 1280 || mtu > 1500)) throw bad('MTU must be between 1280 and 1500');
  const publicKey = one(peer, 'publickey', 'PublicKey', true)!;
  if (!isWireguardKey(publicKey)) throw bad('PublicKey is not a WireGuard key (44 characters of base64)');
  const presharedKey = one(peer, 'presharedkey', 'PresharedKey', false);
  if (presharedKey !== null && !isWireguardKey(presharedKey)) throw bad('PresharedKey is not a WireGuard key (44 characters of base64)');
  const endpoint = one(peer, 'endpoint', 'Endpoint', true)!;
  if (!parseEndpoint(endpoint)) throw bad(`Endpoint ${endpoint} is not host:port`);
  const allowedIps = (peer['allowedips'] ?? []).flatMap(list);
  if (!allowedIps.length) throw bad('AllowedIPs is missing');
  for (const a of allowedIps) if (!parseCidr(a)) throw bad(`AllowedIPs ${a} is not an IP range`);
  if (!coversIpv4Internet(allowedIps)) throw bad('AllowedIPs does not send the whole internet through the VPN (it needs 0.0.0.0/0)', 'Export a configuration that routes all traffic (often called "full tunnel" or "all traffic") from your VPN provider.');
  const kaRaw = one(peer, 'persistentkeepalive', 'PersistentKeepalive', false);
  let keepalive = DEFAULT_KEEPALIVE;
  if (kaRaw !== null && kaRaw.toLowerCase() !== 'off') {
    if (!/^\d{1,5}$/.test(kaRaw) || Number(kaRaw) > 65535) throw bad('PersistentKeepalive must be a number of seconds');
    // 0 turns keepalives off; Harbor needs them to tell a dead tunnel apart, so it keeps its own default then
    keepalive = Number(kaRaw) > 0 ? Number(kaRaw) : DEFAULT_KEEPALIVE;
  }
  return {
    privateKey,
    listenPort,
    addresses,
    dns: dns4,
    mtu,
    peer: { publicKey, presharedKey, endpoint, allowedIps, persistentKeepalive: keepalive },
  };
}

// What `wg setconf` takes: keys only, no Address/DNS/MTU (those are set with `ip`).
export function wgSetconfText(c: WireguardConfig): string {
  const lines = ['[Interface]', `PrivateKey = ${c.privateKey}`];
  if (c.listenPort !== null) lines.push(`ListenPort = ${c.listenPort}`);
  lines.push('', '[Peer]', `PublicKey = ${c.peer.publicKey}`);
  if (c.peer.presharedKey) lines.push(`PresharedKey = ${c.peer.presharedKey}`);
  lines.push(`Endpoint = ${c.peer.endpoint}`, `AllowedIPs = ${c.peer.allowedIps.join(', ')}`, `PersistentKeepalive = ${c.peer.persistentKeepalive}`);
  return lines.join('\n') + '\n';
}

export function tunnelSummary(c: WireguardConfig): TunnelSummary {
  return {
    endpoint: c.peer.endpoint,
    addresses: [...c.addresses],
    dns: c.dns.length ? [...c.dns] : [DNS_FALLBACK],
    dnsFallback: c.dns.length === 0,
    mtu: c.mtu ?? DEFAULT_MTU,
    peerPublicKey: c.peer.publicKey,
  };
}

// The resolver VPN apps' DNS is sent to (the first IPv4 one the file names, else the fallback)
export function tunnelDns(c: Pick<WireguardConfig, 'dns'>): string {
  return c.dns[0] ?? DNS_FALLBACK;
}

// `wg show <if> dump`: first line is the interface, then one line per peer:
// public-key preshared-key endpoint allowed-ips latest-handshake rx tx keepalive
export function parseWgDump(stdout: string): { latestHandshake: number | null; rxBytes: number; txBytes: number; endpoint: string | null; interfacePublicKey: string | null } {
  const rows = stdout.trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  const iface = rows[0];
  const p = rows[1];
  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : 0);
  const hs = num(p?.[4]);
  return {
    interfacePublicKey: iface?.[1] && isWireguardKey(iface[1]) ? iface[1] : null,
    endpoint: p?.[2] && p[2] !== '(none)' ? p[2] : null,
    latestHandshake: hs > 0 ? hs : null,
    rxBytes: num(p?.[5]),
    txBytes: num(p?.[6]),
  };
}
