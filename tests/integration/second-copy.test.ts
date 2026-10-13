import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import type { CatalogItemDto } from '../../src/contracts/api.js';
import { DIGEST_A, MINIMAL_COMPOSE, MINIMAL_MANIFEST, writePackage } from '../unit/helpers.js';

// Decision 170: the catalog says whether an app allows copies and which name the next one gets; an install
// plan for a second copy says so in plain words (the console and `harbor install` show that note).
let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  writePackage(h.catalogDir, 'solo', { manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: solo').replace('name: Demo', 'name: Solo').replace('multiInstance: true', 'multiInstance: false'), compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` } });
});
afterAll(async () => {
  await h.close();
});

const item = async (id: string): Promise<CatalogItemDto> => (await h.api.expect<{ items: CatalogItemDto[] }>(200, 'GET', '/v1/catalog')).items.find((i) => i.id === id)!;

describe('a second copy of an app (decision 170)', () => {
  it('the catalog says whether copies are allowed and proposes the next name', async () => {
    expect(await item('excalidraw')).toMatchObject({ multiInstance: true, proposedName: 'excalidraw' });
    expect(await item('solo')).toMatchObject({ multiInstance: false, proposedName: 'solo' });
  });

  it('the first install has no copy note; the second says it is a separate copy, by name', async () => {
    const first = await h.api.plan({ kind: 'install', packageId: 'excalidraw' });
    expect(first.notes.join('\n')).not.toMatch(/already have/);
    const { op } = await h.api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(op.state).toBe('succeeded');
    expect((await item('excalidraw')).proposedName).toBe('excalidraw-2');
    const second = await h.api.plan({ kind: 'install', packageId: 'excalidraw' });
    expect(second.name).toBe('excalidraw-2');
    expect(second.notes[0]).toBe('You already have Excalidraw. This installs a separate copy (excalidraw-2) with its own data, address and login; the first one is not touched.');
    // a name the operator types is the one the note uses
    const named = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'sketches' });
    expect(named.notes[0]).toContain('(sketches)');
  });

  it('a removed copy (data kept) is named as such', async () => {
    const { op } = await h.api.run({ kind: 'install', packageId: 'bentopdf' });
    expect(op.state).toBe('succeeded');
    const inst = (await h.api.instances()).find((i) => i.packageId === 'bentopdf')!;
    expect((await h.api.run({ kind: 'remove', instanceId: inst.id })).op.state).toBe('succeeded');
    const again = await h.api.plan({ kind: 'install', packageId: 'bentopdf' });
    expect(again.name).toBe('bentopdf-2');
    expect(again.notes[0]).toMatch(/^A removed copy of BentoPDF still keeps its data\./);
  });

  it('a one-copy app refuses a second install and says what to do instead', async () => {
    const { op } = await h.api.run({ kind: 'install', packageId: 'solo' });
    expect(op.state).toBe('succeeded');
    const err = await h.api.expectError(409, 'NAME_CONFLICT', 'POST', '/v1/plans', { kind: 'install', packageId: 'solo' });
    expect(err.error.nextAction).toMatch(/one copy per machine/);
    const inst = (await h.api.instances()).find((i) => i.packageId === 'solo')!;
    expect((await h.api.run({ kind: 'remove', instanceId: inst.id })).op.state).toBe('succeeded');
    const removed = await h.api.expectError(409, 'NAME_CONFLICT', 'POST', '/v1/plans', { kind: 'install', packageId: 'solo' });
    expect(removed.error.nextAction).toMatch(/^Reinstall the removed copy/);
  });
});
