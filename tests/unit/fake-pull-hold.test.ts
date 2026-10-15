// Decision 183 (dev/e2e only): the fake pull the e2e queue test holds. The control file is read again while a pull
// waits, so a test releases a pull that already started (no fixed timer to race).
import { describe, expect, it } from 'vitest';
import { FakeDocker, holdPull } from '../../src/docker/fake.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fast = { pollMs: 5 };

describe('a held fake pull (dev knob)', () => {
  it('returns at once when the control does not match the images (or is missing / not an object)', async () => {
    for (const c of [null, {}, 'junk', { hold: false, match: 'kuma' }, { hold: true, match: 'immich' }]) {
      let reads = 0;
      await holdPull(['louislam/uptime-kuma:1'], () => (reads++, c), fast);
      expect(reads).toBe(1);
    }
  });

  it('holds until the control no longer matches, re-reading it while it waits', async () => {
    let control: unknown = { hold: true, match: 'uptime-kuma' };
    let released = false;
    const p = holdPull(['louislam/uptime-kuma:1'], () => control, fast).then(() => (released = true));
    await new Promise((r) => setTimeout(r, 60));
    expect(released).toBe(false);
    control = {};
    await p;
    expect(released).toBe(true);
  });

  it('pullDelayMs is a maximum: released when it elapses, or earlier when the control changes', async () => {
    const t0 = Date.now();
    await holdPull(['a/kuma'], () => ({ pullDelayMs: 40, match: 'kuma' }), fast);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    let control: unknown = { pullDelayMs: 60_000, match: 'kuma' };
    setTimeout(() => (control = { match: 'kuma' }), 30);
    const t1 = Date.now();
    await holdPull(['a/kuma'], () => control, fast);
    expect(Date.now() - t1).toBeLessThan(5_000);
  });

  it('the fake adapter waits on it during pull', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'harbor-fake-hold-'));
    const file = path.join(d, 'compose.yaml');
    writeFileSync(file, 'services:\n  web:\n    image: louislam/uptime-kuma:1\n');
    const fake = new FakeDocker();
    let release!: () => void;
    const seen: string[][] = [];
    fake.behaviour.pullWait = (images) => (seen.push(images), new Promise<void>((r) => (release = r)));
    let done = false;
    const p = fake.pull({ projectName: 'hb_kuma', file, projectDir: d } as never, 1000).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    expect(seen).toEqual([['louislam/uptime-kuma:1']]);
    release();
    await p;
    expect(done).toBe(true);
  });
});
