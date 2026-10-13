import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { compareVersions } from '../packages/versions.js';
import { RELEASE_KEYS, type ReleaseKey } from '../release-keys.js';
import { checkSignature, MAX_SIGNATURE_BYTES, signatureProblem } from '../signing.js';
import { archiveName } from '../system/selfupdate.js';
import { exec, execOk } from './exec.js';

// The root half of a self-update (run by harbor-self-update@<version>.service). It trusts nothing the
// unprivileged daemon wrote: it downloads SHA256SUMS, SHA256SUMS.sig and the archive from the GitHub release
// itself, checks the signature with the pinned release keys BEFORE it trusts the checksums (decision 168),
// verifies the archive, extracts, and runs the new release's own `bootstrap --yes` (the documented in-place
// upgrade). Progress goes to <state>/updates/status.json for the console, which reconnects after the restart.
//
// Never a downgrade (decision 168): a target older than the running release is refused unless root passes
// --allow-downgrade by hand. The unit the console starts (polkit) cannot pass it: its ExecStart is
// `apply --to %i`, and the CLI refuses every --allow-* flag inside that unit (HARBOR_SELF_UPDATE_UNIT=1).
// --allow-unsigned (root, by hand) only accepts a MISSING signature (a local dev archive, or a release older
// than 0.32.0, the first signed one); a signature that does not verify is always refused.
//
// Rollback (decision 101): before touching /opt/harbor, the current release tree is snapshotted to
// /root/harbor-updates/previous/ (release.json proves it is a Harbor release). After bootstrap, the
// daemon is polled at /healthz; on failure the snapshot is restored and bootstrap re-runs from it,
// so the console comes back on the previous version with state untouched (migrations only ever add
// tables/columns, so a newer-then-older DB open is safe). The outcome lands in updates/status.json
// either way, and `harbor self-update apply --to <previous> --allow-downgrade` stays the documented manual downgrade.
const WORK = '/root/harbor-updates';
const PREVIOUS_DIR = '/root/harbor-updates/previous';
export const SUMS_FILE = 'SHA256SUMS';
export const SUMS_SIG_FILE = 'SHA256SUMS.sig';
// the first Harbor release published with SHA256SUMS.sig
export const FIRST_SIGNED_RELEASE = '0.32.0';
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

type State = 'requested' | 'downloading' | 'installing' | 'succeeded' | 'failed' | 'rolled-back';
function writeStatus(version: string, state: State, message: string): void {
  const file = path.join(PRODUCT.paths.var, 'updates', 'status.json');
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    writeFileSync(file, JSON.stringify({ version, state, message, at: new Date().toISOString() }), { mode: 0o644 });
  } catch {
    /* status is best effort */
  }
}

// null: the file is not there (HTTP 404); only --allow-unsigned accepts that, and only for the signature.
async function download(url: string, maxBytes: number): Promise<Buffer | null> {
  const res = await fetch(url, { headers: { 'user-agent': 'harbor-self-update' }, redirect: 'follow' });
  if (res.status === 404) return null;
  if (!res.ok) throw new HarborError('OPERATION_FAILED', `download of ${url} failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new HarborError('OPERATION_FAILED', `${url} is larger than ${maxBytes} bytes`);
  return bytes;
}

export interface ApplyOptions {
  // the release running now (the CLI passes its own version); the downgrade check compares with it
  running: string;
  // root only, typed by hand: install a release older than the running one
  allowDowngrade?: boolean;
  // root only, typed by hand: accept a release (or local archive) WITHOUT SHA256SUMS.sig; a bad signature still fails
  allowUnsigned?: boolean;
  // tests: throwaway keys instead of the pinned ones
  keys?: readonly ReleaseKey[];
}

// The command that installs a given release by hand when it is older than what runs (a downgrade on purpose).
export function manualInstallCommand(version: string): string {
  const unsigned = RELEASE_VERSION.test(version) && compareVersions(version, FIRST_SIGNED_RELEASE) < 0 ? ' --allow-unsigned' : '';
  return `sudo /opt/harbor/bin/harbor self-update apply --to ${version} --allow-downgrade${unsigned}`;
}

// Refuse a target older than the running release unless root asked for it by hand. The same version is fine (a repair).
export function checkTargetVersion(version: string, running: string, allowDowngrade: boolean): void {
  if (!RELEASE_VERSION.test(version)) throw new HarborError('INVALID_REQUEST', `not a release version: ${version}`);
  if (compareVersions(version, running) >= 0 || allowDowngrade) return;
  throw new HarborError('INVALID_REQUEST', `Harbor ${version} is older than the running ${running}; self-update never downgrades`, {
    nextAction: `To go back on purpose, run on the machine: ${manualInstallCommand(version)}`,
  });
}

// Signature first (SHA256SUMS is only trusted once a pinned key verifies its exact bytes), then the archive
// checksum. Returns the archive's sha256 and the key that signed (null: accepted unsigned with --allow-unsigned).
export function verifyReleaseFiles(input: { version: string; name: string; archive: Buffer; sums: Buffer; sig: Buffer | null }, opts: { allowUnsigned?: boolean; keys?: readonly ReleaseKey[] } = {}): { sha256: string; signedBy: string | null } {
  const keys = opts.keys ?? RELEASE_KEYS;
  const verdict = checkSignature(input.sums, input.sig, keys);
  let signedBy: string | null = null;
  if (verdict.ok) signedBy = verdict.keyId;
  else if (!(verdict.reason === 'missing' && opts.allowUnsigned)) {
    const nextAction =
      verdict.reason !== 'missing'
        ? 'Nothing was changed. Do not install this release; report it to the Harbor maintainers.'
        : compareVersions(input.version, FIRST_SIGNED_RELEASE) < 0
          ? `Harbor releases before ${FIRST_SIGNED_RELEASE} are not signed. To install one on purpose, run on the machine: ${manualInstallCommand(input.version)}`
          : `Nothing was changed. Every release Harbor's CI publishes carries ${SUMS_SIG_FILE}. For an archive you built yourself, run the apply step by hand as root with --allow-unsigned.`;
    throw new HarborError('OPERATION_FAILED', `refusing Harbor ${input.version}: ${signatureProblem(`${SUMS_FILE} of Harbor ${input.version}`, SUMS_SIG_FILE, verdict.reason, keys)}`, { nextAction });
  }
  const expected = input.sums
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find((parts) => parts[1] === input.name)?.[0];
  if (!expected) throw new HarborError('OPERATION_FAILED', `${SUMS_FILE} of release ${input.version} does not list ${input.name}`);
  const actual = createHash('sha256').update(input.archive).digest('hex');
  if (actual !== expected) throw new HarborError('OPERATION_FAILED', `checksum mismatch for ${input.name}: expected ${expected}, got ${actual}`);
  return { sha256: actual, signedBy };
}

// The CLI's --allow-* flags are for root at a terminal. Inside harbor-self-update@.service (the unit the
// console starts through polkit) they are refused, whatever the instance name carries.
export function refuseFlagsInUnit(env: Record<string, string | undefined>, flags: { allowDowngrade?: boolean; allowUnsigned?: boolean }): void {
  if (env.HARBOR_SELF_UPDATE_UNIT !== '1') return;
  const used = [flags.allowDowngrade ? '--allow-downgrade' : null, flags.allowUnsigned ? '--allow-unsigned' : null].filter(Boolean);
  if (used.length) throw new HarborError('INVALID_REQUEST', `${used.join(' and ')} cannot be used by the update the console starts`, { nextAction: 'Run the apply step by hand as root on the machine.' });
}

export async function applySelfUpdate(version: string, repo: string, log: (m: string) => void, local: { archive: string; sums: string; sig: string } | undefined, opts: ApplyOptions): Promise<void> {
  if (!RELEASE_VERSION.test(version)) throw new HarborError('INVALID_REQUEST', `not a release version: ${version}`);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', 'self-update apply must run as root (it is started by harbor-self-update@.service)');
  checkTargetVersion(version, opts.running, Boolean(opts.allowDowngrade));
  if (compareVersions(version, opts.running) < 0) log(`--allow-downgrade: installing ${version} over the running ${opts.running}`);
  const name = archiveName(version);
  const base = `https://github.com/${repo}/releases/download/v${version}`;
  mkdirSync(WORK, { recursive: true, mode: 0o700 });
  const archive = path.join(WORK, name);
  try {
    let files: { archive: Buffer; sums: Buffer; sig: Buffer | null };
    if (local) {
      writeStatus(version, 'downloading', `using local archive ${local.archive}`);
      if (!existsSync(local.sums)) throw new HarborError('INVALID_REQUEST', `${SUMS_FILE} must sit next to ${local.archive}`);
      files = { archive: readFileSync(local.archive), sums: readFileSync(local.sums), sig: existsSync(local.sig) ? readFileSync(local.sig) : null };
    } else {
      writeStatus(version, 'downloading', `downloading ${name} from GitHub`);
      const sums = await download(`${base}/${SUMS_FILE}`, 64 * 1024);
      if (!sums) throw new HarborError('OPERATION_FAILED', `release ${version} has no ${SUMS_FILE} (HTTP 404)`);
      const sig = await download(`${base}/${SUMS_SIG_FILE}`, MAX_SIGNATURE_BYTES);
      log(`downloading ${base}/${name}`);
      const bytes = await download(`${base}/${name}`, 400 * 1024 * 1024);
      if (!bytes) throw new HarborError('OPERATION_FAILED', `release ${version} has no ${name} (HTTP 404)`);
      files = { archive: bytes, sums, sig };
    }
    const checked = verifyReleaseFiles({ version, name, ...files }, { ...(opts.allowUnsigned ? { allowUnsigned: true } : {}), ...(opts.keys ? { keys: opts.keys } : {}) });
    if (checked.signedBy) log(`signature verified (${SUMS_SIG_FILE}, key ${checked.signedBy})`);
    else log(`WARNING: --allow-unsigned: ${SUMS_FILE} of ${version} carries no signature; installing it on root's word`);
    log(`checksum verified (${checked.sha256.slice(0, 16)}…)`);
    writeFileSync(archive, files.archive, { mode: 0o600 });
    const dir = path.join(WORK, name.replace(/\.tar\.gz$/, ''));
    rmSync(dir, { recursive: true, force: true });
    await execOk('/usr/bin/tar', ['-xzf', archive, '-C', WORK], { timeoutMs: 300_000 });
    if (!existsSync(path.join(dir, 'bin', 'harbor'))) throw new HarborError('OPERATION_FAILED', `archive did not extract to ${dir}`);
    // Snapshot the running release before touching it: the rollback source.
    // Only Harbor releases qualify (release.json marker); anything else is
    // refused rather than snapshotted, same as bootstrap's foreign-dir rule.
    snapshotPreviousRelease(log);
    const previousVersion = readPreviousVersion();
    const restore = manualInstallCommand(previousVersion ?? '<previous version>');
    writeStatus(version, 'installing', `installing release ${version} (the daemon restarts)`);
    log(`running ${dir}/bin/harbor bootstrap --yes`);
    const r = await exec(path.join(dir, 'bin', 'harbor'), ['bootstrap', '--yes'], { timeoutMs: 25 * 60_000 });
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout).trim().split('\n').slice(-5).join(' | ');
      log(`bootstrap of ${version} failed (exit ${r.code}): ${detail}; rolling back to ${previousVersion ?? 'the previous release'}`);
      await rollbackToPrevious(log);
      const healthy = await waitHealthy(60_000, log);
      if (healthy) {
        writeStatus(version, 'rolled-back', `update to ${version} failed (${detail}); restored ${previousVersion ?? 'the previous release'} and the console is back`);
        log(`rolled back to ${previousVersion ?? 'previous release'}; console is back`);
        return;
      }
      writeStatus(version, 'failed', `update to ${version} failed (${detail}) and the rollback did not restore the console; run: ${restore}`);
      throw new HarborError('OPERATION_FAILED', `bootstrap of ${version} failed (exit ${r.code}): ${detail}`, {
        nextAction: `The rollback did not restore the console. On the machine, run: ${restore}`,
      });
    }
    // Bootstrap exited 0 but the daemon may still be down (bad binary, broken
    // unit): poll /healthz and roll back the same way instead of declaring success.
    const healthy = await waitHealthy(60_000, log);
    if (!healthy) {
      log(`daemon did not become healthy after installing ${version}; rolling back to ${previousVersion ?? 'the previous release'}`);
      await rollbackToPrevious(log);
      const back = await waitHealthy(60_000, log);
      if (back) {
        writeStatus(version, 'rolled-back', `update to ${version} installed but the console never came back; restored ${previousVersion ?? 'the previous release'}`);
        log(`rolled back to ${previousVersion ?? 'previous release'}; console is back`);
        return;
      }
      writeStatus(version, 'failed', `update to ${version} installed but the console never came back, and the rollback did not restore it; run: ${restore}`);
      throw new HarborError('OPERATION_FAILED', `daemon did not become healthy after installing ${version}`, {
        nextAction: `On the machine, run: ${restore}`,
      });
    }
    writeStatus(version, 'succeeded', `Harbor ${version} installed`);
    log(`done: Harbor ${version}`);
    rmSync(archive, { force: true });
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeStatus(version, 'failed', msg);
    log(`failed: ${msg}`);
    throw e;
  }
}

// ---- rollback helpers (pure filesystem + health poll; unit-testable) ----

// Copy the running /opt/harbor tree aside before an update touches it.
// Throws (aborting the update) when /opt/harbor is not a Harbor release —
// rolling back to a foreign tree would be worse than refusing.
export function snapshotPreviousRelease(log: (m: string) => void = () => {}): void {
  const marker = path.join(PRODUCT.paths.opt, 'release.json');
  if (!existsSync(marker)) throw new HarborError('OWNERSHIP_CONFLICT', `${PRODUCT.paths.opt} is not a Harbor release (no release.json)`, { nextAction: 'Move or remove that directory manually; self-update never overwrites unrelated files.' });
  rmSync(PREVIOUS_DIR, { recursive: true, force: true });
  mkdirSync(path.dirname(PREVIOUS_DIR), { recursive: true, mode: 0o700 });
  cpSync(PRODUCT.paths.opt, PREVIOUS_DIR, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  log(`snapshotted the running release to ${PREVIOUS_DIR}`);
}

export function readPreviousVersion(): string | null {
  try {
    const m = JSON.parse(readFileSync(path.join(PREVIOUS_DIR, 'release.json'), 'utf8')) as { version?: string };
    return typeof m.version === 'string' ? m.version : null;
  } catch {
    return null;
  }
}

// Restore the snapshot over /opt/harbor and re-run its bootstrap so the unit
// points at the previous release again. State (/var/lib/harbor) is untouched:
// migrations only add tables/columns, so the older binary opens the newer DB.
// Async: re-running bootstrap restarts the daemon from the restored tree.
async function rollbackToPrevious(log: (m: string) => void): Promise<void> {
  if (!existsSync(path.join(PREVIOUS_DIR, 'bin', 'harbor'))) throw new HarborError('OPERATION_FAILED', `no previous release snapshot at ${PREVIOUS_DIR}`, { nextAction: 'Reinstall Harbor from the release archive manually.' });
  rmSync(PRODUCT.paths.opt, { recursive: true, force: true });
  cpSync(PREVIOUS_DIR, PRODUCT.paths.opt, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  log(`restored ${PRODUCT.paths.opt} from the previous release`);
  log(`re-running the previous release's bootstrap`);
  const r = await exec(path.join(PRODUCT.paths.opt, 'bin', 'harbor'), ['bootstrap', '--yes'], { timeoutMs: 25 * 60_000 });
  if (r.code !== 0) log(`previous release bootstrap exited ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  else log(`previous release bootstrap done`);
}

async function waitHealthy(timeoutMs: number, log: (m: string) => void): Promise<boolean> {
  // The management port lives in /etc/harbor/harbor.json; fall back to the default.
  let port: number = PRODUCT.defaults.managementPort;
  try {
    const raw = JSON.parse(readFileSync(`${PRODUCT.paths.etc}/harbor.json`, 'utf8')) as { listen?: { port?: number } };
    if (typeof raw.listen?.port === 'number') port = raw.listen.port;
  } catch {
    /* default */
  }
  const url = `http://localhost:${port}/healthz`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log(`daemon did not become healthy at ${url}`);
  return false;
}
