// Runs INSIDE a checkout of an OLD Harbor release (copied there by scripts/make-state-fixture.mjs) and drives that
// release's own daemon in fake mode (its FakeDocker, fake Tailscale/Caddy/crypto) through the public API, the way
// an operator would. It leaves a realistic state directory behind for the upgrade-jump test.
//
// Usage (from the old checkout root): tsx driver.mts <root>
//   <root>/state, <root>/data and <root>/catalog (a copy of that release's catalog) are created; <root>/fixture.json describes what was made.
//
// Imports are relative to the old checkout root, so this file is not type-checked against the current tree.
import nodeCrypto from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { normalizeConfig } from './src/config.js';
import { FakeDocker } from './src/docker/fake.js';
import { FakeTailscale } from './src/exposure/tailscale.js';
import { FakeNet } from './src/system/net.js';
import { FakePower } from './src/system/power.js';
import { demoFetcher, demoRegistry, startDaemon } from './src/daemon.js';
import { FakeReleaseFeed, FakeUnitStarter } from './src/system/selfupdate.js';
import { FakeCaddyAdmin } from './src/exposure/caddy.js';
import { FakeVerifier } from './src/exposure/verify.js';
import { FakeTransport } from './src/notify/notifier.js';
import { FakeGit } from './src/packages/git.js';
import { FakeCryptoProvider } from './src/storage/crypto-provider.js';
import { initializeState } from './src/state/db.js';
import { enrollAdministrator } from './src/maintenance.js';
import { systemClock, systemIds, type Ids } from './src/util.js';
import { Api } from './tests/integration/harness.js';

const root = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: tsx driver.mts <root>');
const ADMIN = { username: 'admin', password: 'upgrade-FIXTURE-password' };
// Fixed ports: they are recorded in the state, and the current daemon must find them inside its range again.
const LISTEN_PORT = 47_300;
const RANGE = { from: 47_310, to: 47_349 };

// Scanner-safe randomness (AGENTS.md 3.3): every token the daemon draws (generated app secrets, session tokens)
// is a visibly synthetic `fefe…<counter>` value, so nothing in the committed fixture looks like a credential.
let tokenSeq = 0;
const ids: Ids = {
  uuid: () => systemIds.uuid(),
  token: (n: number) => {
    tokenSeq += 1;
    const b = Buffer.alloc(n, 0xfe);
    b.writeUInt32BE(tokenSeq, Math.max(0, n - 4));
    return b;
  },
};

// The rest of the old code's randomness (key-wrapping salts and nonces, app-home and machine keys, the recovery
// words, fake container ids) goes through node:crypto randomBytes. Replace it with a visibly synthetic
// `fdfd…<counter>` stream for this run, so no committed byte looks like a drawn secret: the recovery words come
// out as one repeated word. syncBuiltinESMExports() updates the live `import { randomBytes }` bindings the old
// modules already hold. Ciphertext, GCM tags and scrypt hashes stay high-entropy: they are computed, not drawn.
let randomSeq = 0;
const synthetic = (n: number): Buffer => {
  const b = Buffer.alloc(n, 0xfd);
  randomSeq += 1;
  if (n >= 8) b.writeUInt32BE(randomSeq, n - 4);
  return b;
};
const patchedRandomBytes = ((n: number, cb?: (err: Error | null, buf: Buffer) => void) => {
  const b = synthetic(n);
  if (cb) {
    queueMicrotask(() => cb(null, b));
    return undefined;
  }
  return b;
}) as typeof nodeCrypto.randomBytes;
nodeCrypto.randomBytes = patchedRandomBytes;
syncBuiltinESMExports();

const stateDir = path.join(root, 'state');
const userDataDir = path.join(root, 'data');
const catalogDir = path.join(root, 'catalog');
mkdirSync(root, { recursive: true });
// Before 0.28.0 the official apps sat in catalog/ at the checkout root. From 0.28.0 they live in harbor-apps
// (decision 158): the release keeps frozen copies in tests/fixtures/catalog/, and its daemon downloads the official
// catalog unless `catalog.url` is null. That key only exists from 0.28.0, so it is passed only with that layout.
const split = !existsSync(path.resolve('catalog'));
cpSync(path.resolve(split ? 'tests/fixtures/catalog' : 'catalog'), catalogDir, { recursive: true });
const config = normalizeConfig(
  { stateDir, catalogDir, userDataDir, docker: { mode: 'fake' }, listen: { host: '127.0.0.1', port: LISTEN_PORT }, appPortRange: RANGE, planTtlSeconds: 900, sessionTtlSeconds: 3600, logLevel: 'error', ...(split ? { catalog: { url: null } } : {}) },
  root,
);
initializeState(stateDir, { clock: systemClock, ids: systemIds, config: {} });
await enrollAdministrator(config, ADMIN.username, ADMIN.password, { reset: false });

const fake = new FakeDocker(systemClock);
const tailscale = new FakeTailscale();
const caddy = new FakeCaddyAdmin();
const verifier = new FakeVerifier();
const crypto = new FakeCryptoProvider();
const notifyTransport = new FakeTransport();
const daemon = await startDaemon(config, {
  docker: fake,
  compose: fake,
  clock: systemClock,
  ids,
  observerIntervalMs: 500,
  sourceCheckMs: 700,
  tailscale,
  caddy,
  verify: verifier.fn,
  net: new FakeNet(),
  fetcher: demoFetcher(),
  power: new FakePower(),
  registry: demoRegistry(),
  releaseFeed: new FakeReleaseFeed(),
  unitStarter: new FakeUnitStarter(),
  notifyTransport,
  git: new FakeGit(),
  crypto,
  toolsProbe: async () => ({ reachable: false, note: 'not probed in the fixture run' }),
});
const madeAt = new Date().toISOString();
const api = new Api(`http://localhost:${LISTEN_PORT}`, null);
const sessionToken = (await api.login(ADMIN.username, ADMIN.password)).token;
api.token = sessionToken;
// A remembered browser session (30 days) next to the plain one. Both tokens are synthetic (`ids` above), so
// fixture.json records them: the test checks that an upgrade keeps browsers logged in.
const remembered = await api.expect<{ token: string }>(201, 'POST', '/v1/sessions', { ...ADMIN, remember: true }, { authorization: '' });

const ok = async (req: Record<string, unknown>) => {
  const { op } = await api.run(req);
  if (op.state !== 'succeeded') throw new Error(`${JSON.stringify(req)} -> ${op.state}: ${JSON.stringify(op.error)}`);
  return op;
};
const byName = async (name: string) => {
  const inst = (await api.instances()).find((i) => i.name === name);
  if (!inst) throw new Error(`no instance ${name}`);
  return inst;
};

// Apps: a stateless one, an encrypted app home in the data folder (Harbor's own key: the first encrypted install
// issues the installation's recovery words in the operation result, which is what 0.31.0 scrubs), and a
// two-service app with generated secrets that the operator then stops.
await ok({ kind: 'install', packageId: 'excalidraw' });
const memosOp = await ok({ kind: 'install', packageId: 'memos', location: { dir: path.join(userDataDir, 'harbor-apps', 'memos') } });
if (typeof memosOp.result?.['installationRecoveryKey'] !== 'string') throw new Error('expected the first encrypted install to mint recovery words');
await ok({ kind: 'install', packageId: 'n8n' });
const exca = await byName('excalidraw');
const memos = await byName('memos');
const n8n = await byName('n8n');
await ok({ kind: 'stop', instanceId: n8n.id });

// Exposures: Excalidraw on the tailnet, Memos on a public name (Memos has its own login: no basic auth).
await ok({ kind: 'expose', instanceId: exca.id, via: 'tailnet' });
await ok({ kind: 'expose', instanceId: memos.id, via: 'public', hostname: 'notes.example.com', protection: 'none' });

// Settings: launcher order, wallpaper rotation, machine name, update policy, per-app appearance and auto-update.
await api.expect(200, 'PUT', '/v1/appearance/home', { order: [memos.id, n8n.id, exca.id] });
await api.expect(200, 'PUT', '/v1/appearance/rotation', { enabled: true, everyHours: 6 });
await api.expect(200, 'PUT', '/v1/system/name', { name: 'fixture-harbor' });
await api.expect(200, 'PUT', '/v1/updates/policy', { autoDefault: false });
await api.expect(200, 'PUT', `/v1/instances/${exca.id}/appearance`, { displayName: 'Whiteboard', icon: { kind: 'glyph', glyph: 'WB', color: '#336699' } });
await api.expect(200, 'PUT', `/v1/instances/${exca.id}/auto-update`, { enabled: true });
await api.expect(200, 'PUT', '/v1/notifications/channels', {
  channels: [{ kind: 'ntfy', server: 'https://ntfy.example', topic: 'harbor-fixture', token: 'ntfy-FIXTURE-token', minSeverity: 'warning' }],
});

// Notifications: a failed install (error severity) the operator has not read yet.
fake.behaviour.failPull = 'registry unreachable (fixture)';
const failed = await api.run({ kind: 'install', packageId: 'bentopdf' });
fake.behaviour.failPull = null;
if (failed.op.state !== 'failed') throw new Error(`expected the bentopdf install to fail, got ${failed.op.state}`);

const final = await api.instances();
const exposures = (await api.expect<{ items: unknown[] }>(200, 'GET', '/v1/exposures')).items;
const notifications = (await api.expect<{ items: { kind: string }[] }>(200, 'GET', '/v1/notifications')).items;
const system = await api.expect<{ version: string }>(200, 'GET', '/v1/system');
await daemon.close();
// The engine's own state survives a Harbor upgrade (containers, volumes, networks keep their ids and labels):
// record the fake engine so the current daemon meets the same Docker world.
const docker = {
  containers: [...fake.containers.values()].map((c) => ({ ...c })),
  volumes: [...fake.volumes.values()],
  networks: [...fake.networks.values()],
};
await fake.shutdown();
// The repository keeps no empty directories; the test recreates these (app home vault/ and volume folders, …).
const emptyDirs: string[] = [];
const walk = (rel: string) => {
  const entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  if (entries.length === 0) emptyDirs.push(rel);
  for (const e of entries) if (e.isDirectory()) walk(path.join(rel, e.name));
};
walk('state');
walk('data');

writeFileSync(
  path.join(root, 'fixture.json'),
  JSON.stringify(
    {
      harborVersion: system.version,
      root,
      madeAt,
      admin: { username: ADMIN.username, password: ADMIN.password },
      sessions: { session: sessionToken, remember: remembered.token },
      listenPort: LISTEN_PORT,
      appPortRange: RANGE,
      // The fake kernel's sealed homes: fscrypt policies live on disk and survive a Harbor upgrade.
      sealedHomes: [...crypto.sealed],
      instances: final.map((i) => ({ id: i.id, name: i.name, packageId: i.packageId, revision: i.revision, runtime: i.runtime, desired: i.desired, endpoints: i.endpoints.map((e) => ({ id: e.id, hostPort: e.hostPort })) })),
      exposures,
      notificationKinds: notifications.map((n) => n.kind).sort(),
      emptyDirs,
      docker,
    },
    null,
    2,
  ) + '\n',
);
console.log(`fixture written under ${root} by Harbor ${system.version}`);
