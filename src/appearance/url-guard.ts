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

/** The eight 16-bit groups of an IPv6 address (dotted IPv4 tail allowed), or null. */
function v6Groups(a: string): number[] | null {
  let s = a;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const o = dotted[2]!.split('.').map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h: string): number[] => (h ? h.split(':').map((g) => parseInt(g, 16)) : []);
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const g = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return g.length === 8 && g.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? g : null;
}

const v4Of = (hi: number, lo: number): string => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');

/**
 * The IPv4 address an IPv6 address stands for, when it is one of the forms that carry one: IPv4-compatible
 * (::/96), IPv4-mapped (::ffff:0:0/96), IPv4-translated (::ffff:0:0:0/96), NAT64 (64:ff9b::/96) and 6to4
 * (2002::/16). URLs and getaddrinfo write these in hex (`64:ff9b::7f00:1`), so the groups are read, not the text.
 */
function embeddedV4(g: number[]): string | null {
  const zero = (from: number, to: number) => g.slice(from, to).every((n) => n === 0);
  if (zero(0, 6)) return v4Of(g[6]!, g[7]!); // ::a.b.c.d (also :: and ::1, which become 0.0.0.x: refused)
  if (zero(0, 5) && g[5] === 0xffff) return v4Of(g[6]!, g[7]!); // ::ffff:a.b.c.d
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4Of(g[6]!, g[7]!); // ::ffff:0:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4Of(g[6]!, g[7]!); // 64:ff9b::a.b.c.d
  if (g[0] === 0x2002) return v4Of(g[1]!, g[2]!); // 6to4: 2002:AABB:CCDD::/48
  return null;
}

/** True for an address the wallpaper fetcher may talk to (a public unicast address). */
export function isPublicAddress(address: string): boolean {
  let a = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const fam = isIP(a);
  if (!fam) return false;
  if (fam === 6) {
    const g = v6Groups(a);
    if (!g) return false;
    if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo (2001::/32): tunnels to an IPv4 address it hides
    const v4 = embeddedV4(g);
    if (v4) a = v4;
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
