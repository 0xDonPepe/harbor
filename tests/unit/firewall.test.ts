import { describe, expect, it } from 'vitest';
import { LAN_SOURCES, lanFirewallPorts, ufwActive, ufwAllowArgs, ufwDeleteArgs } from '../../src/bootstrap/firewall.js';

describe('LAN firewall ports (decision 160)', () => {
  it('covers the console, 443, the app range, its LAN HTTPS twin and mDNS', () => {
    expect(lanFirewallPorts({ lanPort: 80, appPortRange: { from: 18080, to: 18999 } })).toEqual([
      { port: '80', proto: 'tcp' },
      { port: '443', proto: 'tcp' },
      { port: '18080:18999', proto: 'tcp' },
      { port: '38080:38999', proto: 'tcp' },
      { port: '5353', proto: 'udp' },
    ]);
  });

  it('follows a custom LAN port and app range, and never repeats 443', () => {
    const ports = lanFirewallPorts({ lanPort: 443, appPortRange: { from: 20000, to: 20000 } });
    expect(ports.filter((p) => p.port === '443')).toHaveLength(1);
    expect(ports).toContainEqual({ port: '20000', proto: 'tcp' });
    expect(ports).toContainEqual({ port: '40000', proto: 'tcp' });
  });
});

describe('ufw arguments', () => {
  it('only opens to private networks, never Anywhere', () => {
    const args = ufwAllowArgs({ port: '38080:38999', proto: 'tcp' }, '192.168.0.0/16');
    expect(args).toEqual(['allow', 'from', '192.168.0.0/16', 'to', 'any', 'port', '38080:38999', 'proto', 'tcp', 'comment', 'harbor']);
    expect(LAN_SOURCES).toEqual(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fd00::/8', 'fe80::/10']);
  });

  it('deletes exactly the rule it added', () => {
    expect(ufwDeleteArgs({ port: '80', proto: 'tcp' }, '10.0.0.0/8')).toEqual(['delete', 'allow', 'from', '10.0.0.0/8', 'to', 'any', 'port', '80', 'proto', 'tcp']);
  });

  it('reads ufw status', () => {
    expect(ufwActive('Status: active\n\nTo                         Action      From\n')).toBe(true);
    expect(ufwActive('Status: inactive\n')).toBe(false);
    expect(ufwActive('')).toBe(false);
  });
});
