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
