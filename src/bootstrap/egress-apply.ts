// Root half of VPN and offline apps (decision 184, docs/design/VPN.md), run by harbor-egress@<action>.service via
// `harbor egress-step <action>`, plus the two boot steps (`harbor egress-boot`, `harbor egress-tunnel-up`).
//
// The daemon writes <stateDir>/egress/request.json and, for tunnel-set, streams the WireGuard file through
// tunnel.fifo (it holds the private key). This step re-validates everything itself (validateEgressState,
// parseWireguardConfig), renders the nftables ruleset and the `ip` arguments with the pure builders, runs them
// with argv only (never a shell) and writes its verdict to status.json.
//
// Root keeps its own copy under /etc/harbor/egress (0700, root only): state.json (the app rules), tunnel.conf
// (`wg setconf` text, 0600), tunnel.json (address, DNS, MTU, summary) and rules.nft (the ruleset that loaded
// last; harbor-egress.service loads it with `nft -f` before Docker starts).
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { loadConfig } from '../config.js';
import { exec, execOk } from './exec.js';
import { readFileNoFollow, writeStatusFile } from './safe-write.js';
import { catchAllRouteArgs, flushRouteTableArgs, ipRuleArgs, ipRuleDeleteArgs, NFT_FAMILY, NFT_TABLE, nftDeleteScript, nftRuleset, TUNNEL_IF, tunnelRouteArgs, validateEgressState, isDnsServer, type EgressState } from '../egress/rules.js';
import { parseCidr, parseWgDump, parseWireguardConfig, tunnelDns, tunnelSummary, wgSetconfText, MAX_CONFIG_BYTES, type TunnelSummary, type WireguardConfig } from '../egress/wireguard.js';
import { egressFiles, IP_BIN, NFT_BIN, parseEgressAction, WG_BIN, type EgressAction, type EgressRequest, type EgressStatusFile, type TunnelReport } from '../egress/provider.js';

type Log = (m: string) => void;

export const EGRESS_ROOT_DIR = `${PRODUCT.paths.etc}/egress`;
export const EGRESS_ROOT_FILES = {
  state: path.join(EGRESS_ROOT_DIR, 'state.json'),
  tunnelConf: path.join(EGRESS_ROOT_DIR, 'tunnel.conf'),
  tunnelJson: path.join(EGRESS_ROOT_DIR, 'tunnel.json'),
  rules: path.join(EGRESS_ROOT_DIR, 'rules.nft'),
} as const;

interface TunnelFile {
  format: 1;
  summary: TunnelSummary;
  dnsServer: string;
  mtu: number;
  ipv4: string[];
}

function requireRoot(what: string): void {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', `${what} must run as root`);
}

// Root-only folder: nothing the harbor user can write, so plain writes (temp file + rename) are safe here.
function writeRootFile(file: string, data: string, mode: number): void {
  mkdirSync(EGRESS_ROOT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(EGRESS_ROOT_DIR, 0o700);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

function readState(): EgressState {
  if (!existsSync(EGRESS_ROOT_FILES.state)) return { format: 1, apps: [] };
  return validateEgressState(JSON.parse(readFileSync(EGRESS_ROOT_FILES.state, 'utf8')));
}

function readTunnel(): TunnelFile | null {
  if (!existsSync(EGRESS_ROOT_FILES.tunnelJson) || !existsSync(EGRESS_ROOT_FILES.tunnelConf)) return null;
  const t = JSON.parse(readFileSync(EGRESS_ROOT_FILES.tunnelJson, 'utf8')) as TunnelFile;
  if (t?.format !== 1 || !isDnsServer(t.dnsServer)) throw new HarborError('OPERATION_FAILED', `${EGRESS_ROOT_FILES.tunnelJson} is not readable; set the VPN again`);
  return t;
}

const interfacePresent = () => existsSync(`/sys/class/net/${TUNNEL_IF}`);

async function ip(args: string[], log?: Log): Promise<void> {
  await execOk(IP_BIN, ['-4', ...args], { timeoutMs: 30_000 });
  log?.(`ip ${args.join(' ')}`);
}

// Harbor's three rules, put back exactly (deleting by priority first, as many times as it is there).
async function setRouting(dns: string | null, log: Log): Promise<void> {
  for (const del of ipRuleDeleteArgs()) {
    for (let i = 0; i < 8; i++) if ((await exec(IP_BIN, ['-4', ...del], { timeoutMs: 30_000 })).code !== 0) break;
  }
  for (const add of ipRuleArgs(dns)) await ip(add);
  await ip(catchAllRouteArgs());
  if (interfacePresent()) await ip(tunnelRouteArgs());
  log(`routing: VPN apps use table 4842${interfacePresent() ? ` (through ${TUNNEL_IF})` : ' (no tunnel: unreachable)'}`);
}

async function clearRouting(): Promise<void> {
  for (const del of ipRuleDeleteArgs()) {
    for (let i = 0; i < 8; i++) if ((await exec(IP_BIN, ['-4', ...del], { timeoutMs: 30_000 })).code !== 0) break;
  }
  await exec(IP_BIN, ['-4', ...flushRouteTableArgs()], { timeoutMs: 30_000 });
}

// nft 1.0.9 (Ubuntu 24.04) refuses `nft -f -` from a pipe ("Not a regular file: /dev/stdin", seen live): the
// script goes into a root-only file first.
async function nftLoad(text: string, keepAs?: string): Promise<void> {
  const candidate = path.join(EGRESS_ROOT_DIR, `load-${process.pid}.nft`);
  writeRootFile(candidate, text, 0o600);
  try {
    await execOk(NFT_BIN, ['-f', candidate], { timeoutMs: 30_000 });
    // only a ruleset that just loaded becomes the boot copy, so the boot unit never meets one this kernel refuses
    if (keepAs) renameSync(candidate, keepAs);
  } finally {
    rmSync(candidate, { force: true });
  }
}

async function tableLoaded(): Promise<boolean> {
  return (await exec(NFT_BIN, ['list', 'table', NFT_FAMILY, NFT_TABLE], { timeoutMs: 30_000 })).code === 0;
}

// The whole host side for `state`: nft table (atomic), the boot copy of it, then routing. With no app rules and
// no tunnel, everything Harbor added goes away.
async function loadRules(state: EgressState, log: Log): Promise<void> {
  const tunnel = readTunnel();
  if (!state.apps.length && !tunnel) {
    if (await tableLoaded()) await nftLoad(nftDeleteScript());
    rmSync(EGRESS_ROOT_FILES.rules, { force: true });
    await clearRouting();
    log('no VPN and no app rules: Harbor\'s table, rules and routes removed');
    return;
  }
  if (!existsSync(NFT_BIN)) throw new HarborError('UNSUPPORTED_CAPABILITY', 'nftables is not installed on this machine', { nextAction: 'On the machine, run: sudo apt-get install -y nftables — then try again (Harbor bootstrap installs it normally).' });
  const text = nftRuleset(state, { dns: tunnel?.dnsServer ?? null, tunnel: tunnel !== null });
  await nftLoad(text, EGRESS_ROOT_FILES.rules);
  log(`firewall: ${state.apps.filter((a) => a.mode === 'vpn').length} VPN app(s), ${state.apps.filter((a) => a.mode === 'offline').length} offline app(s)`);
  await setRouting(tunnel?.dnsServer ?? null, log);
}

async function deleteInterface(): Promise<void> {
  if (interfacePresent()) await exec(IP_BIN, ['link', 'del', 'dev', TUNNEL_IF], { timeoutMs: 30_000 });
}

// (Re)create the interface from the stored files. Any failure removes it again: no half-made tunnel.
async function tunnelUp(t: TunnelFile, log: Log): Promise<void> {
  if (!existsSync(WG_BIN)) throw new HarborError('UNSUPPORTED_CAPABILITY', 'wireguard-tools is not installed on this machine', { nextAction: 'On the machine, run: sudo apt-get install -y wireguard-tools — then try again (Harbor bootstrap installs it normally).' });
  await deleteInterface();
  try {
    await execOk(IP_BIN, ['link', 'add', 'dev', TUNNEL_IF, 'type', 'wireguard'], { timeoutMs: 30_000 });
    const set = await exec(WG_BIN, ['setconf', TUNNEL_IF, EGRESS_ROOT_FILES.tunnelConf], { timeoutMs: 60_000 });
    if (set.code !== 0) {
      throw new HarborError('OPERATION_FAILED', `the VPN server could not be set up: ${(set.stderr || set.stdout).trim().split('\n').pop() ?? 'wg setconf failed'}`, {
        nextAction: 'Check that this machine is online and that the Endpoint in the file is right, then try again.',
      });
    }
    for (const a of t.ipv4) await execOk(IP_BIN, ['-4', 'address', 'add', a, 'dev', TUNNEL_IF], { timeoutMs: 30_000 });
    await execOk(IP_BIN, ['link', 'set', 'dev', TUNNEL_IF, 'mtu', String(t.mtu), 'up'], { timeoutMs: 30_000 });
    // replies from the server arrive on the tunnel with internet sources: loose reverse-path filtering there
    writeFileSync(`/proc/sys/net/ipv4/conf/${TUNNEL_IF}/rp_filter`, '2\n');
    await ip(tunnelRouteArgs());
    log(`tunnel ${TUNNEL_IF} up (server ${t.summary.endpoint})`);
  } catch (e) {
    await deleteInterface();
    throw e;
  }
}

function tunnelFileOf(c: WireguardConfig): TunnelFile {
  const s = tunnelSummary(c);
  return {
    format: 1,
    summary: s,
    dnsServer: tunnelDns(c),
    mtu: s.mtu,
    ipv4: c.addresses.filter((a) => parseCidr(a)?.family === 4).map((a) => (a.includes('/') ? a : `${a}/32`)),
  };
}

async function report(): Promise<TunnelReport> {
  const t = (() => {
    try {
      return readTunnel();
    } catch {
      return null;
    }
  })();
  const apps = (() => {
    try {
      return readState().apps.length;
    } catch {
      return 0;
    }
  })();
  const present = interfacePresent();
  let dump = { latestHandshake: null as number | null, rxBytes: 0, txBytes: 0, endpoint: null as string | null };
  if (present && existsSync(WG_BIN)) {
    const r = await exec(WG_BIN, ['show', TUNNEL_IF, 'dump'], { timeoutMs: 15_000 });
    if (r.code === 0) dump = parseWgDump(r.stdout);
  }
  return { configured: t !== null, present, latestHandshake: dump.latestHandshake, rxBytes: dump.rxBytes, txBytes: dump.txBytes, endpoint: dump.endpoint, summary: t?.summary ?? null, apps };
}

async function readConfigFromFifo(fifo: string): Promise<string> {
  // as for app keys: only the FIFO the daemon made, never a link or a file put in its place
  let st;
  try {
    st = lstatSync(fifo);
  } catch {
    throw new HarborError('INVALID_REQUEST', 'no VPN configuration was offered for this step (missing tunnel.fifo)');
  }
  if (!st.isFIFO()) throw new HarborError('INVALID_REQUEST', 'tunnel.fifo is not a FIFO');
  const r = await exec('/usr/bin/timeout', ['60', '/usr/bin/cat', fifo], { timeoutMs: 70_000 });
  if (r.code !== 0) throw new HarborError('OPERATION_FAILED', 'the daemon did not hand over the VPN configuration in time');
  if (Buffer.byteLength(r.stdout) > MAX_CONFIG_BYTES) throw new HarborError('INVALID_REQUEST', 'the VPN configuration is too large');
  return r.stdout;
}

function readRequest(file: string, expected: EgressAction): EgressRequest {
  let raw: string | null;
  try {
    raw = readFileNoFollow(file);
  } catch (e) {
    throw new HarborError('INVALID_REQUEST', `request at ${file} is not readable: ${(e as Error).message}`);
  }
  if (raw === null) throw new HarborError('INVALID_REQUEST', `no request at ${file}`);
  let doc: Partial<EgressRequest>;
  try {
    doc = JSON.parse(raw) as Partial<EgressRequest>;
  } catch {
    throw new HarborError('INVALID_REQUEST', `request at ${file} is not JSON`);
  }
  if (!doc || doc.action !== expected) throw new HarborError('INVALID_REQUEST', `request at ${file} does not match ${expected}`);
  return doc as EgressRequest;
}

function writeStatus(stateDir: string, file: string, status: EgressStatusFile): void {
  try {
    // 0644 in the daemon-owned egress/ dir: root writes, harbor reads and unlinks. Decision 169: never through a link.
    writeStatusFile(stateDir, file, JSON.stringify(status), { mode: 0o644 });
  } catch {
    /* the unit's exit code still carries the verdict */
  }
}

export async function applyEgressStep(actionArg: string, log: Log): Promise<void> {
  const action = parseEgressAction(actionArg);
  requireRoot('egress-step');
  const config = loadConfig(`${PRODUCT.paths.etc}/harbor.json`);
  const files = egressFiles(config.stateDir);
  const now = () => new Date().toISOString();
  try {
    const request = readRequest(files.request, action);
    rmSync(files.request, { force: true });
    switch (action) {
      case 'apply': {
        const state = validateEgressState(request.state);
        await loadRules(state, log);
        writeRootFile(EGRESS_ROOT_FILES.state, JSON.stringify(state) + '\n', 0o600);
        // a configured tunnel that is not up (the boot step could not reach the server yet): try once more
        const t = readTunnel();
        if (t && !interfacePresent()) {
          try {
            await tunnelUp(t, log);
          } catch (e) {
            log(`tunnel still down: ${(e as Error).message}`);
          }
        }
        break;
      }
      case 'tunnel-set': {
        const text = await readConfigFromFifo(files.fifo);
        const cfg = parseWireguardConfig(text);
        const t = tunnelFileOf(cfg);
        writeRootFile(EGRESS_ROOT_FILES.tunnelConf, wgSetconfText(cfg), 0o600);
        writeRootFile(EGRESS_ROOT_FILES.tunnelJson, JSON.stringify(t) + '\n', 0o600);
        // all or nothing: a tunnel whose rules did not load is taken down again (the daemon records nothing)
        try {
          await tunnelUp(t, log);
          await loadRules(readState(), log);
        } catch (e) {
          await deleteInterface();
          rmSync(EGRESS_ROOT_FILES.tunnelConf, { force: true });
          rmSync(EGRESS_ROOT_FILES.tunnelJson, { force: true });
          await loadRules(readState(), log).catch((re: Error) => log(`could not reload the rules without the tunnel: ${re.message}`));
          throw e;
        }
        break;
      }
      case 'tunnel-remove': {
        await deleteInterface();
        rmSync(EGRESS_ROOT_FILES.tunnelConf, { force: true });
        rmSync(EGRESS_ROOT_FILES.tunnelJson, { force: true });
        await loadRules(readState(), log);
        log('tunnel removed; apps that use the VPN have no internet until one is set again');
        break;
      }
      case 'status':
        break;
    }
    writeStatus(config.stateDir, files.status, { action, state: 'ok', message: `${action} done`, report: await report(), at: now() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeStatus(config.stateDir, files.status, { action, state: 'failed', message: msg, ...(e instanceof HarborError && e.nextAction ? { nextAction: e.nextAction } : {}), at: now() });
    throw e;
  }
}

// harbor-egress.service, after `nft -f rules.nft` loaded the firewall: Harbor's routing rules (kernel state that
// a reboot forgets). The firewall alone already refuses everything a VPN app sends outside the tunnel.
export async function egressBoot(log: Log): Promise<void> {
  requireRoot('egress-boot');
  if (!existsSync(EGRESS_ROOT_FILES.rules)) return;
  const t = readTunnel();
  await setRouting(t?.dnsServer ?? null, log);
}

// harbor-vpn.service (after the network is online, retried by systemd until it works): bring the tunnel up.
export async function egressTunnelUp(log: Log): Promise<void> {
  requireRoot('egress-tunnel-up');
  const t = readTunnel();
  if (!t) return;
  if (interfacePresent()) {
    const peers = await exec(WG_BIN, ['show', TUNNEL_IF, 'peers'], { timeoutMs: 15_000 });
    if (peers.code === 0 && peers.stdout.trim()) {
      log(`${TUNNEL_IF} is already up`);
      return;
    }
  }
  await tunnelUp(t, log);
}

// Uninstall: everything Harbor added to the host's networking, and its root files.
export async function removeEgress(log: Log): Promise<void> {
  await deleteInterface().catch(() => undefined);
  if (existsSync(NFT_BIN) && (await tableLoaded().catch(() => false))) await nftLoad(nftDeleteScript()).catch(() => undefined);
  if (existsSync(IP_BIN)) await clearRouting().catch(() => undefined);
  rmSync(EGRESS_ROOT_DIR, { recursive: true, force: true });
  log('removed Harbor\'s VPN tunnel, firewall table and routing rules');
}

