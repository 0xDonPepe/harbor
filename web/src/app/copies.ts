// Decision 170: the pure half of "this app is already here" (no DOM, no runtime imports, so unit tests can
// import it). The Store card, the app page and Home all decide from these.
import type { CatalogItemDto, InstanceSummary } from '../../../src/contracts/api.js';

// The copies of a package the Store counts (removed ones keep their data but are not "installed").
export function copiesOf(packageId: string, all: InstanceSummary[]): { active: InstanceSummary[]; removed: InstanceSummary[] } {
  const mine = all.filter((i) => i.packageId === packageId);
  return { active: mine.filter((i) => i.installState !== 'retained'), removed: mine.filter((i) => i.installState === 'retained') };
}

// The instance name to show under the icon when several copies of one app exist (and the operator has not
// named this one); null when the label alone already tells it apart.
export function copyName(inst: InstanceSummary, all: InstanceSummary[]): string | null {
  if (inst.displayName) return null;
  return all.some((o) => o.id !== inst.id && o.packageId === inst.packageId) ? inst.name : null;
}

// What a Store card offers: Install (nothing here yet), Open (+ Add another copy… for copyable apps),
// Reinstall… (a one-copy app whose only copy was removed with its data kept), or nothing (unavailable).
export type StoreAction = 'install' | 'open' | 'open-or-copy' | 'reinstall' | 'unavailable';
export function storeAction(item: CatalogItemDto, all: InstanceSummary[]): StoreAction {
  const copies = copiesOf(item.id, all);
  const copyable = item.multiInstance !== false;
  const available = item.availability === 'available';
  if (copies.active.length > 0) return copyable && available ? 'open-or-copy' : 'open';
  if (!available) return 'unavailable';
  if (!copyable && copies.removed.length > 0) return 'reinstall';
  return 'install';
}

// Which face the app's own page shows: 'page' (the copies you have, Open), 'reinstall' (a one-copy app whose
// only copy was removed: bring that one back), 'copy' (the install page for another copy: notice + name) or
// 'install' (the plain install page). A one-copy app never reaches an install page once a copy exists.
export type InstallView = 'page' | 'reinstall' | 'copy' | 'install';
export function installView(item: CatalogItemDto, all: InstanceSummary[], mode: 'page' | 'copy'): InstallView {
  const copies = copiesOf(item.id, all);
  const copyable = item.multiInstance !== false;
  if (copies.active.length > 0) return copyable && mode === 'copy' ? 'copy' : 'page';
  if (!copyable && copies.removed.length > 0) return 'reinstall';
  return 'install';
}

// The name the daemon proposes for the next copy (catalog `proposedName`, the planner's rule). Should the
// catalog be a poll behind the instance list, the same rule runs here so the prefill is never a taken name.
export function defaultCopyName(item: CatalogItemDto, all: InstanceSummary[]): string {
  const taken = new Set(all.map((i) => i.name));
  if (item.proposedName && !taken.has(item.proposedName)) return item.proposedName;
  if (!taken.has(item.id)) return item.id;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${item.id}-${n}`)) return `${item.id}-${n}`;
  return '';
}

// What is wrong with a typed instance name, in plain words (null = fine). `required` = the second-copy page,
// where the name keeps the copies apart; elsewhere an empty name lets the daemon pick one.
export function nameProblem(name: string, all: InstanceSummary[], required: boolean): string | null {
  const n = name.trim();
  if (n === '') return required ? 'This copy needs a name.' : null;
  if (all.some((i) => i.name === n)) return `${n} is already the name of another app here. Pick another.`;
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(n)) return 'Use lowercase letters, digits and dashes, starting with a letter.';
  return null;
}
