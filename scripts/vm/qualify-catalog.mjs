#!/usr/bin/env node
// Live catalog qualification on the designated disposable VM:
//   node scripts/vm/qualify-catalog.mjs [--fresh] [--only immich,jellyfin] [--archive <tar.gz>] [--catalog <dir>] [--no-record]
// For every bundled package (or --only): install with the CLI, wait for readiness, open the UI in a real
// browser (screenshot + title + health probe), then remove. Packages with external storage claims are
// additionally installed once with a host folder ("bring your own folder"). Results are written to
// docs/evidence/catalog-<timestamp>/ and, unless --no-record, into each package's release.json qualification.
// --fresh rebuilds the VM and bootstraps Harbor from the release archive first (recommended: clean host).
// --catalog is the harbor-apps checkout (its apps/ folder; default as in scripts/catalog-dir.mjs) whose
// release.json files get the result. The box must list the same revisions, or nothing is recorded.
// Parallel runs (one droplet each: HARBOR_VM_NAME/HARBOR_VM_STATE/HARBOR_VM_KNOWN_HOSTS, see do-vm.mjs) set
// HARBOR_QUALIFY_SOCKS_PORT to a free local port: instead of fixed-port tunnels, the browser goes through an SSH
// SOCKS proxy to the box's own localhost and the probes run with curl on the box.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Evidence, ROOT, assertSeedCatalog, cli, cliOk, fail, pinCatalogToSeed, resolveTarget, sleep, waitFor } from './lib.mjs';
import { resolveCatalogDir } from '../catalog-dir.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const FRESH = has('--fresh');
const RECORD = !has('--no-record');
const ONLY = opt('--only', null)?.split(',').map((s) => s.trim());
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ARCHIVE = path.resolve(opt('--archive', path.join(ROOT, 'release', `harbor-${pkg.version}-linux-x64.tar.gz`)));
const ARCHIVE_DIR = path.basename(ARCHIVE).replace(/\.tar\.gz$/, '');
const ADMIN = { username: 'admin', password: 'harbor-test-Admin-Passw0rd' };
// retained instances keep their ports, so a full catalog pass needs more than the acceptance suite's 20
const PORTS = [18000, ...Array.from({ length: 60 }, (_, i) => 18080 + i)];
const UI = 'http://localhost:18000';
const EXT_ROOT = '/mnt/harbor-test-storage'; // inside harbor.service's writable paths, like a real drive (decision 121)
// instance names carry a per-run suffix: retained instances from earlier passes keep their names and ports
const SUFFIX = 'q' + new Date().toISOString().slice(11, 16).replace(':', '');

if (!existsSync(ARCHIVE)) fail(`release archive not found: ${ARCHIVE} (run pnpm package)`, 2);
let CATALOG;
try {
  CATALOG = resolveCatalogDir(opt('--catalog', null));
} catch (e) {
  fail(e.message, 2);
}
const target = resolveTarget();
const SOCKS = process.env.HARBOR_QUALIFY_SOCKS_PORT ? Number(process.env.HARBOR_QUALIFY_SOCKS_PORT) : null;
const runId = `catalog-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${process.env.HARBOR_VM_NAME ? `-${process.env.HARBOR_VM_NAME}` : ''}`;
const ev = new Evidence(path.join(ROOT, 'docs', 'evidence', runId));
const ssh = (cmd, o) => target.sshOk(cmd, o);
const sshTry = (cmd, o) => target.ssh(cmd, o);
console.log(`target: ${target.name}\nevidence: ${path.relative(ROOT, ev.dir)}\nfresh: ${FRESH}`);

const index = JSON.parse(readFileSync(path.join(CATALOG, 'index.json'), 'utf8'));
const ids = Object.keys(index.packages).filter((id) => !ONLY || ONLY.includes(id));
const manifests = Object.fromEntries(ids.map((id) => [id, readFileSync(path.join(CATALOG, id, 'manifest.yaml'), 'utf8')]));
const healthPathOf = (m) => /^\s*path:\s*(\S+)\s*$/m.exec(m.split('health:')[1] ?? '')?.[1] ?? '/';
const expectedOf = (m) => (/expectedStatus:\s*\[([^\]]+)\]/.exec(m)?.[1] ?? '200').split(',').map((s) => Number(s.trim()));
const externalClaims = (m) => [...m.matchAll(/^\s+- id: ([a-z0-9-]+)\n(?:.*\n){0,3}?\s+external:/gm)].map((x) => x[1]);

let browser;
let tunnel;
// HTTP status of a URL as the box itself sees it (SOCKS mode) or through the local tunnel
async function statusOf(url) {
  if (!SOCKS) return (await fetch(url, { redirect: 'manual' })).status;
  const r = sshTry(`curl -s -o /dev/null --max-time 20 -w '%{http_code}' '${String(url).replace(/'/g, '')}'`, { timeoutMs: 40_000 });
  const code = Number(r.stdout.trim());
  if (!code) throw new Error(`curl exit ${r.code}`);
  return code;
}
async function openTunnels() {
  tunnel?.close();
  tunnel = SOCKS ? target.socks(SOCKS) : target.tunnel(PORTS);
  await waitFor(async () => (await statusOf(`${UI}/healthz`)) === 200, { timeoutMs: 60_000, intervalMs: 1000, what: 'tunnel to daemon' });
}
async function newPage() {
  // '<-loopback>': Chromium otherwise never sends localhost through a proxy
  browser ??= await chromium.launch(SOCKS ? { proxy: { server: `socks5://127.0.0.1:${SOCKS}`, bypass: '<-loopback>' } } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return { ctx, page: await ctx.newPage() };
}

async function prepareHost() {
  if (FRESH) {
    console.log('rebuilding VM to a fresh Ubuntu 24.04 image...');
    await target.rebuildFresh();
    sshTry('command -v cloud-init >/dev/null && cloud-init status --wait >/dev/null 2>&1; true', { timeoutMs: 300_000 });
  }
  target.scp(ARCHIVE, `/root/${path.basename(ARCHIVE)}`);
  target.scp(path.join(path.dirname(ARCHIVE), 'SHA256SUMS'), '/root/SHA256SUMS');
  ssh(`cd /root && sha256sum -c SHA256SUMS && rm -rf ${ARCHIVE_DIR} && tar -xzf ${path.basename(ARCHIVE)}`);
  const fresh = sshTry('test -f /etc/harbor/harbor.json').code !== 0;
  if (!fresh) await waitFor(() => (cli(target, ['doctor']).json?.system?.busyOperationId ? null : true), { timeoutMs: 1800_000, intervalMs: 10_000, what: 'no operation in flight before bootstrap re-run' });
  const flags = fresh ? `--install-docker --admin-username ${ADMIN.username} --password-stdin` : '';
  const b = target.ssh(`cd /root && ./${ARCHIVE_DIR}/bin/harbor bootstrap --yes ${flags} 2>&1`, { input: fresh ? ADMIN.password + '\n' : undefined, timeoutMs: 1800_000 });
  ev.file('bootstrap.log', b.stdout + b.stderr);
  if (b.code !== 0) throw new Error(`bootstrap failed (exit ${b.code}); see bootstrap.log`);
  // decision 158: results are recorded against the archive's seed revisions, so no downloaded catalog may take over
  pinCatalogToSeed(target);
  await openTunnels();
  // Log in first: on a fresh host the CLI has no token and `doctor` reports system: null.
  const login = cli(target, ['login', '--username', ADMIN.username, '--password-stdin'], { input: ADMIN.password + '\n' });
  if (login.code !== 0) throw new Error(`CLI login failed: ${login.stderr} ${login.stdout}`);
  // wait for any operation a previous (interrupted) pass left running before touching state
  await waitFor(() => (cliOk(target, ['doctor']).system?.busyOperationId ? null : true), { timeoutMs: 1800_000, intervalMs: 10_000, what: 'no operation in flight' });
  const doctor = cliOk(target, ['doctor']);
  const catalog = assertSeedCatalog(target);
  const versions = {
    node: ssh('/opt/harbor/node/bin/node --version').trim(),
    docker: ssh("docker version --format '{{.Server.Version}}'").trim(),
    compose: ssh("docker compose version --short").trim(),
    ubuntu: ssh('lsb_release -ds').trim(),
    arch: ssh('uname -m').trim(),
  };
  ev.record('HOST', 'Host prepared: Harbor bootstrapped from the release archive', 'pass', { versions, installationId: doctor.system.installationId, fresh, rebuilt: FRESH, catalog }, [`Docker ${versions.docker}, Compose ${versions.compose}, Node ${versions.node}, ${versions.ubuntu} ${versions.arch}`, `app catalog pinned to the archive seed (serial ${catalog.serial}, updates off)`]);
  return versions;
}

function logsTail(instanceId) {
  return sshTry(`for c in $(docker ps -aq --filter label=io.harbor.preview/instance=${instanceId}); do echo "== $c"; docker logs --tail 15 $c 2>&1; done`).stdout.slice(-3000);
}

async function waitHealthy(name, timeoutMs) {
  return waitFor(() => {
    const i = cliOk(target, ['list']).find((x) => x.name === name);
    if (!i) return null;
    if (i.installState === 'installed' && i.readiness === 'healthy') return i;
    return null;
  }, { timeoutMs, intervalMs: 5000, what: `${name} healthy` });
}

async function qualifyOne(id, variant, storageArgs) {
  const m = manifests[id];
  const name = `${id}-${SUFFIX}${variant ? 'x' : ''}`;
  const t0 = Date.now();
  // decision 163: qualification accepts the permissions a package lists (it is the reviewer here)
  const op = cliOk(target, ['--accept-permissions', 'install', id, '--name', name, ...storageArgs, '--yes'], { timeoutMs: 2400_000 });
  if (op.state !== 'succeeded') throw new Error(`install ${op.state}: ${JSON.stringify(op.error)} | ${op.events.slice(-3).map((e) => e.message).join(' | ')}`);
  const inst = await waitHealthy(name, 600_000);
  const url = inst.endpoints[0].browserUrl;
  const expected = expectedOf(m);
  // Harbor already saw the app healthy; the probe is a second opinion through the tunnel. Some apps
  // (Jellyfin) answer 503 for a moment right after start, so give it a few tries and keep the history.
  const probeUrl = new URL(healthPathOf(m), url);
  const probeHistory = [];
  let probe = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      probe = { status: await statusOf(probeUrl) };
      probeHistory.push(probe.status);
      if (expected.includes(probe.status)) break;
    } catch (e) {
      probeHistory.push(`error: ${e.cause?.code ?? e.message}`);
    }
    await sleep(5000);
  }
  const { ctx, page } = await newPage();
  let title;
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); });
  try {
    // 'load', not 'networkidle': most of these apps hold a websocket open, so the network is never idle
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await sleep(4000);
    title = await page.title();
    await page.screenshot({ path: path.join(ev.dir, `${name}.png`) });
  } finally {
    await ctx.close();
  }
  const detail = cliOk(target, ['inspect', inst.id]);
  const containers = ssh(`docker ps --filter label=io.harbor.preview/instance=${inst.id} --format '{{.Names}} {{.Status}}'`).trim().split('\n');
  const mounts = ssh(`docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}} {{end}}' $(docker ps -q --filter label=io.harbor.preview/instance=${inst.id})`).trim().split('\n');
  const rm = cliOk(target, ['remove', inst.id, '--yes'], { timeoutMs: 600_000 });
  if (rm.state !== 'succeeded') throw new Error(`remove ${rm.state}: ${JSON.stringify(rm.error)}`);
  if (!probe || !expected.includes(probe.status)) throw new Error(`health probe ${probeUrl}: ${probeHistory.join(', ')} (expected ${expected}); container logs: ${logsTail(inst.id)}`);
  return {
    details: { name, instanceId: inst.id, url, title, healthStatus: probe.status, probeHistory, containers, mounts, resources: detail.resources, secondsToHealthy: Math.round((Date.now() - t0) / 1000), consoleErrors: consoleErrors.slice(0, 10) },
    notes: [`healthy after ${Math.round((Date.now() - t0) / 1000)}s; page title "${title}"; health ${probe.status}`, ...(variant ? [`external storage: ${storageArgs.join(' ')} mounted as bind`] : []), 'removed after the check; volumes and folders retained'],
  };
}

async function main() {
  const versions = await prepareHost();
  // A result is recorded against the checkout, so the box must be running the same package revisions.
  const onBox = Object.fromEntries(cliOk(target, ['catalog']).map((c) => [c.id, c.revision]));
  const drift = ids.filter((id) => onBox[id] !== index.packages[id].revision).map((id) => `${id} (box ${onBox[id] ?? 'missing'}, checkout ${index.packages[id].revision})`);
  if (drift.length) fail(`the box's catalog differs from ${CATALOG}: ${drift.join(', ')}; package a bundle of this checkout (HARBOR_CATALOG_BUNDLE) or pass --only`, 2);
  ssh(`mkdir -p ${EXT_ROOT} && chmod 777 ${EXT_ROOT}`);
  const results = {};
  for (const id of ids) {
    const m = manifests[id];
    const ext = externalClaims(m);
    for (const variant of [false, ...(ext.length ? [true] : [])]) {
      const step = `${id}${variant ? ' (external storage)' : ''}`;
      let storageArgs = [];
      if (variant) {
        for (const c of ext) {
          const dir = `${EXT_ROOT}/${id}-${c}-${SUFFIX}`; // retained instances keep their folders reserved, so each pass gets fresh ones
          // Prepared the way each package's hint says (Nextcloud: uid 33, group harbor, mode 0770).
          const prep = id === 'nextcloud' ? `chown 33:harbor ${dir} && chmod 0770 ${dir}` : `chmod 777 ${dir}`;
          ssh(`mkdir -p ${dir} && touch ${dir}/.harbor-test-marker && ${prep}`);
          storageArgs.push('--storage', `${c}=${dir}`);
        }
      }
      try {
        const r = await qualifyOne(id, variant, storageArgs);
        r.details.title ??= '';
        ev.record(step, `Install, readiness, browser check and remove of ${step}`, 'pass', r.details, r.notes);
        if (variant) {
          const mountsOk = r.details.mounts.some((l) => l.includes(`bind:${EXT_ROOT}/${id}-`));
          if (!mountsOk) throw new Error(`no bind mount of ${EXT_ROOT} observed: ${r.details.mounts.join(' ')}`);
          const marker = sshTry(`ls ${EXT_ROOT}/${id}-${ext[0]}-${SUFFIX}/.harbor-test-marker`).code === 0;
          if (!marker) throw new Error('external folder marker disappeared');
        }
        results[id] = results[id] ?? 'passed';
        console.log(`[PASS] ${step}: ${r.notes[0]}`);
      } catch (e) {
        ev.record(step, `Install, readiness, browser check and remove of ${step}`, 'fail', { error: e.message }, [String(e.message)]);
        results[id] = 'blocked';
        console.log(`[FAIL] ${step}: ${e.message}`);
        // leave nothing running for the next package
        const left = cliOk(target, ['list']).filter((i) => i.name.startsWith(`${id}-${SUFFIX}`) && i.installState !== 'retained');
        for (const i of left) cli(target, ['remove', i.id, '--yes'], { timeoutMs: 600_000 });
      }
    }
  }
  // Still the seed the drift check compared? Otherwise the installs above ran other revisions: record nothing.
  let seedHeld = true;
  try {
    assertSeedCatalog(target);
  } catch (e) {
    seedHeld = false;
    ev.record('CATALOG', 'The box served the archive seed for the whole run', 'fail', { error: e.message }, [String(e.message)]);
    console.log(`[FAIL] ${e.message}; nothing recorded into release.json`);
  }
  ev.file('report.json', JSON.stringify({ runId, target: target.name, versions, results, results_detail: ev.results }, null, 2));
  const md = [`# Catalog qualification ${runId}`, '', `Host: ${versions.ubuntu} ${versions.arch}, Docker ${versions.docker}, Compose ${versions.compose}, Node ${versions.node}${FRESH ? ' (fresh VM)' : ''}`, '', '| Package | Result | Notes |', '|---|---|---|', ...ev.results.filter((r) => r.id !== 'HOST').map((r) => `| ${r.id} | ${r.status} | ${r.notes.join('; ').replace(/\|/g, '/')} |`), ''].join('\n');
  writeFileSync(path.join(ev.dir, 'report.md'), md);
  if (RECORD && seedHeld) {
    for (const [id, status] of Object.entries(results)) {
      const file = path.join(CATALOG, id, 'release.json');
      const rel = JSON.parse(readFileSync(file, 'utf8'));
      const appVersions = Object.fromEntries(Object.entries(rel.images).map(([svc, img]) => [svc, img.appVersion ?? img.tag]));
      const r = ev.results.find((x) => x.id === id);
      rel.qualification = {
        status,
        date: new Date().toISOString().slice(0, 10),
        node: versions.node,
        dockerEngine: versions.docker,
        dockerCompose: versions.compose,
        hostOs: `${versions.ubuntu} ${versions.arch}`,
        appVersions,
        // release.json notes are bounded (≤ 1000 chars, plain text): keep the first line of the reason, truncated
        notes: [...(rel.qualification.notes ?? []).filter((n) => !n.startsWith('Live catalog run ')), `Live catalog run ${runId}: ${status}${r ? ` (${String(r.notes[0]).split('\n')[0].slice(0, 400)})` : ''}`],
      };
      writeFileSync(file, JSON.stringify(rel, null, 2) + '\n');
      execFileSync('pnpm', ['tsx', 'scripts/catalog-hash.ts', id], { stdio: 'ignore' });
    }
  }
  await browser?.close();
  tunnel?.close();
  const failed = Object.values(results).filter((s) => s !== 'passed').length;
  console.log(`\n${Object.keys(results).length} packages, ${failed} blocked. Report: ${path.relative(ROOT, ev.dir)}/report.md`);
  process.exit(failed || !seedHeld ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await browser?.close();
  tunnel?.close();
  process.exit(1);
});
