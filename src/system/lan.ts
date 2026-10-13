import { BlockList } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';

// LAN mode: Harbor answers on the local network as http://<hostname>.local (mDNS via avahi) and on its
// addresses. The Host/Origin allow-list follows what this machine actually is, recomputed cheaply.
export function machineAddresses(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal) continue;
      out.add(a.address.toLowerCase());
    }
  }
  return [...out];
}

// RFC 1918 / link-local / CGNAT: "this looks like a home or office network, not the public internet".
export function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
// Decision 165: the peer a LAN-mode request really came from must be on a local network. A Host header proves
// nothing (anyone on the internet can send `Host: harbor.local` to a forwarded port 80/443), so the LAN names
// are only honoured for loopback, RFC 1918, link-local, CGNAT (tailnet), IPv6 unique-local peers, and peers on
// one of this machine's own subnets (a home network handing out global IPv6 addresses, or public IPv4 on a LAN).
export const LAN_PEER_RANGES = ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', 'fc00::/7', 'fe80::/10'];
// The machine's own subnets, as CIDRs (Caddy's `remote_ip` gets them too). Interface prefixes wider than /16
// (IPv4) or /48 (IPv6) are ignored: a "subnet" that big is not a home network.
export function localSubnets(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.internal || !a.cidr) continue;
      const [addr, bits] = a.cidr.split('/');
      const prefix = Number(bits);
      if (a.family === 'IPv4' ? prefix < 16 : prefix < 48) continue;
      out.add(`${networkAddress(addr!, prefix, a.family === 'IPv6')}/${prefix}`);
    }
  }
  return [...out].sort();
}
function networkAddress(addr: string, prefix: number, v6: boolean): string {
  if (!v6) {
    const n = addr.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    const masked = prefix === 0 ? 0 : (n & (0xffffffff << (32 - prefix))) >>> 0;
    return [24, 16, 8, 0].map((sh) => (masked >>> sh) & 255).join('.');
  }
  const full = expandV6(addr);
  let bitsLeft = prefix;
  return full
    .map((g) => {
      const keep = Math.max(0, Math.min(16, bitsLeft));
      bitsLeft -= 16;
      return ((parseInt(g, 16) & (keep === 0 ? 0 : (0xffff << (16 - keep)) & 0xffff)) >>> 0).toString(16);
    })
    .join(':');
}
function expandV6(addr: string): string[] {
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  return tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
}
let peerList: { at: number; list: BlockList } | null = null;
function lanPeerList(): BlockList {
  if (peerList && Date.now() - peerList.at < 30_000) return peerList.list;
  const list = new BlockList();
  for (const cidr of [...LAN_PEER_RANGES, ...localSubnets()]) {
    const [net, bits] = cidr.split('/');
    list.addSubnet(net!, Number(bits), net!.includes(':') ? 'ipv6' : 'ipv4');
  }
  peerList = { at: Date.now(), list };
  return list;
}
export function isLanPeer(address: string | undefined, list: BlockList = lanPeerList()): boolean {
  if (!address) return false;
  const a = address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, '').replace(/%.*$/, '');
  try {
    return list.check(a, a.includes(':') ? 'ipv6' : 'ipv4');
  } catch {
    return false;
  }
}

export function privateInterfaces(): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal && a.family === 'IPv4' && isPrivateIPv4(a.address)) out.push({ name, address: a.address });
  }
  return out;
}

export function lanHostnames(): string[] {
  const h = hostname().toLowerCase().replace(/\.local$/, '');
  return [h, `${h}.local`, 'harbor.local'];
}

// Accept `Host:` values that name this machine on the LAN: <hostname>[.local], any *.local (avahi may suffix -2),
// or one of our own addresses, each with the LAN port, no port, or the management port.
export function lanHostAllowed(host: string, lanPort: number, managementPort: number, addresses: string[] = machineAddresses()): boolean {
  const m = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d+))?$/i.exec(host.trim());
  if (!m) return false;
  const name = m[1]!.toLowerCase().replace(/^\[|\]$/g, '');
  const port = m[2] ? Number(m[2]) : lanPort === 80 ? 80 : null;
  if (port !== null && port !== lanPort && port !== managementPort && !(port === 80 && lanPort === 80)) return false;
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1') return true;
  if (/^[a-z0-9-]+\.local$/.test(name)) return true;
  if (lanHostnames().includes(name)) return true;
  return addresses.includes(name);
}

// Every name a LAN device can use for this machine (decision 116): the mDNS names plus the private IPv4
// addresses of real interfaces (Docker bridges and veths are not reachable from the LAN).
export function lanNames(): string[] {
  const ips = privateInterfaces()
    .filter((i) => !/^(docker|br-|veth|virbr|tailscale|cni|flannel)/.test(i.name))
    .map((i) => i.address);
  return [...new Set([...lanHostnames(), ...ips])];
}

// The name app addresses use in LAN mode: <hostname>.local (the console swaps in the host it was opened with).
export function lanAppHost(): string {
  return `${hostname().toLowerCase().replace(/\.local$/, '')}.local`;
}

export function lanUrl(port: number): string {
  const h = hostname().toLowerCase().replace(/\.local$/, '');
  return port === 80 ? `http://${h}.local/` : `http://${h}.local:${port}/`;
}
