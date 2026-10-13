import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeConfig } from '../../src/config.js';
import type { ContainerInfo, NetworkInfo, VolumeInfo } from '../../src/docker/adapter.js';
import { FakeDocker } from '../../src/docker/fake.js';
import { FakeCaddyAdmin } from '../../src/exposure/caddy.js';
import { FakeTailscale } from '../../src/exposure/tailscale.js';
import { FakeVerifier } from '../../src/exposure/verify.js';
import { demoFetcher, demoRegistry, startDaemon, type Daemon } from '../../src/daemon.js';
import { FakeTransport } from '../../src/notify/notifier.js';
import { FakeGit } from '../../src/packages/git.js';
import { SCHEMA_VERSION } from '../../src/state/db.js';
import { FakeCryptoProvider } from '../../src/storage/crypto-provider.js';
import { FakeNet } from '../../src/system/net.js';
import { FakePower } from '../../src/system/power.js';
import { FakeReleaseFeed, FakeUnitStarter } from '../../src/system/selfupdate.js';
import type { AppearanceDto, ExposureDto, InstanceDetail, InstanceSummary, NotificationsDto, SystemDto } from '../../src/contracts/api.js';
import { bumpRevision, catalogFiles } from '../unit/bundle-helpers.js';
import { Api, freePort, MutableClock, REPO_CATALOG } from './harness.js';

// Upgrade jump: a state directory written by an OLD Harbor (tests/fixtures/state/<tag>/, made by
// scripts/make-state-fixture.mjs with that release's own code) opens and works with the current daemon.
// Real machines skip versions (production went 0.22.1 -> 0.25.0), so every migration step runs in one go here.

interface FixtureMeta {
  harborVersion: string;
  root: string;
  admin: { username: string; password: string };
  appPortRange: { from: number; to: number };
  sealedHomes: string[];
  instances: { id: string; name: string; packageId: string; revision: string; runtime: string; desired: string; endpoints: { id: string; hostPort: number }[] }[];
  exposures: ExposureDto[];
  notificationKinds: string[];
  emptyDirs: string[];
  docker: { containers: (ContainerInfo & { project: string; service: string; aliases?: Record<string, string[]>; env?: Record<string, string> })[]; volumes: VolumeInfo[]; networks: NetworkInfo[] };
}

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/state');
const RECOVERY = /ecoveryKey/;

// Every TEXT cell and every text file that names the generating machine's root gets the test's root instead:
// the fixture was written under one absolute path and the test runs under another (a real upgrade keeps its paths).
function relocate(dir: string, from: string, to: string): void {
  const db = new Database(path.join(dir, 'state', 'harbor.db'));
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name } of tables) {
      const cols = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string }[]).filter((c) => c.type.toUpperCase() === 'TEXT');
      for (const c of cols) db.prepare(`UPDATE "${name}" SET "${c.name}" = replace("${c.name}", ?, ?) WHERE instr("${c.name}", ?) > 0`).run(from, to, from);
    }
  } finally {
    db.close();
  }
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.startsWith('harbor.db')) {
        const text = readFileSync(p, 'utf8');
        if (text.includes(from)) writeFileSync(p, text.split(from).join(to));
      }
    }
  };
  walk(dir);
}

const sqlRows = <T>(file: string, sql: string): T[] => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
};

describe.each(['v0.22.1', 'v0.19.1'])('upgrade jump from Harbor %s state', (tag) => {
  const meta = JSON.parse(readFileSync(path.join(FIXTURES, tag, 'fixture.json'), 'utf8')) as FixtureMeta;
  let root = '';
  let stateDir = '';
  let daemon: Daemon | null = null;
  let fake: FakeDocker;
  let crypto: FakeCryptoProvider;
  let start: () => Promise<Daemon>;
  let api: Api;
  // what the old Harbor left, read before the current daemon touches the database
  let before: {
    userVersion: number;
    settings: Map<string, string>;
    portClaims: string[];
    endpoints: Map<string, string>;
    secrets: Map<string, string>;
    exposures: string[];
    words: string[];
  };
  const byName = async (name: string): Promise<InstanceSummary> => (await api.instances()).find((i) => i.name === name)!;
  const until = async (fn: () => Promise<boolean>, what: string, ms = 15_000): Promise<void> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'harbor-upgrade-'));
    stateDir = path.join(root, 'state');
    cpSync(path.join(FIXTURES, tag, 'state'), stateDir, { recursive: true });
    cpSync(path.join(FIXTURES, tag, 'data'), path.join(root, 'data'), { recursive: true });
    for (const d of meta.emptyDirs) mkdirSync(path.join(root, d), { recursive: true, mode: 0o700 });
    relocate(root, meta.root, root);
    const db = path.join(stateDir, 'harbor.db');
    const results = sqlRows<{ result_json: string | null }>(db, 'SELECT result_json FROM operations');
    before = {
      userVersion: (sqlRows<{ user_version: number }>(db, 'PRAGMA user_version')[0]!).user_version,
      settings: new Map(sqlRows<{ key: string; value_json: string }>(db, 'SELECT key, value_json FROM settings').map((r) => [r.key, r.value_json])),
      portClaims: sqlRows<{ row: string }>(db, "SELECT instance_id || ':' || endpoint_id || ':' || port AS row FROM port_claims ORDER BY port").map((r) => r.row),
      endpoints: new Map(sqlRows<{ id: string; endpoints_json: string }>(db, 'SELECT id, endpoints_json FROM instances').map((r) => [r.id, r.endpoints_json])),
      secrets: new Map(sqlRows<{ id: string; secrets_json: string }>(db, 'SELECT id, secrets_json FROM instances').map((r) => [r.id, r.secrets_json])),
      exposures: sqlRows<{ row: string }>(db, "SELECT id || ':' || instance_id || ':' || via || ':' || hostname || ':' || state AS row FROM exposures ORDER BY id").map((r) => r.row),
      words: results.flatMap((r) => {
        const o = r.result_json ? (JSON.parse(r.result_json) as Record<string, unknown>) : {};
        return [o['installationRecoveryKey'], o['recoveryKey']].filter((w): w is string => typeof w === 'string');
      }),
    };

    // The catalog this Harbor ships, with one installed app at a newer revision (an update to apply).
    const catalogDir = path.join(root, 'catalog');
    for (const [rel, body] of Object.entries(bumpRevision(catalogFiles(REPO_CATALOG), 'memos', '2'))) {
      mkdirSync(path.dirname(path.join(catalogDir, rel)), { recursive: true });
      writeFileSync(path.join(catalogDir, rel), body);
    }
    const port = await freePort();
    const config = normalizeConfig(
      { stateDir, catalogDir, userDataDir: path.join(root, 'data'), docker: { mode: 'fake' }, listen: { host: '127.0.0.1', port }, appPortRange: meta.appPortRange, planTtlSeconds: 900, sessionTtlSeconds: 3600, logLevel: 'error', catalog: { url: null } },
      root,
    );

    // The Docker engine outlives a Harbor upgrade: the same containers, volumes and networks (ids and labels) are
    // there when the new daemon starts. Running containers get their fake listeners back.
    const clock = new MutableClock();
    fake = new FakeDocker(clock);
    for (const v of meta.docker.volumes) fake.volumes.set(v.name, { ...v, labels: { ...v.labels } });
    for (const n of meta.docker.networks) fake.networks.set(n.id, { ...n, containerIds: [...n.containerIds] });
    for (const c of meta.docker.containers) fake.containers.set(c.id, { ...c, state: c.state === 'running' ? 'exited' : c.state, ports: c.ports.map((p) => ({ ...p })) });
    for (const c of meta.docker.containers) if (c.state === 'running') await fake.startContainer(c.id);
    // fscrypt policies live on disk and the kernel keeps its keys: an upgrade restarts Harbor, not the machine.
    crypto = new FakeCryptoProvider();
    for (const home of meta.sealedHomes.map((h) => h.split(meta.root).join(root))) {
      crypto.sealed.add(home);
      crypto.open.add(home);
    }
    const tailscale = new FakeTailscale();
    const caddy = new FakeCaddyAdmin();
    const verifier = new FakeVerifier();
    const fixed = {
      net: new FakeNet(),
      fetcher: demoFetcher(),
      power: new FakePower(),
      registry: demoRegistry(),
      releaseFeed: new FakeReleaseFeed(),
      unitStarter: new FakeUnitStarter(),
      notifyTransport: new FakeTransport(),
      git: new FakeGit(),
    };
    start = () => startDaemon(config, { docker: fake, compose: fake, clock, observerIntervalMs: 500, sourceCheckMs: 700, tailscale, caddy, verify: verifier.fn, crypto, ...fixed, toolsProbe: async () => ({ reachable: false, note: 'not probed in tests' }) });
    daemon = await start();
    api = new Api(`http://localhost:${port}`, null);
  });

  afterAll(async () => {
    await daemon?.close();
    await fake?.shutdown();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it(`the fixture really is ${tag} state`, () => {
    expect(meta.harborVersion).toBe(tag.slice(1));
    expect(before.userVersion).toBeLessThan(SCHEMA_VERSION);
    expect(before.words.length).toBeGreaterThan(0); // the old release stored the recovery words in the result
  });

  it('migrates to the current schema version, keeping every installation row', () => {
    const db = path.join(stateDir, 'harbor.db');
    expect(sqlRows<{ user_version: number }>(db, 'PRAGMA user_version')[0]!.user_version).toBe(SCHEMA_VERSION);
    expect(sqlRows<{ schema_version: number }>(db, 'SELECT schema_version FROM installation')).toHaveLength(1);
  });

  it('logs in with the administrator the old Harbor enrolled', async () => {
    await api.expectError(401, 'UNAUTHENTICATED', 'POST', '/v1/sessions', { username: meta.admin.username, password: 'not-the-password' }, { authorization: '' });
    api.token = (await api.login(meta.admin.username, meta.admin.password)).token;
    expect(api.token).toBeTruthy();
  });

  it('every instance keeps its id, package, revision, ports and state', async () => {
    const items = await api.instances();
    expect(items.map((i) => i.id).sort()).toEqual(meta.instances.map((i) => i.id).sort());
    for (const old of meta.instances) {
      const now = items.find((i) => i.id === old.id)!;
      expect(now).toMatchObject({ name: old.name, packageId: old.packageId, revision: old.revision, desired: old.desired });
      expect(now.endpoints.map((e) => ({ id: e.id, hostPort: e.hostPort }))).toEqual(old.endpoints);
    }
    // the apps that ran keep running (the observer re-reads the engine), the stopped one stays stopped
    await until(async () => (await api.instances()).filter((i) => ['excalidraw', 'memos'].includes(i.name)).every((i) => i.runtime === 'running' && i.readiness === 'healthy'), 'running apps healthy');
    expect(await byName('n8n')).toMatchObject({ desired: 'stopped', runtime: 'stopped', installState: 'installed' });
    expect((await byName('bentopdf')).installState).toBe('failed');
    const memos = await byName('memos');
    expect(memos.home).toMatchObject({ encrypted: true, state: 'unlocked', sealed: true });
    expect(memos.home!.path.startsWith(root)).toBe(true);
    const exca = await byName('excalidraw');
    expect(exca).toMatchObject({ displayName: 'Whiteboard', autoUpdate: true, customIcon: { kind: 'glyph', glyph: 'WB', color: '#336699' } });
    expect(memos.updateAvailable?.revision).toBe('2');
  });

  it('ports, endpoints, secrets, exposures and settings are the rows the old Harbor wrote', async () => {
    const db = path.join(stateDir, 'harbor.db');
    expect(sqlRows<{ row: string }>(db, "SELECT instance_id || ':' || endpoint_id || ':' || port AS row FROM port_claims ORDER BY port").map((r) => r.row)).toEqual(before.portClaims);
    for (const r of sqlRows<{ id: string; endpoints_json: string; secrets_json: string }>(db, 'SELECT id, endpoints_json, secrets_json FROM instances')) {
      expect(r.endpoints_json).toBe(before.endpoints.get(r.id));
      expect(r.secrets_json).toBe(before.secrets.get(r.id));
    }
    expect(sqlRows<{ row: string }>(db, "SELECT id || ':' || instance_id || ':' || via || ':' || hostname || ':' || state AS row FROM exposures ORDER BY id").map((r) => r.row)).toEqual(before.exposures);
    const after = new Map(sqlRows<{ key: string; value_json: string }>(db, 'SELECT key, value_json FROM settings').map((r) => [r.key, r.value_json]));
    for (const [key, value] of before.settings) if (key !== 'appearance.rotation.state') expect(after.get(key), key).toBe(value);

    // the same facts through the API
    const ex = (await api.expect<{ items: ExposureDto[] }>(200, 'GET', '/v1/exposures')).items;
    expect(ex.map((e) => ({ id: e.id, via: e.via, hostname: e.hostname, state: e.state })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      meta.exposures.map((e) => ({ id: e.id, via: e.via, hostname: e.hostname, state: e.state })).sort((a, b) => a.id.localeCompare(b.id)),
    );
    const n8n = await byName('n8n');
    const detail = await api.expect<InstanceDetail>(200, 'GET', `/v1/instances/${n8n.id}`);
    expect(JSON.stringify(detail)).not.toMatch(/fefefefe/); // secret values never reach a DTO
    for (const id of ['database-password', 'encryption-key']) expect(readFileSync(path.join(stateDir, 'instances', n8n.id, 'secrets', id), 'utf8')).toMatch(/^[a-f0-9]{64}$/);
    const appearance = await api.expect<AppearanceDto>(200, 'GET', '/v1/appearance');
    expect(appearance.home.order).toEqual(JSON.parse(before.settings.get('home.order')!));
    expect(appearance.rotation).toMatchObject({ enabled: true, everyHours: 6 });
    expect((await api.expect<SystemDto>(200, 'GET', '/v1/system')).deviceName).toBe('fixture-harbor');
    expect(await api.expect(200, 'GET', '/v1/updates/policy')).toMatchObject({ autoDefault: false });
    const channels = await api.expect<{ channels: { kind: string; topic?: string; token?: string }[] }>(200, 'GET', '/v1/notifications/channels');
    expect(channels.channels).toMatchObject([{ kind: 'ntfy', topic: 'harbor-fixture', token: '••••' }]);
    const notes = await api.expect<NotificationsDto>(200, 'GET', '/v1/notifications');
    expect(notes.items.map((n) => n.kind)).toContain('operation-failed');
  });

  it('no recovery words are left in the database', () => {
    const db = path.join(stateDir, 'harbor.db');
    for (const r of sqlRows<{ result_json: string | null }>(db, 'SELECT result_json FROM operations')) expect(r.result_json ?? '').not.toMatch(RECOVERY);
    const bytes = Buffer.concat(['', '-wal'].filter((s) => existsSync(db + s)).map((s) => readFileSync(db + s)));
    for (const words of before.words) expect(bytes.includes(Buffer.from(words))).toBe(false);
  });

  it('stop, start and update of the old apps succeed', async () => {
    const exca = await byName('excalidraw');
    expect((await api.run({ kind: 'stop', instanceId: exca.id })).op.state).toBe('succeeded');
    expect(await byName('excalidraw')).toMatchObject({ desired: 'stopped', runtime: 'stopped' });
    const started = await api.run({ kind: 'start', instanceId: exca.id });
    expect(started.op.state, JSON.stringify(started.op.error)).toBe('succeeded');

    // the stopped two-service app starts with the secrets the old Harbor generated
    const n8n = await byName('n8n');
    const n8nStart = await api.run({ kind: 'start', instanceId: n8n.id });
    expect(n8nStart.op.state, JSON.stringify(n8nStart.op.error)).toBe('succeeded');
    const password = readFileSync(path.join(stateDir, 'instances', n8n.id, 'secrets', 'database-password'), 'utf8').trim();
    const runtime = parseYaml(readFileSync(path.join(stateDir, 'instances', n8n.id, 'runtime', 'compose.yaml'), 'utf8')) as { services: Record<string, { environment?: Record<string, string> }> };
    expect(runtime.services['postgres']!.environment!['POSTGRES_PASSWORD']).toBe(password);
    expect(runtime.services['web']!.environment!['DB_POSTGRESDB_PASSWORD']).toBe(password);
    // fakes from 0.22 on record each container's environment: the engine's container has the same value
    const pg = meta.docker.containers.find((c) => c.labels['com.docker.compose.service'] === 'postgres' && c.project.includes(n8n.id.replace(/-/g, '')))!;
    const env = fake.envOf(pg.name);
    if (env && Object.keys(env).length) expect(env['POSTGRES_PASSWORD']).toBe(password);

    // the encrypted app updates to the revision this Harbor ships
    const memos = await byName('memos');
    const upd = await api.run({ kind: 'update', instanceId: memos.id });
    expect(upd.op.state, JSON.stringify(upd.op.error)).toBe('succeeded');
    expect(await byName('memos')).toMatchObject({ revision: '2', installState: 'installed', runtime: 'running' });

    await until(async () => (await api.instances()).filter((i) => i.installState === 'installed').every((i) => i.runtime === 'running' && i.readiness === 'healthy'), 'all installed apps healthy');
  });

  it('survives a restart of the current daemon, and nothing needs the operator', async () => {
    await daemon!.close();
    daemon = await start();
    api.token = (await api.login(meta.admin.username, meta.admin.password)).token;
    expect((await api.instances()).map((i) => i.id).sort()).toEqual(meta.instances.map((i) => i.id).sort());
    const db = path.join(stateDir, 'harbor.db');
    expect(sqlRows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM operations WHERE state = 'needs_action'")[0]!.n).toBe(0);
    expect(statSync(db).isFile()).toBe(true);
  });
});
