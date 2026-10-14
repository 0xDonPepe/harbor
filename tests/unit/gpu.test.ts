// Decision 179: the `gpu` permission. The package asks for the machine's graphics card; Harbor's renderer
// alone writes what Docker needs (deploy device request for NVIDIA, /dev/dri + groups for Intel/AMD), from
// host facts the GpuObserver collects. The planner stays pure: the facts are an input.
import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validateManifestReferences, validateManifestShape } from '../../src/packages/manifest.js';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { identityFor } from '../../src/planner/identity.js';
import { renderCompose } from '../../src/planner/render.js';
import { newPermissions, PERMISSION_LABEL, permissionsOf } from '../../src/planner/permissions.js';
import { DRIVER_INSTALL_NEXT_STEP, DRIVER_LOAD_NEXT_STEP, DRIVER_REBOOT_NEXT_STEP, DRIVER_UPDATE_NEXT_STEP, gpuChanges, gpuDto, gpuFromRendered, gpuServicesOf, gpuStatusLine, NVIDIA_DRIVER_MIN_MAJOR, renderedGpuKind, rendersGpu } from '../../src/planner/gpu.js';
import { detectGpu, devGpu, dockerdStartedAt, HostGpuObserver, parseNvidiaDriverVersion } from '../../src/system/gpu.js';
import { gpuFact } from '../../src/cli/plan-summary.js';
import { GPU_DOCKER_RESTART_STEP, GPU_DRIVER_INSTALL_STEP, GPU_DRIVER_LOAD_STEP, GPU_DRIVER_REBOOT_STEP, GPU_DRIVER_UPDATE_STEP, GPU_TOOLKIT_STEP, gpuAppText, gpuMachineText, gpuReviewText } from '../../web/src/app/gpu-text.js';
import { FakeDocker } from '../../src/docker/fake.js';
import { HarborError } from '../../src/errors.js';
import type { HostGpu } from '../../src/contracts/types.js';
import { MINIMAL_COMPOSE, MINIMAL_MANIFEST } from './helpers.js';

const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'x');
const manifestOf = (s: string) => validateManifestShape(y(s));
const composeOf = (s: string) => validateComposeSource(y(s));

const GPU_MANIFEST = MINIMAL_MANIFEST + 'permissions:\n  web: [gpu]\n';
const NVIDIA: HostGpu = { kind: 'nvidia', detail: 'NVIDIA GeForce RTX 3090' };
const DRI: HostGpu = { kind: 'dri', detail: 'Intel graphics', renderNode: 'renderD128', renderGid: 992 };
const NONE: HostGpu = { kind: 'none', detail: 'No graphics card found' };
const MISSING: HostGpu = { kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_TOOLKIT_MISSING' };
const RESTART: HostGpu = { kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_DOCKER_RESTART_NEEDED' };
const DRI_MISSING: HostGpu = { ...DRI, problem: 'NVIDIA_TOOLKIT_MISSING' };

describe('the gpu permission in the package format (decision 179)', () => {
  it('accepts gpu next to the decision-163 permissions, all four on one service', () => {
    const m = manifestOf(MINIMAL_MANIFEST + 'permissions:\n  web: [net-admin, tun, ip-forwarding, gpu]\n');
    expect(m.permissions?.['web']).toEqual(['net-admin', 'tun', 'ip-forwarding', 'gpu']);
    validateManifestReferences(m, composeOf(MINIMAL_COMPOSE));
  });
  it('still refuses unknown permission values', () => {
    expect(() => manifestOf(MINIMAL_MANIFEST + 'permissions:\n  web: [gpu, nvidia]\n')).toThrow(HarborError);
  });
  it('package compose can never ask for devices, deploy, runtime or group_add itself', () => {
    for (const k of ['devices: [/dev/dri]', 'deploy: {resources: {}}', 'runtime: nvidia', 'group_add: ["992"]']) {
      try {
        composeOf(MINIMAL_COMPOSE + '    ' + k + '\n');
        throw new Error(`accepted ${k}`);
      } catch (e) {
        expect(HarborError.is(e), String(e)).toBe(true);
        expect((e as HarborError).code).toBe('UNSUPPORTED_CAPABILITY');
      }
    }
  });
  it('is a permission like the others: labelled, listed, and new in an update', () => {
    expect(PERMISSION_LABEL.gpu).toBe("Use this machine's graphics card (GPU)");
    const plain = manifestOf(MINIMAL_MANIFEST);
    const gpu = manifestOf(GPU_MANIFEST);
    expect(permissionsOf(gpu)).toEqual([{ service: 'web', permission: 'gpu' }]);
    expect(newPermissions(plain, gpu)).toEqual([{ service: 'web', permission: 'gpu' }]);
    expect(newPermissions(gpu, gpu)).toEqual([]);
    expect(gpuServicesOf(gpu)).toEqual(['web']);
    expect(gpuServicesOf(plain)).toEqual([]);
  });
});

describe('rendering the gpu permission (pure)', () => {
  const identity = identityFor('0a0a0a0a-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111');
  const endpoints = [{ id: 'web', service: 'web', containerPort: 80, hostPort: 18080 }];
  const compose = composeOf(MINIMAL_COMPOSE);
  const render = (m: string, gpu?: HostGpu) => parseYaml(renderCompose({ manifest: manifestOf(m), compose, identity, endpoints, secretValues: null, ...(gpu ? { gpu } : {}) }).yaml);

  it('nvidia: a device request for every NVIDIA card with compute and utility named (Docker sets the driver capabilities), nothing else', () => {
    const web = render(GPU_MANIFEST, NVIDIA).services.web;
    expect(web.deploy).toEqual({ resources: { reservations: { devices: [{ driver: 'nvidia', count: 'all', capabilities: ['gpu', 'compute', 'utility'] }] } } });
    expect(web.devices).toBeUndefined();
    expect(web.group_add).toBeUndefined();
    expect(web.environment).toBeUndefined();
    expect(rendersGpu(render(GPU_MANIFEST, NVIDIA), 'web')).toBe(true);
  });
  it('dri: only the detected render node and its group (no card<N>, no video group)', () => {
    const web = render(GPU_MANIFEST, DRI).services.web;
    expect(web.devices).toEqual(['/dev/dri/renderD128:/dev/dri/renderD128']);
    expect(web.group_add).toEqual(['992']);
    expect(web.deploy).toBeUndefined();
    expect(rendersGpu(render(GPU_MANIFEST, DRI), 'web')).toBe(true);
  });
  it('dri merges with tun, skips an unknown group, and needs the node name', () => {
    const web = render(MINIMAL_MANIFEST + 'permissions:\n  web: [tun, gpu]\n', { kind: 'dri', detail: 'AMD graphics', renderNode: 'renderD129', renderGid: 44 }).services.web;
    expect(web.devices).toEqual(['/dev/net/tun:/dev/net/tun', '/dev/dri/renderD129:/dev/dri/renderD129']);
    expect(web.group_add).toEqual(['44']);
    const noGroups = render(GPU_MANIFEST, { kind: 'dri', detail: 'Intel graphics', renderNode: 'renderD128' }).services.web;
    expect(noGroups.devices).toEqual(['/dev/dri/renderD128:/dev/dri/renderD128']);
    expect(noGroups.group_add).toBeUndefined();
    const noNode = render(GPU_MANIFEST, { kind: 'dri', detail: 'Intel graphics', renderGid: 992 }).services.web;
    expect(noNode.devices).toBeUndefined();
    expect(noNode.group_add).toBeUndefined();
  });
  it('none (and the toolkit problem, and no facts at all): nothing; the app runs on the CPU', () => {
    for (const g of [NONE, MISSING, undefined]) {
      const doc = render(GPU_MANIFEST, g);
      expect(doc.services.web.deploy).toBeUndefined();
      expect(doc.services.web.devices).toBeUndefined();
      expect(rendersGpu(doc, 'web')).toBe(false);
    }
  });
  it('a re-render with no restart keeps what the running containers have (facts read back from the file)', () => {
    for (const g of [NVIDIA, DRI, NONE, { kind: 'dri' as const, detail: 'AMD graphics', renderNode: 'renderD130', renderGid: 7 }]) {
      const before = render(GPU_MANIFEST, g);
      const again = render(GPU_MANIFEST, gpuFromRendered(before, ['web']));
      expect(again.services.web).toEqual(before.services.web);
    }
    expect(gpuFromRendered(null, ['web']).kind).toBe('none');
    expect(gpuFromRendered(render(GPU_MANIFEST, DRI), ['web'])).toMatchObject({ kind: 'dri', renderNode: 'renderD128', renderGid: 992 });
    expect(renderedGpuKind(render(GPU_MANIFEST, NVIDIA), 'web')).toBe('nvidia');
    expect(renderedGpuKind(render(GPU_MANIFEST, DRI), 'web')).toBe('dri');
    expect(renderedGpuKind(render(GPU_MANIFEST, NONE), 'web')).toBe('none');
  });
  it('a service without the permission gets nothing even on an NVIDIA machine', () => {
    const doc = render(MINIMAL_MANIFEST, NVIDIA);
    expect(doc.services.web.deploy).toBeUndefined();
    expect(rendersGpu(doc, 'web')).toBe(false);
  });
});

describe('plan lines and the status line', () => {
  it('says what the app gets in plain words', () => {
    const m = manifestOf(GPU_MANIFEST);
    expect(gpuChanges(m, NVIDIA)).toEqual(['Use the NVIDIA GeForce RTX 3090 (GPU) for web']);
    expect(gpuChanges(m, DRI)).toEqual(['Use Intel graphics for web']);
    expect(gpuChanges(m, NONE)).toEqual(['No usable graphics card found: web runs on the CPU']);
    expect(gpuChanges(m, MISSING)[0]).toMatch(/NVIDIA graphics card is in this machine, but the NVIDIA container toolkit is not installed: web runs on the CPU until then \(Install the NVIDIA container toolkit/);
    expect(gpuChanges(m, RESTART)[0]).toMatch(/Docker has not restarted since the NVIDIA container toolkit was installed: web runs on the CPU until then \(Restart Docker/);
    expect(gpuChanges(m, DRI_MISSING)[0]).toMatch(/^Use Intel graphics for web \(an NVIDIA card is also in this machine, but the NVIDIA container toolkit is not installed: Install/);
    expect(gpuChanges(manifestOf(MINIMAL_MANIFEST), NVIDIA)).toEqual([]);
  });
  it('the DTO keeps only kind, detail and problem (no group ids)', () => {
    expect(gpuDto(DRI)).toEqual({ kind: 'dri', detail: 'Intel graphics' });
    expect(gpuDto(RESTART)).toEqual({ kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_DOCKER_RESTART_NEEDED' });
    expect(gpuDto(MISSING)).toEqual({ kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_TOOLKIT_MISSING' });
  });
  it('the CLI fact line (harbor plan / harbor gpu)', () => {
    expect(gpuFact(NVIDIA)).toBe('NVIDIA GeForce RTX 3090 (ready for apps)');
    expect(gpuFact(NONE)).toBe('no usable graphics card found: runs on the CPU');
    expect(gpuFact(MISSING)).toMatch(/toolkit is not installed: runs on the CPU until then \(Install the NVIDIA container toolkit/);
    expect(gpuFact(RESTART)).toMatch(/Docker has not restarted since .*: runs on the CPU until then \(Restart Docker/);
    expect(gpuFact(DRI_MISSING)).toMatch(/^Intel graphics; an NVIDIA card is also here, but the NVIDIA container toolkit is not installed/);
  });
  it('the status line', () => {
    expect(gpuStatusLine({ ...NVIDIA, inUse: true })).toBe('NVIDIA GeForce RTX 3090 (in use)');
    expect(gpuStatusLine({ ...NVIDIA, inUse: false })).toMatch(/NVIDIA GeForce RTX 3090 found; restart the app to use it/);
    expect(gpuStatusLine({ ...NONE, inUse: false })).toBe('none found — runs on the CPU');
    expect(gpuStatusLine({ ...MISSING, inUse: false })).toMatch(/toolkit is not installed/);
    expect(gpuStatusLine({ ...RESTART, inUse: false })).toMatch(/Docker has not restarted since .* Restart Docker/);
    // harbor inspect mirrors the console: Intel graphics in use, and the NVIDIA card next to it named with its step
    expect(gpuStatusLine({ ...gpuDto(DRI_MISSING), inUse: true })).toBe('Intel graphics (in use). An NVIDIA card is also in this machine, but the NVIDIA container toolkit is not installed. Install the NVIDIA container toolkit (Operator Guide, GPU), then restart the app.');
  });
});

// A fake host root: /proc, /dev, /sys and /etc/group as files under a temp dir
describe('detecting the graphics card (fake host root)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const host = (files: Record<string, string>, links: Record<string, string> = {}) => {
    const root = mkdtempSync(path.join(tmpdir(), 'harbor-gpu-'));
    roots.push(root);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), body);
    }
    for (const [rel, target] of Object.entries(links)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      symlinkSync(target, path.join(root, rel));
    }
    return root;
  };
  const NVIDIA_FILES = {
    'proc/driver/nvidia/version': 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.163.01\n',
    'proc/driver/nvidia/gpus/0000:01:00.0/information': 'Model: \t\t NVIDIA GeForce RTX 3090\nIRQ:   \t\t 140\n',
    'dev/nvidia0': '',
  };
  // what harbor-old has: the NVIDIA card's own DRM nodes (nvidia-drm), which do not count as Intel/AMD graphics
  const NVIDIA_DRM = { 'dev/dri/renderD128': '', 'dev/dri/card1': '' };
  const NVIDIA_DRM_LINKS = { 'sys/class/drm/renderD128/device/driver': '../../../bus/pci/drivers/nvidia' };
  const runc = async () => ['io.containerd.runc.v2', 'runc'];
  // dockerd's pid file and /proc entries: started `atSec` seconds after the epoch (boot time + start ticks / 100)
  const dockerd = (atSec: number) => ({
    'run/docker.pid': '4242\n',
    'proc/4242/stat': `4242 (dockerd) S 1 4242 4242 0 -1 4194560 1 0 0 0 10 5 0 0 20 0 30 0 ${150 * 100} 0 0\n`,
    'proc/stat': `cpu  1 2 3 4\nbtime ${atSec - 150}\nprocesses 99\n`,
  });
  const HOOK = 'usr/bin/nvidia-container-runtime-hook';
  const withHook = (files: Record<string, string>, links: Record<string, string> = {}) => {
    const root = host({ ...files, [HOOK]: '#!/bin/sh\n' }, links);
    chmodSync(path.join(root, HOOK), 0o755);
    return root;
  };
  const LATER = Math.ceil(Date.now() / 1000) + 3600; // dockerd (re)started after the hook landed
  const later = () => LATER;

  it('an NVIDIA card with the nvidia runtime registered in Docker', async () => {
    const root = host(NVIDIA_FILES);
    expect(await detectGpu({ root, runtimes: async () => ['nvidia', 'runc'] })).toEqual({ kind: 'nvidia', detail: 'NVIDIA GeForce RTX 3090', driverVersion: '550.163.01' });
  });
  it('an NVIDIA card with only the toolkit hook, installed before dockerd started (Docker registered its nvidia driver)', async () => {
    const root = withHook({ ...NVIDIA_FILES, ...dockerd(later()) });
    expect(await detectGpu({ root, runtimes: runc })).toEqual({ kind: 'nvidia', detail: 'NVIDIA GeForce RTX 3090', driverVersion: '550.163.01' });
    expect(dockerdStartedAt(root)).toBe(later() * 1000);
  });
  it('the hook installed after dockerd started: not usable until Docker restarts (a device request would fail)', async () => {
    const root = withHook({ ...NVIDIA_FILES, ...dockerd(1_000_000_000) }); // dockerd started in 2001
    expect(await detectGpu({ root, runtimes: runc })).toEqual({ kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_DOCKER_RESTART_NEEDED', driverVersion: '550.163.01' });
    // dockerd's start time unknown (no pid file): not usable either, never guessed
    expect((await detectGpu({ root: withHook(NVIDIA_FILES), runtimes: runc })).problem).toBe('NVIDIA_DOCKER_RESTART_NEEDED');
    // the registered nvidia runtime (it only shows after a restart) wins over the start-time check
    expect((await detectGpu({ root, runtimes: async () => ['nvidia', 'runc'] })).kind).toBe('nvidia');
    // with Intel graphics next to it: dri, with the problem
    const both = withHook({ ...NVIDIA_FILES, ...dockerd(1_000_000_000), 'dev/dri/renderD129': '' }, { 'sys/class/drm/renderD129/device/driver': '../../../bus/pci/drivers/i915' });
    expect(await detectGpu({ root: both, runtimes: runc })).toMatchObject({ kind: 'dri', renderNode: 'renderD129', problem: 'NVIDIA_DOCKER_RESTART_NEEDED' });
  });
  it('a hook file that is not executable does not count', async () => {
    const root = host({ ...NVIDIA_FILES, 'usr/bin/nvidia-container-runtime-hook': '' });
    chmodSync(path.join(root, 'usr/bin/nvidia-container-runtime-hook'), 0o644);
    expect((await detectGpu({ root, runtimes: runc })).problem).toBe('NVIDIA_TOOLKIT_MISSING');
  });
  it('an NVIDIA card without the toolkit (harbor-old today): none, with the problem; its nvidia-drm node is ignored', async () => {
    const root = host({ ...NVIDIA_FILES, ...NVIDIA_DRM }, NVIDIA_DRM_LINKS);
    expect(await detectGpu({ root, runtimes: runc })).toEqual({ kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_TOOLKIT_MISSING', driverVersion: '550.163.01' });
  });
  it('docker info failing falls back to the hook check', async () => {
    const failing = async (): Promise<string[]> => {
      throw new Error('connect ENOENT /var/run/docker.sock');
    };
    expect((await detectGpu({ root: host(NVIDIA_FILES), runtimes: failing })).problem).toBe('NVIDIA_TOOLKIT_MISSING');
    const local = host({ ...NVIDIA_FILES, ...dockerd(later()), 'usr/local/bin/nvidia-container-runtime-hook': '' });
    chmodSync(path.join(local, 'usr/local/bin/nvidia-container-runtime-hook'), 0o755);
    expect((await detectGpu({ root: local, runtimes: failing })).kind).toBe('nvidia');
  });
  it('only /dev/nvidia0 (no /proc entry): still an NVIDIA card, named generically', async () => {
    const root = host({ 'dev/nvidia0': '' });
    expect(await detectGpu({ root, runtimes: async () => ['nvidia'] })).toEqual({ kind: 'nvidia', detail: 'NVIDIA graphics card' });
  });
  it('an Intel render node: dri, with that node and its group only (never the video group)', async () => {
    const root = host({ 'dev/dri/renderD128': '', 'dev/dri/card0': '', 'etc/group': 'root:x:0:\nvideo:x:44:harbor\nrender:x:992:\n' }, { 'sys/class/drm/renderD128/device/driver': '../../../bus/pci/drivers/i915' });
    const gid = statSync(path.join(root, 'dev/dri/renderD128')).gid;
    expect(await detectGpu({ root, runtimes: runc })).toEqual({ kind: 'dri', detail: 'Intel graphics', renderNode: 'renderD128', renderGid: gid });
  });
  it('an AMD node next to an NVIDIA card without the toolkit: dri, and the problem is still said', async () => {
    const root = host({ ...NVIDIA_FILES, ...NVIDIA_DRM, 'dev/dri/renderD129': '' }, { ...NVIDIA_DRM_LINKS, 'sys/class/drm/renderD129/device/driver': '../../../bus/pci/drivers/amdgpu' });
    const g = await detectGpu({ root, runtimes: runc });
    expect(g.kind).toBe('dri');
    expect(g.detail).toBe('AMD graphics');
    expect(g.problem).toBe('NVIDIA_TOOLKIT_MISSING');
    expect(g.renderNode).toBe('renderD129'); // the AMD node, not the NVIDIA card's own renderD128
  });
  it('nothing at all', async () => {
    expect(await detectGpu({ root: host({}), runtimes: runc })).toEqual({ kind: 'none', detail: 'No graphics card found' });
  });
  it('never throws: an unreadable root reads as none', async () => {
    const g = await detectGpu({ root: path.join(tmpdir(), 'harbor-gpu-does-not-exist', 'x'), runtimes: runc });
    expect(g.kind).toBe('none');
  });
  it('the observer caches for 30 s and the fake engine reports runc only', async () => {
    const fake = new FakeDocker();
    expect((await fake.info()).runtimes).toEqual(['runc']);
    fake.behaviour.runtimes = ['nvidia', 'runc'];
    const root = host(NVIDIA_FILES);
    let now = 0;
    const obs = new HostGpuObserver({ root, runtimes: async () => (await fake.info()).runtimes, now: () => now });
    expect(obs.cached()).toBeNull();
    expect((await obs.detect()).kind).toBe('nvidia');
    fake.behaviour.runtimes = ['runc'];
    now = 29_000;
    expect((await obs.detect()).kind).toBe('nvidia');
    now = 31_000;
    expect((await obs.detect()).problem).toBe('NVIDIA_TOOLKIT_MISSING');
    expect(obs.cached()?.problem).toBe('NVIDIA_TOOLKIT_MISSING');
  });
});

describe('the NVIDIA toolkit variables belong to Harbor on a service granted gpu (decision 179)', () => {
  const refusal = (m: string, c: string): string => {
    try {
      validateManifestReferences(manifestOf(m), composeOf(c));
    } catch (e) {
      expect(HarborError.is(e), String(e)).toBe(true);
      return [(e as HarborError).message, ...(e as HarborError).details].join('\n');
    }
    throw new Error('accepted');
  };
  const withEnv = (env: string) => MINIMAL_COMPOSE + `    environment:\n      ${env}\n`;
  it('refuses a compose literal that would widen the grant (all driver features, other devices)', () => {
    for (const k of ['NVIDIA_DRIVER_CAPABILITIES: all', 'NVIDIA_VISIBLE_DEVICES: all', 'NVIDIA_MIG_CONFIG_DEVICES: all']) {
      expect(refusal(GPU_MANIFEST, withEnv(k))).toMatch(/service web is granted gpu, so compose.yaml must not set NVIDIA_/);
    }
  });
  it('refuses a setting, secret or link bound to one of them', () => {
    const setting = GPU_MANIFEST + 'settings:\n  - id: cards\n    label: Cards\n    type: string\n    default: all\n    bindings:\n      - {service: web, environment: NVIDIA_VISIBLE_DEVICES}\n';
    expect(refusal(setting, MINIMAL_COMPOSE)).toMatch(/settings.cards targets web.NVIDIA_VISIBLE_DEVICES, which Harbor sets for a service granted gpu/);
  });
  it('keeps accepting them where gpu is not granted, and other NVIDIA_ variables everywhere (localai sets NVIDIA_DISABLE_REQUIRE)', () => {
    validateManifestReferences(manifestOf(MINIMAL_MANIFEST), composeOf(withEnv('NVIDIA_VISIBLE_DEVICES: all')));
    validateManifestReferences(manifestOf(GPU_MANIFEST), composeOf(withEnv('NVIDIA_DISABLE_REQUIRE: "true"')));
  });
});

describe('the console wording for every machine (web/src/app/gpu-text.ts)', () => {
  const RTX = 'NVIDIA GeForce RTX 3090';
  const failed = { kind: 'none' as const, detail: 'Could not check for a graphics card: EACCES' };
  it('Settings → Overview (what this machine offers)', () => {
    expect(gpuMachineText(gpuDto(NVIDIA))).toBe(RTX);
    expect(gpuMachineText(gpuDto(DRI))).toBe('Intel graphics');
    expect(gpuMachineText(gpuDto(DRI_MISSING))).toBe('Intel graphics · an NVIDIA card is also here, but the NVIDIA container toolkit is not installed (Operator Guide → GPU)');
    expect(gpuMachineText(gpuDto(MISSING))).toBe(`${RTX} · the NVIDIA container toolkit is not installed (Operator Guide → GPU)`);
    expect(gpuMachineText(gpuDto(RESTART))).toBe(`${RTX} · Docker has not restarted since the NVIDIA container toolkit was installed (Operator Guide → GPU)`);
    expect(gpuMachineText(gpuDto(NONE))).toBe('None found · apps run on the CPU');
    expect(gpuMachineText(failed)).toBe('None found · apps run on the CPU');
  });
  it('the app page (whether the containers have it, and the next step)', () => {
    expect(gpuAppText({ ...gpuDto(NVIDIA), inUse: true })).toBe(`${RTX} (in use)`);
    expect(gpuAppText({ ...gpuDto(NVIDIA), inUse: false })).toBe(`${RTX} found · restart the app to use it`);
    expect(gpuAppText({ ...gpuDto(DRI), inUse: true })).toBe('Intel graphics (in use)');
    expect(gpuAppText({ ...gpuDto(DRI_MISSING), inUse: true })).toBe(`Intel graphics (in use) · an NVIDIA card is also here, but the NVIDIA container toolkit is not installed. ${GPU_TOOLKIT_STEP}`);
    expect(gpuAppText({ ...gpuDto(MISSING), inUse: false })).toBe(`${RTX} found, but the NVIDIA container toolkit is not installed · runs on the CPU. ${GPU_TOOLKIT_STEP}`);
    expect(gpuAppText({ ...gpuDto(RESTART), inUse: false })).toBe(`${RTX} found, but Docker has not restarted since the NVIDIA container toolkit was installed · runs on the CPU. ${GPU_DOCKER_RESTART_STEP}`);
    expect(gpuAppText({ ...gpuDto(NONE), inUse: false })).toBe('none found — runs on the CPU');
    expect(gpuAppText({ ...failed, inUse: false })).toBe('none found — runs on the CPU');
  });
  it('the review, asking (install) and already allowed (update)', () => {
    for (const asking of [true, false]) {
      expect(gpuReviewText(gpuDto(NVIDIA), asking)).toBe(`This machine has an ${RTX}: the app uses it.`);
      expect(gpuReviewText(gpuDto(DRI), asking)).toBe('This machine has Intel graphics: the app uses it.');
      expect(gpuReviewText(gpuDto(DRI_MISSING), asking)).toBe(`This machine has Intel graphics (the app uses it) and an NVIDIA card it cannot use yet: the NVIDIA container toolkit is not installed. ${GPU_TOOLKIT_STEP}`);
      expect(gpuReviewText(gpuDto(MISSING), asking)).toBe(`This machine has an ${RTX}, but the NVIDIA container toolkit is not installed, so the app runs on the CPU until then. ${GPU_TOOLKIT_STEP}`);
      expect(gpuReviewText(gpuDto(RESTART), asking)).toMatch(/Docker has not restarted since .* Restart Docker \(sudo systemctl restart docker/);
    }
    expect(gpuReviewText(gpuDto(NONE))).toBe('No usable graphics card found on this machine: the app runs on the CPU. Allowing it now lets it use a card added later.');
    expect(gpuReviewText(gpuDto(NONE), false)).toBe('No usable graphics card found on this machine: the app runs on the CPU.');
    expect(gpuReviewText(failed, false)).toBe('No usable graphics card found on this machine: the app runs on the CPU.');
  });
});

// Decision 181: read-only NVIDIA driver checks (Harbor never installs, updates or removes drivers)
describe('NVIDIA driver checks (decision 181, fake host root)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const host = (files: Record<string, string>, links: Record<string, string> = {}) => {
    const root = mkdtempSync(path.join(tmpdir(), 'harbor-gpu-drv-'));
    roots.push(root);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), body);
    }
    for (const [rel, target] of Object.entries(links)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      symlinkSync(target, path.join(root, rel));
    }
    return root;
  };
  const RTX = 'NVIDIA GeForce RTX 3090';
  const PROPRIETARY = (v: string) => `NVRM version: NVIDIA UNIX x86_64 Kernel Module  ${v}  Tue Apr  8 12:39:50 UTC 2025\nGCC version:  gcc version 13.3.0 (Ubuntu 13.3.0-6ubuntu2~24.04)\n`;
  const OPEN = (v: string) => `NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  ${v}  Release Build  (dvs-builder@U16-I3-B03-4-3)  Thu Sep 18 00:00:00 UTC 2026\nGCC version:  gcc version 13.3.0\n`;
  // the card on the PCI bus (VGA controller + its HDMI audio function, which does not count)
  const PCI = {
    'sys/bus/pci/devices/0000:01:00.0/vendor': '0x10de\n',
    'sys/bus/pci/devices/0000:01:00.0/class': '0x030000\n',
    'sys/bus/pci/devices/0000:01:00.0/device': '0x2204\n',
    'sys/bus/pci/devices/0000:01:00.1/vendor': '0x10de\n',
    'sys/bus/pci/devices/0000:01:00.1/class': '0x040300\n',
    'sys/bus/pci/devices/0000:00:02.0/vendor': '0x8086\n',
    'sys/bus/pci/devices/0000:00:02.0/class': '0x060000\n',
  };
  const driver = (version: string, text = OPEN) => ({
    'proc/driver/nvidia/version': text(version),
    'proc/driver/nvidia/gpus/0000:01:00.0/information': `Model: \t\t ${RTX}\n`,
    'dev/nvidia0': '',
  });
  const lib = (version: string, dir = 'usr/lib/x86_64-linux-gnu') => ({ [`${dir}/libnvidia-ml.so.${version}`]: '', [`${dir}/libnvidia-ml.so.1`]: '', [`${dir}/libnvidia-ml.so`]: '' });
  const INTEL = { files: { 'dev/dri/renderD129': '' }, links: { 'sys/class/drm/renderD129/device/driver': '../../../bus/pci/drivers/i915' } };
  const toolkit = async () => ['nvidia', 'runc'];
  const runc = async () => ['runc'];

  it('reads the running driver from both wordings of /proc/driver/nvidia/version', () => {
    expect(parseNvidiaDriverVersion(PROPRIETARY('550.163.01'))).toBe('550.163.01');
    expect(parseNvidiaDriverVersion(OPEN('595.99.02'))).toBe('595.99.02');
    expect(parseNvidiaDriverVersion('NVRM version: NVIDIA UNIX Open Kernel Module for aarch64  580.95.05  Release Build\n')).toBe('580.95.05');
    expect(parseNvidiaDriverVersion(PROPRIETARY('470.256.02'))).toBe('470.256.02');
    expect(parseNvidiaDriverVersion('garbage\n')).toBeNull();
    expect(NVIDIA_DRIVER_MIN_MAJOR).toBe(525);
  });
  it('a card on the PCI bus with no driver loaded: none + NVIDIA_DRIVER_MISSING, named generically, even with the toolkit', async () => {
    for (const runtimes of [runc, toolkit]) {
      expect(await detectGpu({ root: host(PCI), runtimes })).toEqual({ kind: 'none', detail: 'NVIDIA graphics card', problem: 'NVIDIA_DRIVER_MISSING' });
    }
    // a 3D controller (0x0302, data-centre cards) counts too
    const tesla = host({ 'sys/bus/pci/devices/0000:3b:00.0/vendor': '0x10de\n', 'sys/bus/pci/devices/0000:3b:00.0/class': '0x030200\n' });
    expect((await detectGpu({ root: tesla, runtimes: runc })).problem).toBe('NVIDIA_DRIVER_MISSING');
    // the driver's libraries installed but no module running (not rebooted, or blocked): still missing, never "reboot"
    expect(await detectGpu({ root: host({ ...PCI, ...lib('595.99.02') }), runtimes: runc })).toEqual({ kind: 'none', detail: 'NVIDIA graphics card', problem: 'NVIDIA_DRIVER_MISSING', libraryVersion: '595.99.02' });
    // bound to nouveau (no NVIDIA driver): missing too
    expect((await detectGpu({ root: host(PCI, { 'sys/bus/pci/devices/0000:01:00.0/driver': '../../../bus/pci/drivers/nouveau' }), runtimes: runc })).problem).toBe('NVIDIA_DRIVER_MISSING');
    // only other vendors on the bus (and the NVIDIA audio function alone): no card
    expect(await detectGpu({ root: host({ 'sys/bus/pci/devices/0000:00:02.0/vendor': '0x8086\n', 'sys/bus/pci/devices/0000:00:02.0/class': '0x030000\n', 'sys/bus/pci/devices/0000:01:00.1/vendor': '0x10de\n', 'sys/bus/pci/devices/0000:01:00.1/class': '0x040300\n' }), runtimes: runc })).toEqual({ kind: 'none', detail: 'No graphics card found' });
  });
  it('matching running and installed versions, proprietary and open: usable, with both versions', async () => {
    for (const text of [PROPRIETARY, OPEN]) {
      const root = host({ ...PCI, ...driver('595.99.02', text), ...lib('595.99.02') });
      expect(await detectGpu({ root, runtimes: toolkit })).toEqual({ kind: 'nvidia', detail: RTX, driverVersion: '595.99.02', libraryVersion: '595.99.02' });
    }
    // /usr/lib64 (Fedora/RHEL) is read too
    expect((await detectGpu({ root: host({ ...driver('580.95.05'), ...lib('580.95.05', 'usr/lib64') }), runtimes: toolkit })).libraryVersion).toBe('580.95.05');
  });
  it('a card handed to a virtual machine (bound to vfio-pci or pci-stub) is not this machine\'s: no card, no driver advice', async () => {
    for (const drv of ['vfio-pci', 'pci-stub']) {
      const root = host({ ...PCI, ...lib('595.99.02') }, { 'sys/bus/pci/devices/0000:01:00.0/driver': `../../../bus/pci/drivers/${drv}` });
      expect(await detectGpu({ root, runtimes: toolkit })).toEqual({ kind: 'none', detail: 'No graphics card found' });
    }
    // a second, unbound card still counts
    const two = host({ ...PCI, 'sys/bus/pci/devices/0000:02:00.0/vendor': '0x10de\n', 'sys/bus/pci/devices/0000:02:00.0/class': '0x030000\n' }, { 'sys/bus/pci/devices/0000:01:00.0/driver': '../../../bus/pci/drivers/vfio-pci' });
    expect((await detectGpu({ root: two, runtimes: runc })).problem).toBe('NVIDIA_DRIVER_MISSING');
  });
  it('the running driver\'s library gone, another installed (apt updated the driver): NVIDIA_REBOOT_NEEDED with the newest', async () => {
    const root = host({ ...PCI, ...driver('550.163.01'), ...lib('595.99.02') });
    expect(await detectGpu({ root, runtimes: toolkit })).toEqual({ kind: 'none', detail: RTX, problem: 'NVIDIA_REBOOT_NEEDED', driverVersion: '550.163.01', libraryVersion: '595.99.02' });
    // numeric, not text order: 595.100.1 is newer than 595.99.02
    expect((await detectGpu({ root: host({ ...driver('550.163.01'), ...lib('595.99.02'), ...lib('595.100.1') }), runtimes: toolkit })).libraryVersion).toBe('595.100.1');
  });
  it('the running driver\'s library still there next to another version (a leftover .run install, a copied file): usable, never a reboot', async () => {
    for (const other of ['610.1.1', '550.163.01']) {
      const root = host({ ...PCI, ...driver('595.99.02'), ...lib('595.99.02'), ...lib(other) });
      expect(await detectGpu({ root, runtimes: toolkit })).toEqual({ kind: 'nvidia', detail: RTX, driverVersion: '595.99.02', libraryVersion: '595.99.02' });
    }
  });
  it('the installed version unknown: no reboot claim', async () => {
    expect(await detectGpu({ root: host({ ...PCI, ...driver('550.163.01') }), runtimes: toolkit })).toEqual({ kind: 'nvidia', detail: RTX, driverVersion: '550.163.01' });
  });
  it('a driver older than 525 (CUDA 12) is a note on a usable card: still handed over (CUDA 11 images, NVENC); 525 itself has none', async () => {
    expect(await detectGpu({ root: host({ ...PCI, ...driver('470.256.02', PROPRIETARY), ...lib('470.256.02') }), runtimes: toolkit })).toEqual({ kind: 'nvidia', detail: RTX, problem: 'NVIDIA_DRIVER_TOO_OLD', driverVersion: '470.256.02', libraryVersion: '470.256.02' });
    expect(await detectGpu({ root: host({ ...driver('525.60.13'), ...lib('525.60.13') }), runtimes: toolkit })).toEqual({ kind: 'nvidia', detail: RTX, driverVersion: '525.60.13', libraryVersion: '525.60.13' });
  });
  it('the order: missing driver, then reboot, then the toolkit checks (too old only notes a usable card)', async () => {
    // too old AND updated but not rebooted: the reboot finishes it
    expect((await detectGpu({ root: host({ ...PCI, ...driver('470.256.02'), ...lib('595.99.02') }), runtimes: runc })).problem).toBe('NVIDIA_REBOOT_NEEDED');
    // too old AND no toolkit: the toolkit blocks, so it is named
    expect(await detectGpu({ root: host({ ...PCI, ...driver('470.256.02'), ...lib('470.256.02') }), runtimes: runc })).toEqual({ kind: 'none', detail: RTX, problem: 'NVIDIA_TOOLKIT_MISSING', driverVersion: '470.256.02', libraryVersion: '470.256.02' });
    // a working driver: then the toolkit
    expect(await detectGpu({ root: host({ ...PCI, ...driver('595.99.02'), ...lib('595.99.02') }), runtimes: runc })).toEqual({ kind: 'none', detail: RTX, problem: 'NVIDIA_TOOLKIT_MISSING', driverVersion: '595.99.02', libraryVersion: '595.99.02' });
  });
  it('Intel graphics next to each blocking driver problem: dri, with the problem; a too-old usable card still wins', async () => {
    const cases: [Record<string, string>, string][] = [
      [PCI, 'NVIDIA_DRIVER_MISSING'],
      [{ ...PCI, ...driver('550.163.01'), ...lib('595.99.02') }, 'NVIDIA_REBOOT_NEEDED'],
    ];
    for (const [files, problem] of cases) {
      const g = await detectGpu({ root: host({ ...files, ...INTEL.files }, INTEL.links), runtimes: toolkit });
      expect(g).toMatchObject({ kind: 'dri', detail: 'Intel graphics', renderNode: 'renderD129', problem });
    }
    const old = await detectGpu({ root: host({ ...PCI, ...driver('470.256.02'), ...lib('470.256.02'), ...INTEL.files }, INTEL.links), runtimes: toolkit });
    expect(old).toEqual({ kind: 'nvidia', detail: RTX, problem: 'NVIDIA_DRIVER_TOO_OLD', driverVersion: '470.256.02', libraryVersion: '470.256.02' });
  });
  it('the dev/e2e machines for the new states', async () => {
    expect((await devGpu('driver-missing').detect()).problem).toBe('NVIDIA_DRIVER_MISSING');
    expect((await devGpu('reboot-needed').detect()).problem).toBe('NVIDIA_REBOOT_NEEDED');
    expect(await devGpu('driver-too-old').detect()).toMatchObject({ kind: 'nvidia', problem: 'NVIDIA_DRIVER_TOO_OLD' });
    expect((await devGpu('nvidia').detect()).driverVersion).toBe('595.99.02');
  });
});

describe('driver wording (decision 181)', () => {
  const m = manifestOf(GPU_MANIFEST);
  const RTX = 'NVIDIA GeForce RTX 3090';
  const USABLE: HostGpu = { kind: 'nvidia', detail: RTX, driverVersion: '595.99.02', libraryVersion: '595.99.02' };
  const NO_DRIVER: HostGpu = { kind: 'none', detail: 'NVIDIA graphics card', problem: 'NVIDIA_DRIVER_MISSING' };
  const REBOOT: HostGpu = { kind: 'none', detail: RTX, problem: 'NVIDIA_REBOOT_NEEDED', driverVersion: '550.163.01', libraryVersion: '595.99.02' };
  const OLD: HostGpu = { kind: 'nvidia', detail: RTX, problem: 'NVIDIA_DRIVER_TOO_OLD', driverVersion: '470.256.02', libraryVersion: '470.256.02' };
  const NOT_LOADED: HostGpu = { kind: 'none', detail: 'NVIDIA graphics card', problem: 'NVIDIA_DRIVER_MISSING', libraryVersion: '595.99.02' };
  const OLD_NOTE = 'the NVIDIA driver is older than 525, so apps built on CUDA 12 or newer (like Ollama) cannot use the card';
  const NO_TOOLKIT: HostGpu = { kind: 'none', detail: RTX, problem: 'NVIDIA_TOOLKIT_MISSING', driverVersion: '595.99.02' };
  const INTEL_REBOOT: HostGpu = { kind: 'dri', detail: 'Intel graphics', renderNode: 'renderD128', renderGid: 992, problem: 'NVIDIA_REBOOT_NEEDED', driverVersion: '550.163.01', libraryVersion: '595.99.02' };

  it('the DTO carries both versions (never group ids)', () => {
    expect(gpuDto(USABLE)).toEqual({ kind: 'nvidia', detail: RTX, driverVersion: '595.99.02', libraryVersion: '595.99.02' });
    expect(gpuDto(INTEL_REBOOT)).toEqual({ kind: 'dri', detail: 'Intel graphics', problem: 'NVIDIA_REBOOT_NEEDED', driverVersion: '550.163.01', libraryVersion: '595.99.02' });
  });
  it('plan lines stay short (no version on a working card) and say the next step for each problem', () => {
    expect(gpuChanges(m, USABLE)).toEqual([`Use the ${RTX} (GPU) for web`]);
    expect(gpuChanges(m, NO_DRIVER)).toEqual([`An NVIDIA graphics card is in this machine, but the NVIDIA driver is not running: web runs on the CPU until then (${DRIVER_INSTALL_NEXT_STEP})`]);
    expect(gpuChanges(m, REBOOT)).toEqual([`An NVIDIA graphics card is in this machine, but the machine has not restarted since the NVIDIA driver update (595.99.02 installed, 550.163.01 running): web runs on the CPU until then (${DRIVER_REBOOT_NEXT_STEP})`]);
    expect(gpuChanges(m, OLD)).toEqual([`Use the ${RTX} (GPU) for web (but ${OLD_NOTE}: ${DRIVER_UPDATE_NEXT_STEP})`]);
    expect(gpuChanges(m, NOT_LOADED)).toEqual([`An NVIDIA graphics card is in this machine, but the NVIDIA driver is installed but not running: web runs on the CPU until then (${DRIVER_LOAD_NEXT_STEP})`]);
    expect(gpuChanges(m, INTEL_REBOOT)[0]).toBe(`Use Intel graphics for web (an NVIDIA card is also in this machine, but the machine has not restarted since the NVIDIA driver update (595.99.02 installed, 550.163.01 running): ${DRIVER_REBOOT_NEXT_STEP})`);
    expect(DRIVER_INSTALL_NEXT_STEP).toBe('Install the NVIDIA driver (sudo ubuntu-drivers install), then restart the machine');
    expect(DRIVER_REBOOT_NEXT_STEP).toBe('Restart the machine to finish the NVIDIA driver update');
    expect(DRIVER_UPDATE_NEXT_STEP).toBe('To run them, update the NVIDIA driver to 525 or newer if the card supports it (sudo ubuntu-drivers install), then restart the machine');
    expect(DRIVER_LOAD_NEXT_STEP).toBe('Restart the machine to load it; if it still does not run, Secure Boot may be blocking it (Operator Guide, GPU → Drivers)');
  });
  it('harbor gpu / the plan GPU line name the driver of a working card', () => {
    expect(gpuFact(USABLE)).toBe(`${RTX} (driver 595.99.02, ready for apps)`);
    expect(gpuFact(NO_TOOLKIT)).toMatch(/^NVIDIA GeForce RTX 3090 \(driver 595\.99\.02\) found, but the NVIDIA container toolkit is not installed/);
    expect(gpuFact(NO_DRIVER)).toBe(`NVIDIA graphics card found, but the NVIDIA driver is not running: runs on the CPU until then (${DRIVER_INSTALL_NEXT_STEP})`);
    expect(gpuFact(REBOOT)).toBe(`${RTX} found, but the machine has not restarted since the NVIDIA driver update (595.99.02 installed, 550.163.01 running): runs on the CPU until then (${DRIVER_REBOOT_NEXT_STEP})`);
    expect(gpuFact(OLD)).toBe(`${RTX} (driver 470.256.02, ready for apps), but ${OLD_NOTE} (${DRIVER_UPDATE_NEXT_STEP})`);
    expect(gpuFact(NOT_LOADED)).toBe(`NVIDIA graphics card found, but the NVIDIA driver is installed but not running: runs on the CPU until then (${DRIVER_LOAD_NEXT_STEP})`);
    expect(gpuFact(gpuDto(INTEL_REBOOT))).toBe(`Intel graphics; an NVIDIA card is also here, but the machine has not restarted since the NVIDIA driver update (595.99.02 installed, 550.163.01 running) (${DRIVER_REBOOT_NEXT_STEP})`);
  });
  it('harbor inspect', () => {
    expect(gpuStatusLine({ ...gpuDto(USABLE), inUse: true })).toBe(`${RTX} (driver 595.99.02, in use)`);
    expect(gpuStatusLine({ ...gpuDto(USABLE), inUse: false })).toBe(`${RTX} (driver 595.99.02) found; restart the app to use it`);
    expect(gpuStatusLine({ ...gpuDto(NO_DRIVER), inUse: false })).toBe(`NVIDIA graphics card found, but the NVIDIA driver is not running — runs on the CPU. ${DRIVER_INSTALL_NEXT_STEP}.`);
    expect(gpuStatusLine({ ...gpuDto(OLD), inUse: true })).toBe(`${RTX} (driver 470.256.02, in use), but ${OLD_NOTE}. ${DRIVER_UPDATE_NEXT_STEP}.`);
    expect(gpuStatusLine({ ...gpuDto(OLD), inUse: false })).toBe(`${RTX} (driver 470.256.02) found; restart the app to use it, but ${OLD_NOTE}. ${DRIVER_UPDATE_NEXT_STEP}.`);
    // a driver update waiting for a reboot while the containers still have the card: in use, not "runs on the CPU"
    expect(gpuStatusLine({ ...gpuDto(REBOOT), inUse: true })).toBe(`${RTX} (in use), but the machine has not restarted since the NVIDIA driver update (595.99.02 installed, 550.163.01 running). ${DRIVER_REBOOT_NEXT_STEP}; until then, restarting the app moves it to the CPU.`);
    expect(gpuStatusLine({ ...gpuDto(REBOOT), inUse: false })).toContain('— runs on the CPU');
    expect(gpuStatusLine({ ...gpuDto(INTEL_REBOOT), inUse: true })).toBe(`Intel graphics (in use). An NVIDIA card is also in this machine, but the machine has not restarted since the NVIDIA driver update (595.99.02 installed, 550.163.01 running). ${DRIVER_REBOOT_NEXT_STEP}.`);
  });
  it('the console: Settings → Overview, the app page and the review', () => {
    expect(gpuMachineText(gpuDto(USABLE))).toBe(`${RTX} (driver 595.99.02)`);
    expect(gpuMachineText(gpuDto(NO_TOOLKIT))).toBe(`${RTX} (driver 595.99.02) · the NVIDIA container toolkit is not installed (Operator Guide → GPU)`);
    expect(gpuMachineText(gpuDto(NO_DRIVER))).toBe('NVIDIA graphics card · the NVIDIA driver is not running (Operator Guide → GPU)');
    expect(gpuMachineText(gpuDto(REBOOT))).toBe(`${RTX} · the machine has not restarted since the NVIDIA driver update (595.99.02 installed, 550.163.01 running) (Operator Guide → GPU)`);
    expect(gpuMachineText(gpuDto(OLD))).toBe(`${RTX} (driver 470.256.02) · ${OLD_NOTE} (Operator Guide → GPU)`);
    expect(gpuMachineText(gpuDto(NOT_LOADED))).toBe('NVIDIA graphics card · the NVIDIA driver is installed but not running (Operator Guide → GPU)');
    expect(gpuMachineText(gpuDto(INTEL_REBOOT))).toBe('Intel graphics · an NVIDIA card is also here, but the machine has not restarted since the NVIDIA driver update (595.99.02 installed, 550.163.01 running) (Operator Guide → GPU)');
    expect(gpuAppText({ ...gpuDto(USABLE), inUse: true })).toBe(`${RTX} (driver 595.99.02, in use)`);
    expect(gpuAppText({ ...gpuDto(USABLE), inUse: false })).toBe(`${RTX} (driver 595.99.02) found · restart the app to use it`);
    expect(gpuAppText({ ...gpuDto(NO_DRIVER), inUse: false })).toBe(`NVIDIA graphics card found, but the NVIDIA driver is not running · runs on the CPU. ${GPU_DRIVER_INSTALL_STEP}`);
    expect(gpuAppText({ ...gpuDto(REBOOT), inUse: false })).toBe(`${RTX} found, but the machine has not restarted since the NVIDIA driver update (595.99.02 installed, 550.163.01 running) · runs on the CPU. ${GPU_DRIVER_REBOOT_STEP}`);
    expect(gpuAppText({ ...gpuDto(OLD), inUse: true })).toBe(`${RTX} (driver 470.256.02, in use) · ${OLD_NOTE}. ${GPU_DRIVER_UPDATE_STEP}`);
    expect(gpuAppText({ ...gpuDto(NOT_LOADED), inUse: false })).toBe(`NVIDIA graphics card found, but the NVIDIA driver is installed but not running · runs on the CPU. ${GPU_DRIVER_LOAD_STEP}`);
    expect(gpuAppText({ ...gpuDto(REBOOT), inUse: true })).toBe(`${RTX} (in use) · the machine has not restarted since the NVIDIA driver update (595.99.02 installed, 550.163.01 running). ${GPU_DRIVER_REBOOT_STEP} Until then, restarting the app moves it to the CPU.`);
    expect(gpuAppText({ ...gpuDto(INTEL_REBOOT), inUse: true })).toBe(`Intel graphics (in use) · an NVIDIA card is also here, but the machine has not restarted since the NVIDIA driver update (595.99.02 installed, 550.163.01 running). ${GPU_DRIVER_REBOOT_STEP}`);
    // the review stays short: no version for a working card
    expect(gpuReviewText(gpuDto(USABLE))).toBe(`This machine has an ${RTX}: the app uses it.`);
    expect(gpuReviewText(gpuDto(NO_DRIVER))).toBe(`This machine has an NVIDIA graphics card, but the NVIDIA driver is not running, so the app runs on the CPU until then. ${GPU_DRIVER_INSTALL_STEP}`);
    expect(gpuReviewText(gpuDto(OLD), false)).toBe(`This machine has an ${RTX}: the app uses it, but ${OLD_NOTE}. ${GPU_DRIVER_UPDATE_STEP}`);
    expect(GPU_DRIVER_LOAD_STEP).toBe('Restart the machine to load it. If it still does not run, Secure Boot may be blocking it (Operator Guide → GPU → Drivers).');
    expect(gpuReviewText(gpuDto(INTEL_REBOOT))).toBe(`This machine has Intel graphics (the app uses it) and an NVIDIA card it cannot use yet: the machine has not restarted since the NVIDIA driver update (595.99.02 installed, 550.163.01 running). ${GPU_DRIVER_REBOOT_STEP}`);
    // versions unknown: still a sentence
    expect(gpuAppText({ kind: 'none', detail: RTX, problem: 'NVIDIA_REBOOT_NEEDED', inUse: false })).toContain('the machine has not restarted since the NVIDIA driver update · runs on the CPU');
    expect(gpuMachineText({ kind: 'nvidia', detail: RTX, problem: 'NVIDIA_DRIVER_TOO_OLD' })).toBe(`${RTX} · ${OLD_NOTE} (Operator Guide → GPU)`);
  });
});
