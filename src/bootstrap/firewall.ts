// ufw for LAN mode (decision 160): Harbor prints `http://<hostname>.local` and
// `https://<hostname>.local:<port>` at install, so it owns making those reach the
// machine. Ubuntu ships ufw; with it active (default deny incoming) the console
// on 80 answered only because an operator had allowed 80, and every LAN HTTPS
// app proxy (hostPort + 20000, served by the daemon) timed out from the
// network. Seen live on the home server: `https://harbor.local:38085` dropped
// while `http://harbor.local:18085` worked — Docker-published ports skip ufw's
// INPUT chain, the daemon's own listeners do not.
//
// Fix: on every LAN-mode bootstrap (install and each self-update), when ufw is
// installed, allow the console port, 443, the app range and its LAN HTTPS twin,
// and mDNS — from private networks only, never Anywhere. Rules are added even
// while ufw is inactive, so turning it on later does not cut Harbor off. ufw
// skips rules it already has, so re-runs are no-ops. Uninstall deletes them.
import { existsSync } from 'node:fs';
import { exec } from './exec.js';
import { LAN_HTTPS_PORT, LAN_HTTPS_PORT_OFFSET } from '../system/lan-https.js';

export const UFW = '/usr/sbin/ufw';
export const UFW_COMMENT = 'harbor';

// RFC 1918 + IPv6 unique-local and link-local (mDNS resolves harbor.local to
// either family). Same idea of "home network" as LAN mode's own safety check.
export const LAN_SOURCES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fd00::/8', 'fe80::/10'] as const;

export interface FirewallPort {
  port: string;
  proto: 'tcp' | 'udp';
}

function span(from: number, to: number): string {
  return from === to ? String(from) : `${from}:${to}`;
}

export function lanFirewallPorts(opts: { lanPort: number; appPortRange: { from: number; to: number } }): FirewallPort[] {
  const { from, to } = opts.appPortRange;
  const out: FirewallPort[] = [{ port: String(opts.lanPort), proto: 'tcp' }];
  if (opts.lanPort !== LAN_HTTPS_PORT) out.push({ port: String(LAN_HTTPS_PORT), proto: 'tcp' });
  out.push({ port: span(from, to), proto: 'tcp' });
  out.push({ port: span(from + LAN_HTTPS_PORT_OFFSET, to + LAN_HTTPS_PORT_OFFSET), proto: 'tcp' });
  out.push({ port: '5353', proto: 'udp' });
  return out;
}

export function ufwAllowArgs(p: FirewallPort, source: string): string[] {
  return ['allow', 'from', source, 'to', 'any', 'port', p.port, 'proto', p.proto, 'comment', UFW_COMMENT];
}

export function ufwDeleteArgs(p: FirewallPort, source: string): string[] {
  return ['delete', 'allow', 'from', source, 'to', 'any', 'port', p.port, 'proto', p.proto];
}

export function ufwActive(statusOutput: string): boolean {
  return /^Status:\s*active\b/m.test(statusOutput);
}

// Root step (bootstrap, LAN mode). Never throws: a firewall the operator
// manages some other way must not stop Harbor from installing.
export async function openLanFirewall(log: (m: string) => void, opts: { lanPort: number; appPortRange: { from: number; to: number } }): Promise<{ applied: boolean; active: boolean }> {
  if (!existsSync(UFW)) return { applied: false, active: false };
  let active = false;
  try {
    active = ufwActive((await exec(UFW, ['status'], { timeoutMs: 30_000 })).stdout);
  } catch {
    /* status unreadable: still try to add the rules */
  }
  const ports = lanFirewallPorts(opts);
  const failed: string[] = [];
  for (const p of ports) {
    for (const src of LAN_SOURCES) {
      try {
        const r = await exec(UFW, ufwAllowArgs(p, src), { timeoutMs: 30_000 });
        if (r.code !== 0) failed.push(`${p.port}/${p.proto} from ${src}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
      } catch (e) {
        failed.push(`${p.port}/${p.proto} from ${src}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  const list = ports.map((p) => `${p.port}/${p.proto}`).join(', ');
  log(`firewall: ufw ${active ? 'is on' : 'is installed but off'}; allowed ${list} from private networks (comment "${UFW_COMMENT}")`);
  for (const f of failed) log(`firewall: could not add a ufw rule (${f})`);
  return { applied: failed.length === 0, active };
}

// Uninstall: delete what openLanFirewall added. A missing rule is not an error.
export async function closeLanFirewall(log: (m: string) => void, opts: { lanPort: number; appPortRange: { from: number; to: number } }): Promise<void> {
  if (!existsSync(UFW)) return;
  for (const p of lanFirewallPorts(opts)) {
    for (const src of LAN_SOURCES) {
      await exec(UFW, ufwDeleteArgs(p, src), { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }
  log('firewall: removed Harbor\'s ufw rules');
}
