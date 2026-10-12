import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listCatalog, loadPackage } from '../../src/packages/catalog.js';
import { FakeRegistry } from '../../src/packages/registry.js';
import { PackageStore } from '../../src/packages/store.js';
import { compareVersions } from '../../src/packages/versions.js';
import { writeZip } from '../../src/packages/zip.js';
import { systemClock } from '../../src/util.js';
import { cloneCatalog, DIGEST_A, MINIMAL_COMPOSE, MINIMAL_MANIFEST, tempDir, writePackage } from './helpers.js';

// Decision 158: the official catalog folder is read through a provider (a downloaded catalog swaps in
// without a restart), entries may name a minimum Harbor, and an id the operator owns stays theirs.

const hello = (rev: string) => MINIMAL_MANIFEST.replace('id: demo', 'id: hello').replace('name: Demo', 'name: Hello (mine)').replace('revision: "1"', `revision: "${rev}"`);
const upload = (store: PackageStore, rev: string, id = 'hello') => store.importZip(writeZip({ 'manifest.yaml': hello(rev).replace('id: hello', `id: ${id}`), 'compose.yaml': MINIMAL_COMPOSE }), { fileName: `${id}.zip`, actor: 'admin' });
const setMinHarbor = (dir: string, id: string, v: string) => {
  const p = path.join(dir, 'index.json');
  const index = JSON.parse(readFileSync(p, 'utf8'));
  index.packages[id].minHarbor = v;
  writeFileSync(p, JSON.stringify(index));
};

describe('package store: the official catalog', () => {
  it('reads the official folder through the provider on every call', () => {
    const a = cloneCatalog();
    const b = cloneCatalog();
    writePackage(b, 'demo', { manifest: MINIMAL_MANIFEST, compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` } });
    let current = a;
    const store = new PackageStore(() => current, tempDir(), new FakeRegistry(), systemClock);
    expect(store.list().some((i) => i.id === 'demo')).toBe(false);
    expect(store.originOf('demo')).toBeNull();
    current = b;
    expect(store.bundledDir).toBe(b);
    expect(store.list().find((i) => i.id === 'demo')).toMatchObject({ origin: 'bundled', availability: 'available' });
    expect(store.load('demo').dir).toBe(path.join(b, 'demo'));
    // the string constructor still works (scripts, older callers)
    expect(new PackageStore(a, tempDir(), new FakeRegistry(), systemClock).bundledDir).toBe(a);
  });

  it('an id the operator uploaded before the official catalog added it stays the operator\'s', async () => {
    const official = cloneCatalog();
    const store = new PackageStore(() => official, tempDir(), new FakeRegistry(), systemClock);
    await upload(store, '1');
    // later, the official catalog ships an app with the same id
    writePackage(official, 'hello', { manifest: hello('5').replace('Hello (mine)', 'Hello (official)'), compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` }, revision: '5' });
    const listed = store.list().filter((i) => i.id === 'hello');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ origin: 'local', revision: '1', name: 'Hello (mine)' });
    expect(store.originOf('hello')).toBe('local');
    expect(store.load('hello')).toMatchObject({ origin: 'local', revision: '1' });
    // no "update" to the official revision 5: the operator's package is the one installed apps follow
    expect(store.currentRevisions().get('hello')?.revision).toBe('1');
    // the operator keeps publishing their own revisions under the id
    expect((await upload(store, '2')).item).toMatchObject({ origin: 'local', revision: '2' });
    // removing the upload hands the id back to the official catalog
    store.removeLocal('hello');
    expect(store.load('hello')).toMatchObject({ origin: 'bundled', revision: '5' });
    // and a new upload of an official id is refused, as before
    await expect(upload(store, '6')).rejects.toThrow(/belongs to a built-in app/);
    await expect(upload(store, '1', 'excalidraw')).rejects.toThrow(/belongs to a built-in app/);
  });

  it('a package that needs a newer Harbor lists as unavailable and cannot be loaded', () => {
    const official = cloneCatalog();
    setMinHarbor(official, 'excalidraw', '9.0.0');
    const old = new PackageStore(() => official, tempDir(), new FakeRegistry(), systemClock, { harborVersion: '0.28.0' });
    const item = old.list().find((i) => i.id === 'excalidraw')!;
    expect(item).toMatchObject({ availability: 'unavailable', reason: 'needs Harbor 9.0.0 or newer', name: 'Excalidraw', origin: 'bundled' });
    expect(item.presentation.icon).toBeNull(); // assets are served only for loadable packages
    expect(() => old.load('excalidraw')).toThrow(/needs Harbor 9\.0\.0 or newer/);
    expect(old.currentRevisions().has('excalidraw')).toBe(false);
    expect(old.list().find((i) => i.id === 'memos')?.availability).toBe('available');

    const fresh = new PackageStore(() => official, tempDir(), new FakeRegistry(), systemClock, { harborVersion: '9.0.0' });
    expect(fresh.list().find((i) => i.id === 'excalidraw')?.availability).toBe('available');
    expect(fresh.load('excalidraw').revision).toBe('1');
    // without a running version (scripts, catalog:verify) the minimum is not enforced
    expect(listCatalog(official).find((i) => i.id === 'excalidraw')?.availability).toBe('available');
    expect(loadPackage(official, 'excalidraw').revision).toBe('1');
    expect(() => loadPackage(official, 'excalidraw', undefined, { harborVersion: '0.1.0' })).toThrow(/needs Harbor 9\.0\.0 or newer/);
  });

  it('checks minHarbor before parsing the package (a newer manifest may not parse here)', () => {
    const official = cloneCatalog();
    setMinHarbor(official, 'excalidraw', '1.0.0');
    writeFileSync(path.join(official, 'excalidraw', 'manifest.yaml'), 'apiVersion: harbor/v2\nfutureField: true\n');
    const store = new PackageStore(() => official, tempDir(), new FakeRegistry(), systemClock, { harborVersion: '0.28.0' });
    expect(store.list().find((i) => i.id === 'excalidraw')).toMatchObject({ availability: 'unavailable', reason: 'needs Harbor 1.0.0 or newer', name: 'excalidraw' });
  });

  // Decision 161: the manifest's own release.minHarbor gates too (the index copy is what a 0.28.0 box reads).
  const declaring = (v: string, extra = '') => MINIMAL_MANIFEST.replace('  revision: "1"\n', `  revision: "1"\n  minHarbor: "${v}"\n${extra}`);
  it('the manifest release.minHarbor gates catalog listing and load, before the schema check', () => {
    const official = cloneCatalog();
    writePackage(official, 'demo', { manifest: declaring('0.29.0'), compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` } });
    const old = new PackageStore(() => official, tempDir(), new FakeRegistry(), systemClock, { harborVersion: '0.28.2' });
    expect(old.list().find((i) => i.id === 'demo')).toMatchObject({ availability: 'unavailable', reason: 'needs Harbor 0.29.0 or newer', name: 'Demo' });
    expect(() => old.load('demo')).toThrow(/needs Harbor 0\.29\.0 or newer/);
    expect(old.currentRevisions().has('demo')).toBe(false);
    const fresh = new PackageStore(() => official, tempDir(), new FakeRegistry(), systemClock, { harborVersion: '0.29.0' });
    expect(fresh.list().find((i) => i.id === 'demo')?.availability).toBe('available');
    expect(fresh.load('demo').manifest.release.minHarbor).toBe('0.29.0');
    // a manifest written for a newer Harbor (a field this one does not know) still says what it needs
    writePackage(official, 'demo', { manifest: declaring('0.29.0', 'futureField: true\n'), compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` } });
    expect(old.list().find((i) => i.id === 'demo')).toMatchObject({ availability: 'unavailable', reason: 'needs Harbor 0.29.0 or newer', name: 'demo' });
    expect(fresh.list().find((i) => i.id === 'demo')?.reason).toMatch(/must NOT have additional properties/);
  });

  it('a declared release.minHarbor must be canonical x.y.z and at least 0.28.2 (0.28.0 and 0.28.1 do not know the field)', () => {
    const official = cloneCatalog();
    const load = (v: string) => {
      writePackage(official, 'demo', { manifest: declaring(v), compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` } });
      return () => loadPackage(official, 'demo');
    };
    expect(load('0.28.2')().manifest.release.minHarbor).toBe('0.28.2');
    expect(load('1.0.0')().manifest.release.minHarbor).toBe('1.0.0');
    expect(load('0.100.0')().manifest.release.minHarbor).toBe('0.100.0');
    expect(load('0.28.1')).toThrow(/release\.minHarbor 0\.28\.1 must be 0\.28\.2 or newer: Harbor 0\.28\.0 and 0\.28\.1 do not know the field/);
    expect(load('0.28.0')).toThrow(/release\.minHarbor 0\.28\.0 must be 0\.28\.2 or newer/);
    expect(load('0.9.99')).toThrow(/must be 0\.28\.2 or newer/);
    expect(load('0.29')).toThrow(/release\/minHarbor: must match pattern/);
    expect(load('v0.29.0')).toThrow(/release\/minHarbor: must match pattern/);
    // canonical only: spelled like the release tag the harbor-apps CI looks up (the index pattern stays as it was)
    for (const v of ['0.028.2', '00.28.2', '0.28.02', '1.0.00', '01.0.0']) expect(load(v), v).toThrow(/release\/minHarbor: must match pattern/);
  });

  it('uploads (and git sources, the same import path) refuse a package that needs a newer Harbor', async () => {
    const store = new PackageStore(() => cloneCatalog(), tempDir(), new FakeRegistry(), systemClock, { harborVersion: '0.28.2' });
    const zip = (m: string) => writeZip({ 'manifest.yaml': m.replace('id: demo', 'id: hello'), 'compose.yaml': MINIMAL_COMPOSE });
    await expect(store.importZip(zip(declaring('0.29.0')), { fileName: 'hello.zip', actor: 'admin' })).rejects.toThrow(/^needs Harbor 0\.29\.0 or newer$/);
    await expect(store.importZip(zip(declaring('9.0.0', 'futureField: true\n')), { fileName: 'hello.zip', actor: 'admin' })).rejects.toMatchObject({ code: 'INVALID_STATE', message: 'needs Harbor 9.0.0 or newer' });
    await expect(store.importZip(zip(declaring('0.28.1')), { fileName: 'hello.zip', actor: 'admin' })).rejects.toThrow(/must be 0\.28\.2 or newer: Harbor 0\.28\.0 and 0\.28\.1 do not know the field/);
    const r = await store.importZip(zip(declaring('0.28.2')), { fileName: 'hello.zip', actor: 'admin' });
    expect(r.item).toMatchObject({ id: 'hello', availability: 'available', origin: 'local' });
    expect(store.load('hello').manifest.release.minHarbor).toBe('0.28.2');
  });

  it('refuses a malformed minHarbor in the index', () => {
    const official = cloneCatalog();
    setMinHarbor(official, 'excalidraw', 'soon');
    expect(() => listCatalog(official)).toThrow(/catalog index invalid/);
  });

  it('compares Harbor versions numerically', () => {
    expect(compareVersions('0.28.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.28.0-beta.1', '0.28.0')).toBe(-1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
  });
});
