// Decision 179: the `gpu` permission end to end with the fake engine and an injected GpuObserver. The review
// lists it and needs the operator's yes; the plan records what the machine has; the runtime Compose gets the
// NVIDIA device request (or nothing on a CPU-only machine); a toolkit installed later is used by the next Restart;
// an update that adds gpu never applies by itself.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { InstanceDetail, InstanceSummary, PackageImportResultDto, PlanDto, SystemHostDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { FakeGpu } from '../../src/system/gpu.js';
import { startHarness, type Harness } from './harness.js';

const gpu = new FakeGpu();
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ overrides: { gpu } });
});
afterAll(async () => h.close());

const manifest = (id: string, rev: string, perms: string | null) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: Model ${id}
  description: A local model server
release:
  revision: "${rev}"
deployment:
  compose: compose.yaml
  multiInstance: false
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary
${perms ? `permissions:\n  web: [${perms}]\n` : ''}health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
`;
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27-alpine\n';
const upload = (id: string, rev: string, perms: string | null) =>
  h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: `${id}.zip`, dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest(id, rev, perms), 'compose.yaml': COMPOSE }, { folder: id }).toString('base64')}` });
const submit = (planId: string, body: Record<string, unknown> = {}) => h.api.json<{ operationId: string; error?: { code: string; message: string } }>('POST', '/v1/operations', { planId, ...body }, { 'idempotency-key': `key-${Math.random().toString(36).slice(2, 12)}` });
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name) as InstanceSummary;
const runtime = (id: string) => parseYaml(readFileSync(path.join(h.stateDir, 'instances', id, 'runtime', 'compose.yaml'), 'utf8'));
const detail = (id: string) => h.api.expect<InstanceDetail>(200, 'GET', `/v1/instances/${id}`);

describe('the gpu permission (decision 179)', () => {
  let app: InstanceSummary;

  it('on a machine with no graphics card: the review lists gpu, says it runs on the CPU, and waits for the yes', async () => {
    gpu.facts = { kind: 'none', detail: 'No graphics card found' };
    await upload('llm', '1', 'gpu');
    const plan = await h.api.plan({ kind: 'install', packageId: 'llm' });
    expect(plan.permissions).toEqual([{ service: 'web', permission: 'gpu', label: "Use this machine's graphics card (GPU)" }]);
    expect(plan.gpu).toEqual({ kind: 'none', detail: 'No graphics card found' });
    expect(plan.changes).toContain('No usable graphics card found: web runs on the CPU');
    const refused = await submit(plan.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe('PERMISSION_REQUIRED');
    expect(refused.body.error?.message).toContain('web gpu');
    const ok = await submit(plan.id, { acceptPermissions: true });
    const op = await h.api.waitOperation(ok.body.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    app = await byName(plan.name);
    const web = runtime(app.id).services.web;
    expect(web.deploy).toBeUndefined();
    expect(web.devices).toBeUndefined();
    expect((await detail(app.id)).gpu).toEqual({ kind: 'none', detail: 'No graphics card found', inUse: false });
  });

  it('an NVIDIA card without the toolkit reaches the app page and the machine facts as an informational problem', async () => {
    gpu.facts = { kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_TOOLKIT_MISSING' };
    expect((await detail(app.id)).gpu).toEqual({ kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_TOOLKIT_MISSING', inUse: false });
    const host = await h.api.expect<SystemHostDto>(200, 'GET', '/v1/system/host');
    expect(host.gpu).toEqual({ kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_TOOLKIT_MISSING' });
    // the plan says what to do, and is still allowed (not a refusal)
    const plan = await h.api.plan({ kind: 'restart', instanceId: app.id });
    expect(plan.kind).toBe('restart');
  });

  it('once the toolkit is installed, the app page says found, and Restart hands the card over', async () => {
    gpu.facts = { kind: 'nvidia', detail: 'NVIDIA GeForce RTX 3090' };
    expect((await detail(app.id)).gpu).toEqual({ kind: 'nvidia', detail: 'NVIDIA GeForce RTX 3090', inUse: false });
    const { op } = await h.api.run({ kind: 'restart', instanceId: app.id });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(op.events.map((e) => e.message)).toContain('Use the NVIDIA GeForce RTX 3090 (GPU) for web');
    expect(runtime(app.id).services.web.deploy).toEqual({ resources: { reservations: { devices: [{ driver: 'nvidia', count: 'all', capabilities: ['gpu', 'compute', 'utility'] }] } } });
    expect((await detail(app.id)).gpu).toEqual({ kind: 'nvidia', detail: 'NVIDIA GeForce RTX 3090', inUse: true });
    expect((await h.api.expect<SystemHostDto>(200, 'GET', '/v1/system/host')).gpu).toEqual({ kind: 'nvidia', detail: 'NVIDIA GeForce RTX 3090' });
  });

  it('an install plan on an NVIDIA machine records the card', async () => {
    await upload('llm-two', '1', 'gpu');
    const plan = await h.api.plan({ kind: 'install', packageId: 'llm-two' });
    expect(plan.gpu).toEqual({ kind: 'nvidia', detail: 'NVIDIA GeForce RTX 3090' });
    expect(plan.changes).toContain('Use the NVIDIA GeForce RTX 3090 (GPU) for web');
  });

  it('an app that does not ask for gpu gets no gpu facts anywhere', async () => {
    await upload('plain', '1', null);
    const plan = await h.api.plan({ kind: 'install', packageId: 'plain' });
    expect(plan.gpu).toBeUndefined();
    expect(plan.permissions).toEqual([]);
    const ok = await submit(plan.id);
    expect((await h.api.waitOperation(ok.body.operationId)).state).toBe('succeeded');
    const plain = await byName(plan.name);
    expect((await detail(plain.id)).gpu).toBeUndefined();
    expect(runtime(plain.id).services.web.deploy).toBeUndefined();
  });

  it('an update that adds gpu asks for it, never applies by itself, and renders the card once accepted', async () => {
    const plain = await byName('plain');
    await upload('plain', '2', 'gpu');
    const plan: PlanDto = await h.api.plan({ kind: 'update', instanceId: plain.id });
    expect(plan.permissions.map((p) => p.permission)).toEqual(['gpu']);
    expect(plan.gpu?.kind).toBe('nvidia');
    const all = await h.api.expect<{ started: unknown[]; skipped: { name: string; reason: string }[] }>(200, 'POST', '/v1/updates/apply-all', {});
    expect(all.started).toEqual([]);
    expect(all.skipped.find((s) => s.name === plain.name)?.reason).toMatch(/permission/i);
    const refused = await submit(plan.id);
    expect(refused.body.error?.code).toBe('PERMISSION_REQUIRED');
    const ok = await submit(plan.id, { acceptPermissions: true });
    const op = await h.api.waitOperation(ok.body.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(runtime(plain.id).services.web.deploy.resources.reservations.devices[0].driver).toBe('nvidia');
  });

  it('an update of an app that already has gpu needs no new yes', async () => {
    const plain = await byName('plain');
    await upload('plain', '3', 'gpu');
    const plan = await h.api.plan({ kind: 'update', instanceId: plain.id });
    expect(plan.permissions).toEqual([]);
    expect(plan.gpu?.kind).toBe('nvidia');
    const ok = await submit(plan.id);
    expect((await h.api.waitOperation(ok.body.operationId)).state).toBe('succeeded');
  });

  it('Intel/AMD graphics: only the render node and its group', async () => {
    gpu.facts = { kind: 'dri', detail: 'Intel graphics', renderNode: 'renderD128', renderGid: 992 };
    const { op } = await h.api.run({ kind: 'restart', instanceId: app.id });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const web = runtime(app.id).services.web;
    expect(web.devices).toEqual(['/dev/dri/renderD128:/dev/dri/renderD128']);
    expect(web.group_add).toEqual(['992']);
    expect(web.deploy).toBeUndefined();
    const d = await detail(app.id);
    expect(d.gpu).toEqual({ kind: 'dri', detail: 'Intel graphics', inUse: true });
    expect(JSON.stringify(d)).not.toContain('992'); // group ids stay out of DTOs
    expect(JSON.stringify(d)).not.toContain('renderD128'); // and device paths
  });

  it('in use only when the containers have the card found now: a toolkit installed later says restart, and Restart switches', async () => {
    // Intel graphics in use, an NVIDIA card next to it without the toolkit
    gpu.facts = { kind: 'dri', detail: 'Intel graphics', renderNode: 'renderD128', renderGid: 992, problem: 'NVIDIA_TOOLKIT_MISSING' };
    expect((await detail(app.id)).gpu).toEqual({ kind: 'dri', detail: 'Intel graphics', problem: 'NVIDIA_TOOLKIT_MISSING', inUse: true });
    // the toolkit is installed and Docker restarted: the file still hands over the Intel node, so not "in use"
    gpu.facts = { kind: 'nvidia', detail: 'NVIDIA GeForce RTX 3090' };
    expect((await detail(app.id)).gpu).toEqual({ kind: 'nvidia', detail: 'NVIDIA GeForce RTX 3090', inUse: false });
    const { op } = await h.api.run({ kind: 'restart', instanceId: app.id });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(runtime(app.id).services.web.devices).toBeUndefined();
    expect((await detail(app.id)).gpu).toEqual({ kind: 'nvidia', detail: 'NVIDIA GeForce RTX 3090', inUse: true });
    // the toolkit removed again: the file still asks for NVIDIA, which is not what the machine offers now
    gpu.facts = { kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_TOOLKIT_MISSING' };
    expect((await detail(app.id)).gpu).toEqual({ kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_TOOLKIT_MISSING', inUse: false });
  });

  it('the toolkit installed but Docker not restarted yet: no device request (it would fail to start), the step says restart Docker', async () => {
    gpu.facts = { kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_DOCKER_RESTART_NEEDED' };
    const { op } = await h.api.run({ kind: 'restart', instanceId: app.id });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(runtime(app.id).services.web.deploy).toBeUndefined();
    expect(op.events.map((e) => e.message).join('\n')).toMatch(/Docker has not restarted since the NVIDIA container toolkit was installed: web runs on the CPU until then \(Restart Docker/);
    expect((await detail(app.id)).gpu).toEqual({ kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_DOCKER_RESTART_NEEDED', inUse: false });
  });
});
