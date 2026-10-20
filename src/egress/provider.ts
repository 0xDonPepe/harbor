// The daemon-side half of VPN and offline apps (decision 184). The daemon never runs nft, ip or wg: it writes
// <stateDir>/egress/request.json, hands the WireGuard file (it holds the private key) through a FIFO, blocks on
// `systemctl start harbor-egress@<action>.service` (polkit lets the harbor user start that template only) and reads
// the root step's verdict back. Failures are hard: the caller's operation fails, the app does not start.
//
// In fake mode (tests, `pnpm dev`) the fake keeps what the kernel would hold in memory.
import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { systemctlStartBlocking, type UnitStarter } from '../storage/crypto-provider.js';
import { TUNNEL_IF, validateEgressState, type EgressState } from './rules.js';
import { parseWireguardConfig, tunnelSummary, type TunnelSummary } from './wireguard.js';

export type EgressAction = 'apply' | 'tunnel-set' | 'tunnel-remove' | 'status';
export const EGRESS_ACTIONS: readonly EgressAction[] = ['apply', 'tunnel-set', 'tunnel-remove', 'status'];
export const EGRESS_UNIT_PREFIX = 'harbor-egress@';
export const EGRESS_UNIT_FILE = 'harbor-egress@.service';
export const EGRESS_BOOT_UNIT = 'harbor-egress.service';
export const VPN_UNIT = 'harbor-vpn.service';
export const NFT_BIN = '/usr/sbin/nft';
export const WG_BIN = '/usr/bin/wg';
export const IP_BIN = '/usr/sbin/ip';

export function egressUnit(action: EgressAction): string {
  return `${EGRESS_UNIT_PREFIX}${action}.service`;
}

export function parseEgressAction(v: string): EgressAction {
  if (!(EGRESS_ACTIONS as readonly string[]).includes(v)) throw new HarborError('INVALID_REQUEST', `egress-step expects one of ${EGRESS_ACTIONS.join(', ')}, got ${v}`);
  return v as EgressAction;
}

export function egressFiles(stateDir: string): { dir: string; request: string; status: string; fifo: string } {
  const dir = path.join(stateDir, 'egress');
  return { dir, request: path.join(dir, 'request.json'), status: path.join(dir, 'status.json'), fifo: path.join(dir, 'tunnel.fifo') };
}

export interface EgressRequest {
  action: EgressAction;
  // apply: the whole desired state
  state?: EgressState;
  requestedAt: string;
}

// What root reports after every action: the tunnel as the kernel has it.
export interface TunnelReport {
  // a configuration is stored
  configured: boolean;
  // the interface exists
  present: boolean;
  // unix seconds of the last handshake with the server, null = none yet
  latestHandshake: number | null;
  rxBytes: number;
  txBytes: number;
  endpoint: string | null;
  summary: TunnelSummary | null;
  // how many apps the loaded rules cover
  apps: number;
}

export interface EgressStatusFile {
  action: EgressAction;
  state: 'working' | 'ok' | 'failed';
  message: string;
  nextAction?: string;
  report?: TunnelReport;
  at: string;
}

export function parseEgressStatus(raw: string): EgressStatusFile | null {
  try {
    const d = JSON.parse(raw) as EgressStatusFile;
    if (!d || typeof d !== 'object' || typeof d.state !== 'string' || typeof d.message !== 'string') return null;
    return d;
  } catch {
    return null;
  }
}

export interface EgressProvider {
  readonly kind: 'fake' | 'root';
  // can this machine do it at all (nft and ip present; wg for a tunnel)
  available(): { ok: boolean; tunnel: boolean; reason: string | null };
  apply(state: EgressState): Promise<TunnelReport>;
  setTunnel(configText: string): Promise<TunnelReport>;
  removeTunnel(): Promise<TunnelReport>;
  status(): Promise<TunnelReport>;
  // without root: does the interface exist, how many bytes came in (sysfs; null = unknown)
  readModel(): { present: boolean; rxBytes: number | null };
}

// ---------------------------------------------------------------- fake

export class FakeEgressProvider implements EgressProvider {
  readonly kind = 'fake' as const;
  applied: EgressState[] = [];
  calls: EgressAction[] = [];
  tunnel: TunnelSummary | null = null;
  // the "server" answers (handshakes, received bytes grow)
  connected = true;
  failWith: string | null = null;
  private rx = 0;
  private since = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}
  available() {
    return { ok: true, tunnel: true, reason: null };
  }
  get state(): EgressState | null {
    return this.applied.at(-1) ?? null;
  }
  private fail(): void {
    if (this.failWith) throw new HarborError('OPERATION_FAILED', this.failWith, { nextAction: 'Check the journal of harbor-egress@apply.service, then try again.' });
  }
  private report(): TunnelReport {
    const present = this.tunnel !== null;
    if (present && this.connected) this.rx += 92;
    return {
      configured: present,
      present,
      latestHandshake: present && this.connected ? Math.floor(this.now() / 1000) - 5 : null,
      rxBytes: present ? this.rx : 0,
      txBytes: present ? this.rx * 2 : 0,
      endpoint: present && this.connected ? this.tunnel!.endpoint : null,
      summary: this.tunnel,
      apps: this.state?.apps.length ?? 0,
    };
  }
  async apply(state: EgressState): Promise<TunnelReport> {
    this.calls.push('apply');
    this.fail();
    this.applied.push(validateEgressState(state));
    return this.report();
  }
  async setTunnel(configText: string): Promise<TunnelReport> {
    this.calls.push('tunnel-set');
    this.fail();
    this.tunnel = tunnelSummary(parseWireguardConfig(configText));
    this.since = this.now();
    return this.report();
  }
  async removeTunnel(): Promise<TunnelReport> {
    this.calls.push('tunnel-remove');
    this.fail();
    this.tunnel = null;
    return this.report();
  }
  async status(): Promise<TunnelReport> {
    this.calls.push('status');
    return this.report();
  }
  readModel() {
    if (!this.tunnel) return { present: false, rxBytes: null };
    if (this.connected) this.rx += 92;
    return { present: true, rxBytes: this.rx };
  }
  get tunnelSetAt(): number {
    return this.since;
  }
}

// ---------------------------------------------------------------- live

function mkfifo(p: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/mkfifo', ['-m', '600', p], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `mkfifo exited ${code}`))));
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TIMEOUTS: Record<EgressAction, number> = { apply: 90_000, 'tunnel-set': 90_000, 'tunnel-remove': 60_000, status: 30_000 };

export class RootEgressProvider implements EgressProvider {
  readonly kind = 'root' as const;
  constructor(
    private readonly stateDir: string,
    private readonly startUnit: UnitStarter = systemctlStartBlocking,
    private readonly sysNet = '/sys/class/net',
  ) {}

  available() {
    const nft = existsSync(NFT_BIN) && existsSync(IP_BIN);
    const wg = existsSync(WG_BIN);
    if (!nft) return { ok: false, tunnel: false, reason: 'nftables is not installed on this machine. Re-run bootstrap (or update Harbor) so it installs it, or run: sudo apt-get install -y nftables' };
    return { ok: true, tunnel: wg, reason: wg ? null : 'wireguard-tools is not installed on this machine. Re-run bootstrap (or update Harbor) so it installs it, or run: sudo apt-get install -y wireguard-tools' };
  }

  private async run(action: EgressAction, extra: { state?: EgressState; configText?: string } = {}): Promise<TunnelReport> {
    const files = egressFiles(this.stateDir);
    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    rmSync(files.status, { force: true });
    rmSync(files.fifo, { force: true });
    const request: EgressRequest = { action, ...(extra.state ? { state: extra.state } : {}), requestedAt: new Date().toISOString() };
    writeFileSync(files.request, JSON.stringify(request), { mode: 0o600 });
    const unit = egressUnit(action);
    let unitError: string | null = null;
    try {
      if (extra.configText !== undefined) await mkfifo(files.fifo);
      let done = false;
      const started = this.startUnit(unit, TIMEOUTS[action])
        .catch((e: Error) => {
          unitError = e.message;
        })
        .finally(() => {
          done = true;
        });
      if (extra.configText !== undefined) {
        // as for app keys (decision 103): the file goes through the FIFO once root opens it, never onto a disk
        const text = extra.configText;
        while (!done) {
          let fd: number | null = null;
          try {
            fd = openSync(files.fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENXIO') {
              unitError ??= `cannot hand over the configuration: ${(e as Error).message}`;
              break;
            }
            await sleep(50);
            continue;
          }
          try {
            writeSync(fd, text);
          } finally {
            closeSync(fd);
          }
          break;
        }
      }
      await started;
      let raw: string | null = null;
      try {
        raw = readFileSync(files.status, 'utf8');
      } catch {
        raw = null;
      }
      const status = raw ? parseEgressStatus(raw) : null;
      if (status?.state === 'ok' && status.report) return status.report;
      if (status?.state === 'failed') throw new HarborError('OPERATION_FAILED', status.message, { nextAction: status.nextAction ?? `On the machine, run: journalctl -u ${unit} --no-pager -n 50` });
      throw new HarborError('OPERATION_FAILED', `${unit} gave no verdict${unitError ? ` (${unitError})` : ''}`, {
        nextAction: `On the machine, run: journalctl -u ${unit} --no-pager -n 50 — and check that Harbor's polkit rule and units are installed (re-run bootstrap if not).`,
      });
    } finally {
      rmSync(files.request, { force: true });
      rmSync(files.fifo, { force: true });
    }
  }

  apply(state: EgressState): Promise<TunnelReport> {
    return this.run('apply', { state });
  }
  setTunnel(configText: string): Promise<TunnelReport> {
    return this.run('tunnel-set', { configText });
  }
  removeTunnel(): Promise<TunnelReport> {
    return this.run('tunnel-remove');
  }
  status(): Promise<TunnelReport> {
    return this.run('status');
  }
  readModel() {
    const dir = path.join(this.sysNet, TUNNEL_IF);
    if (!existsSync(dir)) return { present: false, rxBytes: null };
    try {
      return { present: true, rxBytes: Number(readFileSync(path.join(dir, 'statistics', 'rx_bytes'), 'utf8').trim()) };
    } catch {
      return { present: true, rxBytes: null };
    }
  }
}
