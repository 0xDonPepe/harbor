import { HARBOR_VERSION_PATTERN } from '../contracts/patterns.js';
import type { CatalogIndex, Manifest } from '../contracts/types.js';
import { HarborError } from '../errors.js';
import { compareVersions } from './versions.js';

// Decision 161: each app declares the oldest Harbor it runs on, in its own manifest (`release.minHarbor`).
// It is the app's contract, proven by the harbor-apps CI (the declared version must be a real Harbor release
// whose own validator accepts the app), not computed. Absent = 0.28.0, the first Harbor that downloads
// catalogs; when present it must be 0.28.2 or newer, the first release that ships the field: 0.28.0 and 0.28.1
// do not know it and would refuse the manifest instead of reading it. The catalog bundle copies it into the app's index.json entry so a
// 0.28.0 box (which only reads the index) still lists the app as "needs Harbor x.y.z or newer". Pure.

export const FIRST_CATALOG_HARBOR = '0.28.0';
export const FIRST_DECLARABLE_HARBOR = '0.28.2';
// the published releases that read catalogs but not release.minHarbor (named in the refusal)
const RELEASES_WITHOUT_THE_FIELD = '0.28.0 and 0.28.1';
const HARBOR_VERSION_RE = new RegExp(HARBOR_VERSION_PATTERN);

// release.minHarbor read straight off a parsed manifest document, before the schema check: a manifest written
// for a newer Harbor may use fields this one refuses, and must say "needs Harbor x.y.z" instead of a schema error.
// Null when absent or malformed (the schema check then names the problem).
export function peekMinHarbor(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object') return null;
  const release = (doc as { release?: unknown }).release;
  if (!release || typeof release !== 'object') return null;
  const v = (release as { minHarbor?: unknown }).minHarbor;
  return typeof v === 'string' && HARBOR_VERSION_RE.test(v) ? v : null;
}

// What the app declares, or the default when it declares nothing.
export function effectiveMinHarbor(manifest: Manifest): string {
  return manifest.release.minHarbor ?? FIRST_CATALOG_HARBOR;
}

// The minimum this Harbor is missing, or null. Without a running version (scripts, tests) nothing is enforced.
export function missingHarbor(minHarbor: string | null | undefined, harborVersion: string | undefined): string | null {
  if (!minHarbor || harborVersion === undefined) return null;
  return compareVersions(harborVersion, minHarbor) < 0 ? minHarbor : null;
}

export function needsHarborError(minHarbor: string, nextAction: string): HarborError {
  return new HarborError('INVALID_STATE', `needs Harbor ${minHarbor} or newer`, { nextAction });
}
export function isNeedsHarbor(e: unknown): boolean {
  return e instanceof HarborError && e.code === 'INVALID_STATE' && /^needs Harbor \S+ or newer$/.test(e.message);
}

// A declared value must be one a Harbor that reads the field can honour.
export function declaredMinHarborProblem(minHarbor: string | undefined): string | null {
  if (minHarbor === undefined) return null;
  if (compareVersions(minHarbor, FIRST_DECLARABLE_HARBOR) < 0) {
    return `release.minHarbor ${minHarbor} must be ${FIRST_DECLARABLE_HARBOR} or newer: Harbor ${RELEASES_WITHOUT_THE_FIELD} do not know the field (leave it out for ${FIRST_CATALOG_HARBOR})`;
  }
  return null;
}

// Catalog tooling (verify, plan, bundle): index.json may leave minHarbor out; when it names one, it must equal the
// manifest's (absent in the manifest = 0.28.0). The daemon does not apply this: it gates on both values instead.
export function indexMinHarborProblem(entry: CatalogIndex['packages'][string], manifest: Manifest): string | null {
  if (entry.minHarbor === undefined) return null;
  const declared = effectiveMinHarbor(manifest);
  if (compareVersions(entry.minHarbor, declared) === 0) return null;
  return `index.json minHarbor ${entry.minHarbor} does not match the manifest's release.minHarbor ${manifest.release.minHarbor ?? `(none = ${FIRST_CATALOG_HARBOR})`}: remove it from index.json (the bundle copies the manifest's value) or make them equal`;
}
