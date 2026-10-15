// `pnpm dev`: run the daemon against a private local state directory with the fake Docker
// adapter. Nothing on the host is touched. Set HARBOR_DEV_DOCKER_SOCKET=/path/to/docker.sock
// to target a Docker engine explicitly (developer opt-in; never auto-discovered).
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { normalizeConfig } from './config.js';
import { startDaemon } from './daemon.js';
import { enrollAdministrator, initState } from './maintenance.js';
import { openState } from './state/db.js';
import { Repo } from './state/repo.js';
import { systemClock } from './util.js';
import { devGpu } from './system/gpu.js';
import { FakeDocker } from './docker/fake.js';
import { homedir } from 'node:os';

const root = path.resolve(process.env['HARBOR_DEV_ROOT'] ?? '.harbor-dev');
mkdirSync(root, { recursive: true, mode: 0o700 });
const stateDir = path.join(root, 'state');
mkdirSync(path.join(root, 'data'), { recursive: true });
// macOS: /var is a symlink to /private/var, so resolve the root once —
// otherwise the wizard's /var-spelled candidate dir never matches the
// daemon's /private/var-spelled resolution (decision 97 nested layout).
let resolvedRoot = root;
try {
  resolvedRoot = realpathSync(root);
} catch {
  // fall back to the unresolved spelling
}
// Fixture-hardware mode (HARBOR_DEVICES_JSON): listDevices overlays the
// simulated mount state from this daemon's state dir (see host-storage.ts).
if (process.env['HARBOR_DEVICES_JSON']) process.env['HARBOR_DEVICES_STATE_DIR'] = stateDir;
const socket = process.env['HARBOR_DEV_DOCKER_SOCKET'];
const port = Number(process.env['HARBOR_DEV_PORT'] ?? 18000);
const config = normalizeConfig(
  {
    stateDir,
    userDataDir: path.join(resolvedRoot, 'data'),
    catalogDir: path.resolve(process.env['HARBOR_DEV_CATALOG'] ?? 'tests/fixtures/catalog'),
    uiDir: existsSync(path.resolve('web/dist/index.html')) ? path.resolve('web/dist') : null,
    listen: { host: '127.0.0.1', port },
    docker: socket ? { mode: 'socket', socketPath: socket, cliPluginDirs: [path.join(homedir(), '.docker', 'cli-plugins')].filter((d) => existsSync(d)) } : { mode: 'fake' },
    appPortRange: { from: Number(process.env['HARBOR_DEV_PORT_FROM'] ?? 18080), to: Number(process.env['HARBOR_DEV_PORT_TO'] ?? 18999) },
    logLevel: (process.env['HARBOR_DEV_LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
    // Never reach the network from a dev box by default: the Store shows "Catalog updates are off".
    // HARBOR_DEV_CATALOG_URL turns checks on (https://, or http:// on loopback); in fake mode the
    // demo fetcher answers 404, so e2e uses it to drive the Store's failed-check line.
    catalog: { url: process.env['HARBOR_DEV_CATALOG_URL'] ?? null },
  },
  root,
);
writeFileSync(path.join(root, 'harbor.json'), JSON.stringify(config, null, 2));

if (!existsSync(path.join(stateDir, 'harbor.db'))) {
  const r = initState(config);
  console.error(`[dev] initialized private state at ${stateDir} (installation ${r.installationId})`);
}
{
  const db = openState(stateDir, { readonly: true });
  const hasAdmin = new Repo(db, systemClock).administrator() !== null;
  db.close();
  if (!hasAdmin && process.env['HARBOR_DEV_SETUP'] === '1') {
    // first-run wizard mode: no administrator; a known setup code for the browser
    const code = process.env['HARBOR_DEV_SETUP_CODE'] ?? '123456';
    writeFileSync(path.join(stateDir, 'setup-code'), code + '\n', { mode: 0o600 });
    console.error(`[dev] setup mode: no administrator; setup code ${code}`);
  } else if (!hasAdmin) {
    const password = process.env['HARBOR_DEV_PASSWORD'] ?? randomBytes(9).toString('base64url');
    await enrollAdministrator(config, 'admin', password, { reset: false });
    console.error(`[dev] enrolled administrator "admin". Password (dev only, shown once): ${password}`);
    console.error(`[dev] set HARBOR_DEV_PASSWORD to choose it yourself.`);
  }
}

// decisions 179, 181: HARBOR_DEV_GPU picks the fake machine's graphics card (fake mode only; values: devGpu in src/system/gpu.ts)
const daemon = await startDaemon(config, socket ? {} : { gpu: devGpu(process.env['HARBOR_DEV_GPU']) });
// decision 183 (e2e): HARBOR_DEV_FAKE_CONTROL=<file> makes fake pulls slow, read on every pull so a test can change it
// while the daemon runs: {"pullDelayMs": 8000, "match": "<image substring>"} (no file, bad JSON or no match = instant).
const control = process.env['HARBOR_DEV_FAKE_CONTROL'];
if (control && daemon.ctx.docker instanceof FakeDocker) {
  daemon.ctx.docker.behaviour.pullDelay = (images) => {
    try {
      const c = JSON.parse(readFileSync(control, 'utf8')) as { pullDelayMs?: unknown; match?: unknown };
      const ms = typeof c.pullDelayMs === 'number' ? c.pullDelayMs : 0;
      const match = typeof c.match === 'string' ? c.match : '';
      return images.some((i) => i.includes(match)) ? ms : 0;
    } catch {
      return 0;
    }
  };
}
console.error(`[dev] ${daemon.url}  docker=${daemon.ctx.docker.description}  ui=${config.uiDir ?? '(not built; run pnpm build:web)'}`);
const stop = () => void daemon.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
