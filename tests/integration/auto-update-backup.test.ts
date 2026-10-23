import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppBackupsDto, BackupTargetDto, InstanceSummary, PackageImportResultDto } from '../../src/contracts/api.js';
import { FakeBackupEngine } from '../../src/backups/engine.js';
import { writeZip } from '../../src/packages/zip.js';
import { startHarness, type Harness } from './harness.js';

// Decision 176: an app that backs up somewhere gets a fresh restore point before an automatic update; a
// failed backup holds the update (and says so) instead of updating without one. Attempts survive a restart.
const engine = new FakeBackupEngine();
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ overrides: { backupEngine: engine } });
});
afterAll(async () => h.close());

const manifest = (rev: string) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: notes
  name: Notes
  description: A tiny web page
release:
  revision: "${rev}"
  version: "1.${rev}.0"
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
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
storage:
  - id: data
    composeVolume: data
    purpose: Notes
    retention: retain
presentation:
  tagline: Says hello
  category: developer
`;
const compose = (image: string) => `services:\n  web:\n    image: ${image}\n    volumes:\n      - {type: volume, source: data, target: /data}\nvolumes:\n  data: {}\n`;
const upload = (rev: string, image: string) =>
  h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: `notes-${rev}.zip`, dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest(rev), 'compose.yaml': compose(image) }).toString('base64')}` });
const notes = async () => (await h.api.instances()).find((i) => i.name === 'notes')!;
const runs = async (id: string) => (await h.api.expect<AppBackupsDto>(200, 'GET', `/v1/instances/${id}/backups`)).runs;
const notifications = async () => (await h.api.expect<{ items: { kind: string; title: string; body: string }[] }>(200, 'GET', '/v1/notifications')).items;
const waitFor = async (fn: () => Promise<boolean>, ms = 20000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 300));
  }
};

describe('automatic updates back the app up first (decision 176)', () => {
  let inst: InstanceSummary;
  let target: BackupTargetDto;

  it('setup: an encrypted app that backs up to a place, with automatic updates on', async () => {
    target = (await h.api.expect<{ target: BackupTargetDto }>(200, 'POST', '/v1/backups/targets', { packageId: 'folder', name: 'USB backup', values: { path: '/mnt/backup/harbor' } })).target;
    await upload('1', 'nginx:1.27-alpine');
    const r = await h.api.run({ kind: 'install', packageId: 'notes', location: { dir: path.join(h.userDataDir, 'harbor-apps', 'notes') } });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    inst = await notes();
    await h.api.expect(200, 'PUT', `/v1/instances/${inst.id}/backups`, { enabled: true, targets: [target.id] });
    await h.api.expect(200, 'PUT', `/v1/instances/${inst.id}/auto-update`, { enabled: true });
    expect(inst.version).toBe('1.1.0');
  });

  it('a failed backup holds the update and says why; the update is not marked as tried', async () => {
    engine.failWith = { op: 'backup', message: 'the place is full' };
    await upload('2', 'nginx:1.28-alpine');
    await waitFor(async () => (await notifications()).some((n) => n.kind === 'auto-update-held'));
    const held = (await notifications()).find((n) => n.kind === 'auto-update-held')!;
    expect(held.title).toBe('notes was not updated automatically');
    expect(held.body).toContain('the place is full');
    // no "update available" row for an app that updates itself; and it did not update without a restore point
    expect((await notifications()).some((n) => n.kind === 'update-available')).toBe(false);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await notes()).revision).toBe('1');
    expect(h.daemon.ctx.repo.setting<Record<string, string>>('updates.autoTried')?.[inst.id]).toBeUndefined();
    engine.failWith = null;
  });

  it('with a working place: backup first, then the update, then a notice that it happened', async () => {
    // the held attempt waits hours before it retries; a new revision starts over at once
    await upload('3', 'nginx:alpine');
    await waitFor(async () => (await notes()).revision === '3' && (await notes()).installState === 'installed');
    const after = await notes();
    expect(after.version).toBe('1.3.0');
    const update = await h.api.expect<{ kind: string; state: string; startedAt: string }>(200, 'GET', `/v1/operations/${after.operationId}`);
    expect(update).toMatchObject({ kind: 'update', state: 'succeeded' });
    const backup = (await runs(inst.id)).find((r) => r.kind === 'backup' && r.state === 'succeeded')!;
    expect(backup, 'a restore point was made').toBeDefined();
    // timestamps have one-second resolution: the backup finished no later than the update started (a strict
    // startedAt < createdAt failed whenever both landed in the same second, every time on Node 24.22.1)
    expect(backup.finishedAt! <= update.startedAt).toBe(true);
    const items = await notifications();
    expect(items.find((n) => n.kind === 'app-updated')).toMatchObject({ title: 'notes was updated automatically', body: expect.stringContaining('from 1.1.0 to 1.3.0') });
    expect(items.some((n) => n.kind === 'auto-update-held')).toBe(false); // resolved by the good backup
    // remembered in settings, so a restart does not try the same revision again
    expect(h.daemon.ctx.repo.setting<Record<string, string>>('updates.autoTried')?.[inst.id]).toBe('3');
  });
});
