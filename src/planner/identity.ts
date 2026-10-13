import { LABELS, projectNameFor, volumeNameFor } from '../naming.js';
import { ID_RE } from '../contracts/patterns.js';

export interface InstanceIdentity {
  installationId: string;
  instanceId: string;
  project: string;
}

export function identityFor(installationId: string, instanceId: string): InstanceIdentity {
  return { installationId, instanceId, project: projectNameFor(instanceId) };
}

export function instanceLabels(id: InstanceIdentity, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [LABELS.installation]: id.installationId,
    [LABELS.instance]: id.instanceId,
    ...extra,
  };
}

export function volumeLabels(id: InstanceIdentity, composeVolume: string, token: string): Record<string, string> {
  return instanceLabels(id, { [LABELS.kind]: 'volume', [LABELS.token]: token, [LABELS.service]: composeVolume });
}

export function ownedVolumeName(id: InstanceIdentity, composeVolume: string): string {
  return volumeNameFor(id.project, composeVolume);
}

export function defaultNetworkName(id: InstanceIdentity): string {
  return `${id.project}_default`;
}

// Default instance names: package id if free, else <package>-2, <package>-3, ...
export function proposeName(packageId: string, taken: Set<string>, requested?: string): { name: string; error?: string } {
  if (requested !== undefined) {
    if (!ID_RE.test(requested)) return { name: requested, error: `name must match [a-z][a-z0-9-]{0,62}` };
    if (taken.has(requested)) return { name: requested, error: `name ${requested} is already used by another instance` };
    return { name: requested };
  }
  if (!taken.has(packageId)) return { name: packageId };
  for (let n = 2; n < 1000; n++) {
    const candidate = `${packageId}-${n}`;
    if (!taken.has(candidate)) return { name: candidate };
  }
  return { name: packageId, error: 'no free default name' };
}

// Decision 170: the line an install plan (and `harbor install`) carries when a copy of the app already
// exists, in the same words as the console's install page. `active` counts copies that are installed
// (any state but removed), `removed` the removed ones whose data Harbor keeps; null when there is none.
export function copyNote(appName: string, name: string, copies: { active: number; removed: number }): string | null {
  if (copies.active === 1) return `You already have ${appName}. This installs a separate copy (${name}) with its own data, address and login; the first one is not touched.`;
  if (copies.active > 1) return `You already have ${copies.active} copies of ${appName}. This installs another separate copy (${name}) with its own data, address and login; the others are not touched.`;
  if (copies.removed > 0) return `A removed copy of ${appName} still keeps its data. This installs a new, separate copy (${name}); to get that data back, reinstall the removed copy from Home instead.`;
  return null;
}

// Decision 170: what to do instead when a one-copy app (deployment.multiInstance false) already has a copy
// here. Removed copies (data kept) still hold the one place, so the advice depends on what is there and on
// whether the operator was installing or restoring a backup.
export function oneCopyNextAction(copies: { installState: string }[], purpose: 'install' | 'restore'): string {
  const removedOnly = copies.every((i) => i.installState === 'retained');
  if (purpose === 'install') return removedOnly ? 'Reinstall the removed copy from Home (its data is kept), or uninstall it completely first.' : 'Open the copy you have; this app runs one copy per machine.';
  return removedOnly
    ? 'This app runs one copy per machine: reinstall the removed copy instead, or uninstall it completely (its kept data goes) and restore again.'
    : 'This app runs one copy per machine: uninstall the copy you have completely first, then restore again.';
}
