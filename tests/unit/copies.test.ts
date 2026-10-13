import { describe, expect, it } from 'vitest';
import type { CatalogItemDto, InstanceSummary } from '../../src/contracts/api.js';
import { copyName, defaultCopyName, installView, nameProblem, storeAction } from '../../web/src/app/copies.js';

// Decision 170: what the Store card and the app page offer once an app is here.
const app = (id: string, extra: Partial<CatalogItemDto> = {}): CatalogItemDto => ({ id, name: id, availability: 'available', ...extra }) as CatalogItemDto;
const inst = (name: string, packageId: string, installState: InstanceSummary['installState'] = 'installed', extra: Partial<InstanceSummary> = {}): InstanceSummary =>
  ({ id: `inst-${name}`, name, packageId, packageName: packageId, installState, displayName: null, ...extra }) as unknown as InstanceSummary;

describe('a second copy of an app (decision 170)', () => {
  it('the Store card: Install, then Open (+ Add another copy… when copies are allowed)', () => {
    expect(storeAction(app('immich'), [])).toBe('install');
    expect(storeAction(app('immich'), [inst('immich', 'immich')])).toBe('open-or-copy');
    expect(storeAction(app('immich', { multiInstance: true }), [inst('immich', 'immich'), inst('immich-2', 'immich')])).toBe('open-or-copy');
    expect(storeAction(app('vault', { multiInstance: false }), [inst('vault', 'vault')])).toBe('open');
    expect(storeAction(app('immich', { availability: 'unavailable' }), [inst('immich', 'immich')])).toBe('open');
    expect(storeAction(app('immich', { availability: 'unavailable' }), [])).toBe('unavailable');
  });

  it('a one-copy app whose only copy was removed offers Reinstall, on the card and on its page (never a refused Install)', () => {
    const removed = [inst('vault', 'vault', 'retained')];
    expect(storeAction(app('vault', { multiInstance: false }), removed)).toBe('reinstall');
    expect(installView(app('vault', { multiInstance: false }), removed, 'page')).toBe('reinstall');
    expect(installView(app('vault', { multiInstance: false }), removed, 'copy')).toBe('reinstall');
    // a copyable app with a removed copy installs a new one (the page says the old data is still kept)
    expect(storeAction(app('draw'), [inst('draw', 'draw', 'retained')])).toBe('install');
    expect(installView(app('draw'), [inst('draw', 'draw', 'retained')], 'page')).toBe('install');
  });

  it('the app page: the copies you have; the install page for another copy only when asked, and only for copyable apps', () => {
    const one = [inst('immich', 'immich')];
    expect(installView(app('immich'), [], 'page')).toBe('install');
    expect(installView(app('immich'), one, 'page')).toBe('page');
    expect(installView(app('immich'), one, 'copy')).toBe('copy');
    expect(installView(app('vault', { multiInstance: false }), [inst('vault', 'vault')], 'copy')).toBe('page');
  });

  it('the name: the daemon proposal unless it is taken, required only for another copy, and every problem in words', () => {
    const all = [inst('immich', 'immich'), inst('immich-2', 'immich', 'retained')];
    expect(defaultCopyName(app('immich', { proposedName: 'immich-3' }), all)).toBe('immich-3');
    expect(defaultCopyName(app('immich', { proposedName: 'immich' }), all)).toBe('immich-3'); // a poll behind
    expect(nameProblem('', all, true)).toBe('This copy needs a name.');
    expect(nameProblem('', all, false)).toBeNull(); // a first install: the daemon picks the name
    expect(nameProblem('Bad_Name', all, false)).toMatch(/^Use lowercase letters/);
    expect(nameProblem('immich-2', all, false)).toMatch(/already the name of another app/); // a removed copy keeps its name
    expect(nameProblem('photos', all, true)).toBeNull();
  });

  it('Home names a copy only when another copy of the same app exists and it has no name of its own', () => {
    const a = inst('immich', 'immich');
    expect(copyName(a, [a])).toBeNull();
    expect(copyName(a, [a, inst('immich-2', 'immich')])).toBe('immich');
    expect(copyName(inst('immich', 'immich', 'installed', { displayName: 'Photos' }), [a, inst('immich-2', 'immich')])).toBeNull();
  });
});
