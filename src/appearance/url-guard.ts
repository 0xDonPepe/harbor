import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

// Decision 169: the wallpaper fetcher talks to the internet on its own (Reddit, Bing, Wikimedia and whatever
// image hosts their listings name). A listing or a redirect must never point it at this machine or the home
// network, so every URL it fetches, and every redirect hop, is checked here first: https only, and the host
// may not be (or resolve to) a loopback, private, link-local, CGNAT, unique-local or otherwise special address.
//
// Best-effort against DNS rebinding: the name is resolved here and again by fetch() itself, so a server that
// answers differently the second time can still win the race. IP literals are checked exactly.

const BLOCKED_V4 = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT (also Tailscale)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const;
const BLOCKED_V6 = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // old site-local
  ['ff00::', 8], // multicast
] as const;

const blocked = new BlockList();
for (const [net, bits] of BLOCKED_V4) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of BLOCKED_V6) blocked.addSubnet(net, bits, 'ipv6');

/** True for an address the wallpaper fetcher may talk to (a public unicast address). */
export function isPublicAddress(address: string): boolean {
  let a = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const fam = isIP(a);
  if (!fam) return false;
  if (fam === 6) {
    // IPv4-mapped / -compatible / NAT64 well-known forms carry an IPv4 address: judge that one.
    const m = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (m) a = m[1]!;
    else {
      const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
      if (hex) {
        const hi = parseInt(hex[1]!, 16);
        const lo = parseInt(hex[2]!, 16);
        a = [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
      }
    }
  }
  try {
    return !blocked.check(a, isIP(a) === 6 ? 'ipv6' : 'ipv4');
  } catch {
    return false;
  }
}

export type Resolver = (host: string) => Promise<string[]>;
export const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** Throws when the fetcher must not request this URL (not https, a private address, or a name that resolves to one). */
export async function assertPublicHttpsUrl(raw: string, resolve: Resolver = systemResolver): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw.slice(0, 200)}`);
  }
  if (u.protocol !== 'https:') throw new Error(`refusing to fetch ${u.protocol}// (only https is allowed)`);
  if (u.username || u.password) throw new Error('refusing a URL with credentials in it');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new Error(`refusing to fetch from ${host}: a local or private address`);
    return u;
  }
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal') || !name.includes('.')) {
    throw new Error(`refusing to fetch from ${host}: a local name`);
  }
  let addrs: string[];
  try {
    addrs = await resolve(name);
  } catch (e) {
    throw new Error(`cannot resolve ${host}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  if (!addrs.length) throw new Error(`cannot resolve ${host}`);
  const bad = addrs.find((a) => !isPublicAddress(a));
  if (bad) throw new Error(`refusing to fetch from ${host}: it resolves to a local or private address (${bad})`);
  return u;
}
