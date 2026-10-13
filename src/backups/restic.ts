// restic / rclone command building and output parsing for Harbor backups (decision 149).
// PURE: no I/O, no spawn. The root step (src/bootstrap/backup-apply.ts) runs what this builds;
// tests pin the exact argv/env. Secrets only ever go into `env` or private files, never argv
// (argv is world-readable through /proc/<pid>/cmdline).
import { createHash } from 'node:crypto';
import { HarborError } from '../errors.js';
import type { BackupTransport } from '../contracts/backup-target.schema.js';

export const BACKUP_TOOLS_DIR = '/usr/local/lib/harbor/bin';
export const RESTIC_BIN = `${BACKUP_TOOLS_DIR}/restic`;
export const RCLONE_BIN = `${BACKUP_TOOLS_DIR}/rclone`;
export const RESTIC_CACHE_DIR = '/var/cache/harbor/restic';
// Pinned upstream releases (sha256 of the downloaded asset, from the release's SHA256SUMS).
export const BACKUP_TOOLS = {
  restic: { version: '0.19.1', url: 'https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_amd64.bz2', sha256: 'f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c', format: 'bz2' },
  rclone: { version: '1.75.2', url: 'https://github.com/rclone/rclone/releases/download/v1.75.2/rclone-v1.75.2-linux-amd64.zip', sha256: '349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702', format: 'zip' },
} as const;

// Every snapshot carries these tags (comma-free values; restic treats ',' as AND in filters).
export const SNAPSHOT_HOST = 'harbor';
export type PassKind = 'warm' | 'cold';
export function snapshotTags(t: { instanceId: string; runId: string; packageId: string; installationId: string; kind: PassKind }): string[] {
  return [`app:${t.instanceId}`, `run:${t.runId}`, `pkg:${t.packageId}`, `harbor:${t.installationId}`, `kind:${t.kind}`];
}
export function tagValue(tags: string[], key: string): string | null {
  const t = tags.find((x) => x.startsWith(`${key}:`));
  return t ? t.slice(key.length + 1) : null;
}

// What the root step needs to reach one target: the installed package's transport and the operator's
// non-secret answers. Secrets come separately (FIFO) and are merged only inside the root step.
export interface TargetRuntime {
  id: string; // installed target id (uuid)
  transport: BackupTransport;
  backend?: string; // rclone backend
  config: Record<string, string>;
  fields: { id: string; rclone?: string; obscure?: boolean; secret?: boolean }[];
}

export interface RepoAccess {
  // restic environment: RESTIC_REPOSITORY, credentials, cache dir. Secret values live here only.
  env: Record<string, string>;
  // restic `-o` options (no secrets)
  options: string[];
  // private files the root step writes (0600) into its tmpfs run dir before running restic
  files: { path: string; content: string }[];
}

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[[0-9a-fA-F:]+\]$/;
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,62}$/;
const RCLONE_REMOTE = 'hb';

function cleanRemotePath(p: string | undefined, what: string): string {
  const v = (p ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (v.split('/').some((s) => s === '..' || s === '.')) throw new HarborError('INVALID_REQUEST', `${what} must not contain . or .. segments`);
  if (/[\s\\]/.test(v)) throw new HarborError('INVALID_REQUEST', `${what} must not contain spaces or backslashes`);
  return v;
}

// A local target folder: a mounted disk, never the system disk's own tree outside Harbor's backups folder.
export function isAllowedLocalTarget(p: string): boolean {
  if (!p.startsWith('/') || p.includes('\0') || p.endsWith('/') || p.split('/').some((s) => s === '..' || s === '.')) return false;
  if (p.includes('/harbor-apps/') || p.endsWith('/harbor-apps')) return false; // never inside an app home tree
  return ['/mnt/', '/media/', '/srv/harbor/backups/'].some((r) => p.startsWith(r)) || p === '/srv/harbor/backups';
}

export function repoAccess(t: TargetRuntime, secrets: Record<string, string>, dirs: { run: string; rcloneConf: string }): RepoAccess {
  const c = t.config;
  const env: Record<string, string> = { RESTIC_CACHE_DIR, RESTIC_PROGRESS_FPS: '0.5' };
  const options: string[] = [];
  const files: { path: string; content: string }[] = [];
  switch (t.transport) {
    case 'local': {
      const p = c['path'] ?? '';
      if (!isAllowedLocalTarget(p)) throw new HarborError('INVALID_REQUEST', `${p} is not a folder Harbor may back up into`, { nextAction: 'Pick a folder on a mounted drive (/mnt/… or /media/…), outside any harbor-apps folder.' });
      env['RESTIC_REPOSITORY'] = p;
      break;
    }
    case 's3': {
      let endpoint = (c['endpoint'] ?? '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(endpoint)) endpoint = `https://${endpoint}`;
      const host = endpoint.replace(/^https?:\/\//, '');
      if (!HOST_RE.test(host.replace(/:[0-9]{1,5}$/, ''))) throw new HarborError('INVALID_REQUEST', `endpoint ${c['endpoint']} is not a host name`);
      const bucket = (c['bucket'] ?? '').trim();
      if (!BUCKET_RE.test(bucket)) throw new HarborError('INVALID_REQUEST', `bucket ${bucket} is not a valid bucket name`);
      const sub = cleanRemotePath(c['path'], 'Folder in the bucket');
      env['RESTIC_REPOSITORY'] = `s3:${endpoint}/${bucket}${sub ? `/${sub}` : ''}`;
      env['AWS_ACCESS_KEY_ID'] = c['accessKeyId'] ?? '';
      env['AWS_SECRET_ACCESS_KEY'] = secrets['secretAccessKey'] ?? '';
      if (c['region']) env['AWS_DEFAULT_REGION'] = c['region'];
      break;
    }
    case 'sftp': {
      const host = (c['host'] ?? '').trim();
      const user = (c['user'] ?? '').trim();
      const port = c['port'] ? Number(c['port']) : 22;
      if (!HOST_RE.test(host)) throw new HarborError('INVALID_REQUEST', `${host} is not a host name or address`);
      if (!USER_RE.test(user)) throw new HarborError('INVALID_REQUEST', `${user} is not a valid user name`);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HarborError('INVALID_REQUEST', `port ${c['port']} is out of range`);
      const remote = (c['path'] ?? '').trim();
      if (!remote.startsWith('/') || remote.split('/').some((s) => s === '..') || /[\s\\]/.test(remote)) throw new HarborError('INVALID_REQUEST', 'Folder on the server must be an absolute path without spaces');
      const key = `${dirs.run}/id_target`;
      const known = `${dirs.run}/known_hosts`;
      const pk = secrets['privateKey'] ?? '';
      files.push({ path: key, content: pk.endsWith('\n') ? pk : `${pk}\n` });
      files.push({ path: known, content: knownHostsFor(host, port, c['hostKey'] ?? '') });
      env['RESTIC_REPOSITORY'] = `sftp:${user}@${host}:${remote}`;
      options.push('-o', `sftp.command=${sshCommand({ host, port, user, key, known }).join(' ')}`);
      break;
    }
    case 'rest': {
      const url = (c['url'] ?? '').trim();
      if (!/^https:\/\/[^\s@/]+(\/[^\s@]*)?$/.test(url)) throw new HarborError('INVALID_REQUEST', 'the REST server address must be https://host[:port]/path without credentials');
      env['RESTIC_REPOSITORY'] = `rest:${url}`;
      if (c['username']) env['RESTIC_REST_USERNAME'] = c['username'];
      if (secrets['password']) env['RESTIC_REST_PASSWORD'] = secrets['password'];
      break;
    }
    case 'rclone': {
      const sub = cleanRemotePath(c['path'], 'Folder');
      env['RESTIC_REPOSITORY'] = `rclone:${RCLONE_REMOTE}:${sub}`;
      env['RCLONE_CONFIG'] = dirs.rcloneConf;
      options.push('-o', `rclone.program=${RCLONE_BIN}`);
      break;
    }
  }
  return { env, options, files };
}

// ssh for restic's sftp backend: Harbor's own key, the pinned server key, never an agent or a prompt.
export function sshCommand(o: { host: string; port: number; user: string; key: string; known: string }): string[] {
  return ['ssh', '-i', o.key, '-p', String(o.port), '-o', `UserKnownHostsFile=${o.known}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30', `${o.user}@${o.host}`, '-s', 'sftp'];
}

// Where the key type sits in a known_hosts / ssh-keyscan line ("host type base64" or "type base64"): the first
// token that names an SSH key algorithm AND is followed by a base64 blob. A host name like `ssh-nas.lan` or
// `ssh-nas` comes first in the line and is not followed by base64, so it is never taken for the type.
const KEY_TYPE_RE = /^(?:ssh-[a-z0-9]+|ecdsa-sha2-[a-z0-9]+|sk-[a-z0-9-]+@openssh\.com)(?:-cert-v01@openssh\.com)?$/;
const KEY_BLOB_RE = /^[A-Za-z0-9+/]+=*$/;
function keyTypeAt(parts: string[]): number {
  return parts.findIndex((p, i) => KEY_TYPE_RE.test(p) && KEY_BLOB_RE.test(parts[i + 1] ?? ''));
}

// known_hosts lines for the pinned key(s). Accepts what ssh-keyscan prints ("host type key") or bare
// "type key" lines; re-keys every line to the host[:port] ssh will look up.
export function knownHostsFor(host: string, port: number, hostKey: string): string {
  const name = port === 22 ? host : `[${host}]:${port}`;
  const lines: string[] = [];
  for (const raw of hostKey.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const parts = l.split(/\s+/);
    const at = keyTypeAt(parts);
    if (at < 0) continue;
    lines.push(`${name} ${parts[at]} ${parts[at + 1]}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// Decision 169: no trust on first use. A server key is pinned only once the operator confirmed it, by pasting
// the key itself or by confirming its SHA256 fingerprint (the form `ssh-keygen -lf` prints) that Harbor shows.
export const HOST_KEY_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
export interface ScannedHostKey {
  type: string; // ssh-ed25519, ecdsa-sha2-nistp256, ssh-rsa, …
  fingerprint: string; // SHA256:…
  line: string; // "type base64", what knownHostsFor() accepts
}
export function isHostKeyFingerprint(s: string): boolean {
  return HOST_KEY_FINGERPRINT_RE.test(s.trim().replace(/=+$/, ''));
}
export function hostKeyFingerprint(base64Blob: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(base64Blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
}
const KEY_ORDER = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'];
// What ssh-keyscan printed, one entry per key, strongest first (ed25519, then ECDSA, then RSA).
export function parseScannedHostKeys(text: string): ScannedHostKey[] {
  const out: ScannedHostKey[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const parts = l.split(/\s+/);
    const at = keyTypeAt(parts);
    const blob = at >= 0 ? parts[at + 1] : undefined;
    if (!blob) continue;
    if (out.some((k) => k.line === `${parts[at]} ${blob}`)) continue;
    out.push({ type: parts[at]!, fingerprint: hostKeyFingerprint(blob), line: `${parts[at]} ${blob}` });
  }
  const rank = (t: string) => (KEY_ORDER.includes(t) ? KEY_ORDER.indexOf(t) : KEY_ORDER.length);
  return out.sort((a, b) => rank(a.type) - rank(b.type));
}
export function hostKeyLabel(type: string): string {
  return type === 'ssh-ed25519' ? 'ED25519' : type.startsWith('ecdsa-') ? 'ECDSA' : type === 'ssh-rsa' ? 'RSA' : type;
}

/**
 * The key lines to pin, given what the operator typed into Server key (empty, or a SHA256 fingerprint) and what
 * the server showed. Empty: nothing is pinned, the error carries the fingerprints for the operator to confirm.
 * A fingerprint: the matching key is pinned, or the error says the server shows another one. The error is
 * HOST_KEY_UNCONFIRMED with `details` = the fingerprints the server showed, strongest first.
 */
export function confirmHostKey(given: string, scannedText: string, where: string): string {
  const keys = parseScannedHostKeys(scannedText);
  if (!keys.length) throw new HarborError('OPERATION_FAILED', `cannot read the server key of ${where}`, { nextAction: 'Check the server name and port, and that SSH answers there.' });
  const want = given.trim().replace(/=+$/, '');
  const shown = `${keys[0]!.fingerprint} (${hostKeyLabel(keys[0]!.type)})`;
  const details = keys.map((k) => k.fingerprint);
  if (!want) {
    throw Object.assign(
      new HarborError('HOST_KEY_UNCONFIRMED', `Harbor has not talked to ${where} before. Its server key is ${shown}`, {
        nextAction: 'Check that the server shows the same fingerprint (on the server: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub), then trust it.',
        details,
      }),
      { backupCode: 'host-key-unconfirmed' as const },
    );
  }
  const match = keys.filter((k) => k.fingerprint === want);
  if (!match.length) {
    throw Object.assign(
      new HarborError('HOST_KEY_UNCONFIRMED', `${where} shows a different server key than the one you confirmed: it shows ${shown}`, {
        nextAction: 'The server may have been reinstalled, or someone is in between. Check the key on the server itself before you trust the new one.',
        details,
      }),
      { backupCode: 'host-key-unconfirmed' as const },
    );
  }
  return match.map((k) => k.line).join('\n');
}

// rclone.conf for one target (written by the root step; rclone adds its session tokens to it later).
// `obscured` holds the already-obscured values for fields marked obscure (rclone obscure, run first).
export function rcloneConfig(t: TargetRuntime, secrets: Record<string, string>, obscured: Record<string, string>): string {
  if (t.transport !== 'rclone' || !t.backend) throw new HarborError('INVALID_REQUEST', 'not an rclone target');
  const lines = [`[${RCLONE_REMOTE}]`, `type = ${t.backend}`];
  for (const f of t.fields) {
    if (!f.rclone) continue;
    const v = f.obscure ? obscured[f.id] : (secrets[f.id] ?? t.config[f.id]);
    if (v === undefined || v === '') continue;
    if (/[\r\n]/.test(v)) throw new HarborError('INVALID_REQUEST', `${f.id} must be one line`);
    lines.push(`${f.rclone} = ${v}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- argv

export function backupArgs(o: { paths: string[]; tags: string[]; excludes: string[] }): string[] {
  return ['backup', '--json', '--host', SNAPSHOT_HOST, ...o.tags.flatMap((t) => ['--tag', t]), ...o.excludes.flatMap((e) => ['--exclude', e]), ...o.paths];
}
// Listing is read-only: --no-lock, so a prune elsewhere (another Harbor sharing the place) never blocks it.
export function snapshotsArgs(filterTags?: string): string[] {
  return ['--no-lock', 'snapshots', '--json', ...(filterTags ? ['--tag', filterTags] : [])];
}
// `<id>:<subfolder>` restores that folder's CONTENTS into target (restic ≥ 0.17), so a home's
// volumes/ lands directly inside the new sealed volumes/ — never in a plaintext staging dir.
export function restoreArgs(snapshotId: string, subfolder: string, target: string): string[] {
  if (!/^[0-9a-f]{8,64}$/.test(snapshotId)) throw new HarborError('INVALID_REQUEST', `invalid snapshot id ${snapshotId}`);
  if (!subfolder.startsWith('/') || subfolder.includes('\0') || subfolder.split('/').some((s) => s === '..')) throw new HarborError('INVALID_REQUEST', `invalid snapshot folder ${subfolder}`);
  return ['restore', `${snapshotId}:${subfolder}`, '--target', target];
}
export interface Retention {
  daily: number;
  weekly: number;
  monthly: number;
}
export function forgetArgs(o: { instanceId?: string; snapshotIds?: string[]; retention?: Retention; prune: boolean }): string[] {
  const base = ['forget', '--json'];
  if (o.snapshotIds?.length) {
    for (const id of o.snapshotIds) if (!/^[0-9a-f]{8,64}$/.test(id)) throw new HarborError('INVALID_REQUEST', `invalid snapshot id ${id}`);
    return [...base, ...(o.prune ? ['--prune'] : []), ...o.snapshotIds];
  }
  if (!o.instanceId || !o.retention) throw new HarborError('INVALID_REQUEST', 'forget needs an app and a retention policy');
  const r = o.retention;
  return [...base, '--tag', `app:${o.instanceId},kind:cold`, '--group-by', '', '--keep-last', '1', '--keep-daily', String(r.daily), '--keep-weekly', String(r.weekly), '--keep-monthly', String(r.monthly), ...(o.prune ? ['--prune'] : [])];
}
export function checkArgs(subsetPercent: number): string[] {
  const p = Math.max(0, Math.min(100, Math.round(subsetPercent)));
  return p > 0 ? ['check', `--read-data-subset=${p}%`] : ['check'];
}
export const initArgs = (): string[] => ['init', '--json'];
export const catConfigArgs = (): string[] => ['--no-lock', 'cat', 'config'];
// Steps that take a repository lock wait a while for someone else's (another Harbor's backup or prune).
export const LOCKING_COMMANDS = new Set(['backup', 'forget', 'prune', 'check', 'restore', 'key']);
export function withLockWait(args: string[]): string[] {
  return LOCKING_COMMANDS.has(args[0] ?? '') ? ['--retry-lock', '5m', ...args] : args;
}
export const keyListArgs = (): string[] => ['key', 'list', '--json'];
export function keyAddArgs(newPasswordFile: string, label: string): string[] {
  if (!/^[a-z0-9-]{1,32}$/.test(label)) throw new HarborError('INVALID_REQUEST', `invalid key label ${label}`);
  return ['key', 'add', '--new-password-file', newPasswordFile, '--host', SNAPSHOT_HOST, '--user', label];
}
export function keyRemoveArgs(id: string): string[] {
  if (!/^[0-9a-f]{8,64}$/.test(id)) throw new HarborError('INVALID_REQUEST', `invalid key id ${id}`);
  return ['key', 'remove', id];
}
export const unlockArgs = (): string[] => ['unlock'];
export const pruneArgs = (): string[] => ['prune'];
export const statsArgs = (): string[] => ['stats', '--json', '--mode', 'raw-data'];

// Key labels in the repository (restic `--user`): which secret a key is, never the secret itself.
export const KEY_LABEL_BACKUP = 'harbor-backup-key';
export const cardKeyLabel = (issuedAt: string): string => `harbor-card-${issuedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;

// The Harbor recovery card as a restic password: normalized so a re-typed card always matches.
export function cardPassword(words: string): string {
  return words.normalize('NFKC').trim().toLowerCase().split(/\s+/).join(' ');
}

// ---------------------------------------------------------------- output

export type ResticExit = 'ok' | 'partial' | 'repo-missing' | 'wrong-password' | 'locked' | 'interrupted' | 'failed';
export function classifyExit(code: number | null): ResticExit {
  switch (code) {
    case 0: return 'ok';
    case 3: return 'partial'; // snapshot made, some files unreadable
    case 10: return 'repo-missing';
    case 11: return 'locked';
    case 12: return 'wrong-password';
    case 130: return 'interrupted';
    default: return 'failed';
  }
}

export interface BackupStatusLine {
  type: 'status';
  percent: number;
  bytesDone: number;
  totalBytes: number;
  filesDone: number;
  totalFiles: number;
}
export interface BackupSummary {
  type: 'summary';
  snapshotId: string;
  filesNew: number;
  filesChanged: number;
  filesUnmodified: number;
  dataAdded: number;
  dataAddedPacked: number;
  totalFiles: number;
  totalBytes: number;
  durationSeconds: number;
}
export type BackupLine = BackupStatusLine | BackupSummary | { type: 'error'; message: string } | null;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function parseBackupLine(line: string): BackupLine {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  switch (d['message_type']) {
    case 'status':
      return { type: 'status', percent: num(d['percent_done']), bytesDone: num(d['bytes_done']), totalBytes: num(d['total_bytes']), filesDone: num(d['files_done']), totalFiles: num(d['total_files']) };
    case 'summary':
      if (typeof d['snapshot_id'] !== 'string') return null;
      return {
        type: 'summary',
        snapshotId: d['snapshot_id'],
        filesNew: num(d['files_new']),
        filesChanged: num(d['files_changed']),
        filesUnmodified: num(d['files_unmodified']),
        dataAdded: num(d['data_added']),
        dataAddedPacked: num(d['data_added_packed']),
        totalFiles: num(d['total_files_processed']),
        totalBytes: num(d['total_bytes_processed']),
        durationSeconds: num(d['total_duration']),
      };
    case 'error': {
      const e = d['error'] as { message?: unknown } | undefined;
      const msg = typeof e?.message === 'string' ? e.message : typeof d['error'] === 'string' ? (d['error'] as string) : 'error';
      return { type: 'error', message: `${typeof d['item'] === 'string' ? `${d['item']}: ` : ''}${msg}` };
    }
    default:
      return null;
  }
}

export interface SnapshotInfo {
  id: string;
  shortId: string;
  time: string;
  paths: string[];
  tags: string[];
  hostname: string;
  totalBytes: number | null;
  dataAdded: number | null;
}
export function parseSnapshots(json: string): SnapshotInfo[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    throw new HarborError('OPERATION_FAILED', 'restic snapshots printed something that is not JSON');
  }
  if (!Array.isArray(arr)) return [];
  const out: SnapshotInfo[] = [];
  for (const s of arr as Record<string, unknown>[]) {
    if (!s || typeof s['id'] !== 'string' || typeof s['time'] !== 'string') continue;
    const summary = (s['summary'] ?? null) as Record<string, unknown> | null;
    out.push({
      id: s['id'],
      shortId: typeof s['short_id'] === 'string' ? s['short_id'] : s['id'].slice(0, 8),
      time: s['time'],
      paths: Array.isArray(s['paths']) ? (s['paths'] as unknown[]).filter((p): p is string => typeof p === 'string') : [],
      tags: Array.isArray(s['tags']) ? (s['tags'] as unknown[]).filter((p): p is string => typeof p === 'string') : [],
      hostname: typeof s['hostname'] === 'string' ? s['hostname'] : '',
      totalBytes: summary ? num(summary['total_bytes_processed']) : null,
      dataAdded: summary ? num(summary['data_added']) : null,
    });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

export interface RepoKey {
  id: string;
  current: boolean;
  label: string;
  created: string;
}
export function parseKeyList(json: string): RepoKey[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return (arr as Record<string, unknown>[])
    .filter((k) => k && typeof k['id'] === 'string')
    .map((k) => ({ id: k['id'] as string, current: k['current'] === true, label: typeof k['userName'] === 'string' ? (k['userName'] as string) : '', created: typeof k['created'] === 'string' ? (k['created'] as string) : '' }));
}
