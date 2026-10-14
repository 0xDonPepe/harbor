// Decision 180: app settings end to end with the fake engine. Install with defaults or with values chosen in the
// review; values reach the runtime environment and the app's DTO; configure changes one and re-renders; remove +
// reinstall keeps the overrides, a full uninstall deletes them; an update adds, drops and resets settings.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { InstanceSummary, PackageImportResultDto, PlanDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const REV1_SETTINGS = `settings:
  - id: context-length
    label: "Context length (tokens)"
    help: "How much text a model keeps in mind."
    type: integer
    default: 8192
    min: 2048
    max: 131072
    bindings:
      - {service: web, environment: OLLAMA_CONTEXT_LENGTH}
  - id: flash-attention
    label: "Flash attention"
    type: boolean
    default: false
    onValue: "1"
    offValue: "0"
    bindings:
      - {service: web, environment: OLLAMA_FLASH_ATTENTION}
  - id: kv-cache
    label: "Memory cache precision"
    type: choice
    default: f16
    choices: [{value: f16}, {value: q8_0}, {value: q4_0}]
    bindings:
      - {service: web, environment: OLLAMA_KV_CACHE_TYPE}
`;
// revision 2: context-length allows less, flash-attention is gone, parallel is new
const REV2_SETTINGS = `settings:
  - id: context-length
    label: "Context length (tokens)"
    type: integer
    default: 8192
    min: 2048
    max: 32768
    bindings:
      - {service: web, environment: OLLAMA_CONTEXT_LENGTH}
  - id: kv-cache
    label: "Memory cache precision"
    type: choice
    default: f16
    choices: [{value: f16}, {value: q8_0}, {value: q4_0}]
    bindings:
      - {service: web, environment: OLLAMA_KV_CACHE_TYPE}
  - id: parallel
    label: "Parallel requests"
    type: integer
    default: 1
    min: 1
    max: 8
    bindings:
      - {service: web, environment: OLLAMA_NUM_PARALLEL}
`;
const manifest = (id: string, rev: string, settings: string) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: Model ${id}
  description: A local model server
release:
  revision: "${rev}"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
${settings}`;
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27-alpine\n';
const upload = (id: string, rev: string, settings: string) =>
  h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: `${id}.zip`, dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest(id, rev, settings), 'compose.yaml': COMPOSE }, { folder: id }).toString('base64')}` });
const submit = (planId: string, body: Record<string, unknown> = {}) => h.api.json<{ operationId: string; error?: { code: string; message: string; nextAction: string } }>('POST', '/v1/operations', { planId, ...body }, { 'idempotency-key': `key-${Math.random().toString(36).slice(2, 12)}` });
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name) as InstanceSummary;
const env = (id: string) => parseYaml(readFileSync(path.join(h.stateDir, 'instances', id, 'runtime', 'compose.yaml'), 'utf8')).services.web.environment as Record<string, string>;
const settingsFile = (id: string) => path.join(h.stateDir, 'instances', id, 'settings.json');
const stored = (id: string) => (existsSync(settingsFile(id)) ? (JSON.parse(readFileSync(settingsFile(id), 'utf8')) as { values: Record<string, unknown> }).values : null);
const valueOf = (i: InstanceSummary, id: string) => i.settings?.find((s) => s.id === id);

describe('app settings (decision 180)', () => {
  let plain: InstanceSummary;
  let tuned: InstanceSummary;

  it('install with the defaults: the plan asks about every setting, the app runs with the defaults, nothing is stored', async () => {
    await upload('llm', '1', REV1_SETTINGS);
    const plan = await h.api.plan({ kind: 'install', packageId: 'llm' });
    expect(plan.settings?.map((s) => [s.id, s.ask, s.change, s.value])).toEqual([
      ['context-length', true, 'new', 8192],
      ['flash-attention', true, 'new', false],
      ['kv-cache', true, 'new', 'f16'],
    ]);
    expect(plan.changes.some((c) => c.startsWith('Apply its 3 settings (Context length (tokens): 8192, Flash attention: off, Memory cache precision: f16)'))).toBe(true);
    const ok = await submit(plan.id);
    const op = await h.api.waitOperation(ok.body.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    plain = await byName(plan.name);
    expect(env(plain.id)).toEqual({ OLLAMA_CONTEXT_LENGTH: '8192', OLLAMA_FLASH_ATTENTION: '0', OLLAMA_KV_CACHE_TYPE: 'f16' });
    expect(stored(plain.id)).toBeNull();
    expect(plain.settings?.map((s) => [s.id, s.value, s.overridden])).toEqual([
      ['context-length', 8192, false],
      ['flash-attention', false, false],
      ['kv-cache', 'f16', false],
    ]);
    expect(valueOf(plain, 'context-length')).toMatchObject({ label: 'Context length (tokens)', help: 'How much text a model keeps in mind.', type: 'integer', min: 2048, max: 131072, default: 8192 });
  });

  it('a value that is not allowed is refused at submission with SETTING_INVALID (400), before anything starts', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'llm' });
    const tooBig = await submit(plan.id, { settings: { 'context-length': 999999 } });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error?.code).toBe('SETTING_INVALID');
    expect(tooBig.body.error?.message).toBe('Context length (tokens) (setting context-length) must be a whole number from 2048 to 131072');
    const unknown = await submit(plan.id, { settings: { temperature: 1 } });
    expect(unknown.body.error?.code).toBe('SETTING_INVALID');
    expect(unknown.body.error?.message).toContain('does not ask for setting temperature');
    const wrongType = await submit(plan.id, { settings: { 'flash-attention': 'yes' } });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error?.code).toBe('SETTING_INVALID');
    expect((await h.api.instances()).some((i) => i.id === plan.instanceId)).toBe(false);
  });

  it('install with values chosen in the review: stored (only the overrides), rendered, shown on the app', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'llm' });
    const ok = await submit(plan.id, { settings: { 'context-length': 65536, 'flash-attention': true, 'kv-cache': 'f16' } });
    expect(ok.status).toBe(202);
    const op = await h.api.waitOperation(ok.body.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const messages = op.events.map((e) => e.message);
    expect(messages).toContain('with the settings you chose: Context length (tokens): 65536, Flash attention: on, Memory cache precision: f16');
    expect(messages).toContain('stored the settings: Context length (tokens) = 65536; Flash attention = on');
    tuned = await byName(plan.name);
    expect(stored(tuned.id)).toEqual({ 'context-length': 65536, 'flash-attention': true });
    expect(statSync(settingsFile(tuned.id)).mode & 0o777).toBe(0o644);
    expect(env(tuned.id)).toEqual({ OLLAMA_CONTEXT_LENGTH: '65536', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'f16' });
    expect(tuned.settings?.map((s) => [s.id, s.value, s.overridden])).toEqual([
      ['context-length', 65536, true],
      ['flash-attention', true, true],
      ['kv-cache', 'f16', false],
    ]);
  });

  it('configure changes one setting: the plan says "old -> new", the runner re-renders and recreates', async () => {
    const plan = await h.api.plan({ kind: 'configure', instanceId: tuned.id, settings: { 'kv-cache': 'q8_0' } });
    expect(plan.changes).toContain('Memory cache precision: f16 -> q8_0');
    expect(plan.settings?.map((s) => [s.id, s.change, s.previous, s.value, s.ask])).toEqual([['kv-cache', 'set', 'f16', 'q8_0', false]]);
    const sub = await h.api.submit(plan.id);
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(op.events.map((e) => e.message)).toContain('stored the settings: Memory cache precision = q8_0');
    expect(env(tuned.id)['OLLAMA_KV_CACHE_TYPE']).toBe('q8_0');
    expect(env(tuned.id)['OLLAMA_CONTEXT_LENGTH']).toBe('65536');
    expect(stored(tuned.id)).toEqual({ 'context-length': 65536, 'flash-attention': true, 'kv-cache': 'q8_0' });
    expect(valueOf(await byName(tuned.name), 'kv-cache')).toMatchObject({ value: 'q8_0', overridden: true });
  });

  it('configure back to the default removes the override; the same value again is nothing to change; a bad one is refused', async () => {
    const { plan, op } = await h.api.run({ kind: 'configure', instanceId: tuned.id, settings: { 'flash-attention': false } });
    expect(plan.changes).toContain('Flash attention: on -> off (back to the default)');
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(stored(tuned.id)).toEqual({ 'context-length': 65536, 'kv-cache': 'q8_0' });
    expect(env(tuned.id)['OLLAMA_FLASH_ATTENTION']).toBe('0');
    const same = await h.api.json<{ error: { code: string; message: string } }>('POST', '/v1/plans', { kind: 'configure', instanceId: tuned.id, settings: { 'kv-cache': 'q8_0' } });
    expect(same.status).toBe(422);
    expect(same.body.error.message).toBe('nothing to change: that setting already has this value');
    const bad = await h.api.json<{ error: { code: string; message: string } }>('POST', '/v1/plans', { kind: 'configure', instanceId: tuned.id, settings: { 'kv-cache': 'q2_K' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('SETTING_INVALID');
    const unknown = await h.api.json<{ error: { code: string; message: string } }>('POST', '/v1/plans', { kind: 'configure', instanceId: tuned.id, settings: { temperature: 1 } });
    expect(unknown.body.error.code).toBe('SETTING_INVALID');
    expect(unknown.body.error.message).toBe('this app has no setting temperature');
  });

  it('a Restart keeps the values (every render reads them)', async () => {
    const { op } = await h.api.run({ kind: 'restart', instanceId: tuned.id });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(env(tuned.id)).toEqual({ OLLAMA_CONTEXT_LENGTH: '65536', OLLAMA_FLASH_ATTENTION: '0', OLLAMA_KV_CACHE_TYPE: 'q8_0' });
  });

  it('remove keeps the overrides and Reinstall uses them again', async () => {
    expect((await h.api.run({ kind: 'remove', instanceId: tuned.id })).op.state).toBe('succeeded');
    expect(stored(tuned.id)).toEqual({ 'context-length': 65536, 'kv-cache': 'q8_0' });
    expect((await h.api.run({ kind: 'reinstall', instanceId: tuned.id })).op.state).toBe('succeeded');
    expect(env(tuned.id)).toEqual({ OLLAMA_CONTEXT_LENGTH: '65536', OLLAMA_FLASH_ATTENTION: '0', OLLAMA_KV_CACHE_TYPE: 'q8_0' });
    expect(valueOf(await byName(tuned.name), 'context-length')).toMatchObject({ value: 65536, overridden: true });
  });

  it('an update: the new setting is asked (and only it), a dropped one goes, a value the release no longer allows is reset', async () => {
    await upload('llm', '2', REV2_SETTINGS);
    const plan: PlanDto = await h.api.plan({ kind: 'update', instanceId: tuned.id });
    expect(plan.settings?.map((s) => [s.id, s.change, s.ask, s.previous])).toEqual([
      ['context-length', 'reset', false, 65536],
      ['parallel', 'new', true, null],
      ['flash-attention', 'dropped', false, null],
    ]);
    expect(plan.changes).toContain('Context length (tokens): your value 65536 is not allowed by this release (it takes a whole number from 2048 to 32768); it goes back to the default 8192');
    expect(plan.changes).toContain('New setting Parallel requests: 1 (the default; change it under Options or later on the app page)');
    expect(plan.changes).toContain('Setting Flash attention is no longer part of this release');
    // only the setting the update adds can be chosen here
    const kept = await submit(plan.id, { settings: { 'kv-cache': 'q4_0' } });
    expect(kept.body.error?.code).toBe('SETTING_INVALID');
    const ok = await submit(plan.id, { settings: { parallel: 4 } });
    const op = await h.api.waitOperation(ok.body.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(stored(tuned.id)).toEqual({ 'kv-cache': 'q8_0', parallel: 4 });
    expect(env(tuned.id)).toEqual({ OLLAMA_CONTEXT_LENGTH: '8192', OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_NUM_PARALLEL: '4' });
    expect((await byName(tuned.name)).settings?.map((s) => [s.id, s.value, s.overridden])).toEqual([
      ['context-length', 8192, false],
      ['kv-cache', 'q8_0', true],
      ['parallel', 4, true],
    ]);
  });

  it('an update nobody reviews (no values) gives new settings their default and keeps flowing', async () => {
    const plan = await h.api.plan({ kind: 'update', instanceId: plain.id });
    expect(plan.settings?.find((s) => s.id === 'parallel')).toMatchObject({ change: 'new', ask: true });
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(stored(plain.id)).toBeNull();
    expect(env(plain.id)).toEqual({ OLLAMA_CONTEXT_LENGTH: '8192', OLLAMA_KV_CACHE_TYPE: 'f16', OLLAMA_NUM_PARALLEL: '1' });
  });

  it('a full uninstall deletes the stored values with the rest of the instance directory', async () => {
    expect((await h.api.run({ kind: 'purge', instanceId: tuned.id })).op.state).toBe('succeeded');
    expect(existsSync(settingsFile(tuned.id))).toBe(false);
  });

  it('an app whose package has no settings carries none', async () => {
    await upload('plain-app', '1', '');
    const plan = await h.api.plan({ kind: 'install', packageId: 'plain-app' });
    expect(plan.settings).toBeUndefined();
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state).toBe('succeeded');
    expect((await byName(plan.name)).settings).toBeUndefined();
  });
});
