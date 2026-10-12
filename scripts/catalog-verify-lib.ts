// The checks behind `pnpm catalog:verify` (scripts/catalog-verify.ts) and `pnpm catalog:plan` (scripts/catalog-plan.ts).
// Every index package must load exactly as the daemon loads it (which also checks a declared release.minHarbor is
// canonical x.y.z and at least 0.28.2), and an index.json minHarbor, when present, must equal the manifest's (decision 161).
import type { LoadedPackage } from '../src/contracts/types.js';
import { loadPackage, readCatalogIndex } from '../src/packages/catalog.js';
import { effectiveMinHarbor, indexMinHarborProblem } from '../src/packages/min-harbor.js';
import { compareVersions } from '../src/packages/versions.js';

export interface CatalogVerifyResult {
  lines: string[];
  failed: number;
  total: number;
}

// One index package, loaded and checked as the catalog tooling does. Throws with the reason.
export function loadCatalogPackage(catalogDir: string, id: string): LoadedPackage {
  const index = readCatalogIndex(catalogDir);
  const pkg = loadPackage(catalogDir, id);
  const problem = indexMinHarborProblem(index.packages[id]!, pkg.manifest);
  if (problem) throw new Error(problem);
  return pkg;
}

export function verifyCatalog(catalogDir: string): CatalogVerifyResult {
  const index = readCatalogIndex(catalogDir);
  const lines: string[] = [];
  let failed = 0;
  for (const id of Object.keys(index.packages)) {
    try {
      const pkg = loadCatalogPackage(catalogDir, id);
      const images = Object.values(pkg.release.images).map((i) => i.reference).join(',');
      const min = pkg.manifest.release.minHarbor ?? `${effectiveMinHarbor(pkg.manifest)}(default)`;
      lines.push(`ok   ${id}@${pkg.revision} qualification=${pkg.release.qualification.status} minHarbor=${min} images=${images}`);
    } catch (e) {
      failed++;
      lines.push(`FAIL ${id}: ${(e as Error).message}`);
    }
  }
  return { lines, failed, total: Object.keys(index.packages).length };
}

// `pnpm catalog:plan` (decision 161): the apps grouped by the Harbor they declare (absent = 0.28.0), so the
// harbor-apps CI can validate each group with that Harbor release's own validator. Groups sorted by version,
// ids sorted. Throws, naming every app, when any package does not load or its declaration is invalid.
export interface CatalogPlan {
  groups: { minHarbor: string; ids: string[] }[];
}
export function planCatalog(catalogDir: string): CatalogPlan {
  const index = readCatalogIndex(catalogDir);
  const byVersion = new Map<string, string[]>();
  const failures: string[] = [];
  for (const id of Object.keys(index.packages).sort()) {
    try {
      const v = effectiveMinHarbor(loadCatalogPackage(catalogDir, id).manifest);
      byVersion.set(v, [...(byVersion.get(v) ?? []), id]);
    } catch (e) {
      failures.push(`${id}: ${(e as Error).message}`);
    }
  }
  if (failures.length) throw new Error(`the catalog cannot be planned:\n  ${failures.join('\n  ')}`);
  return { groups: [...byVersion.keys()].sort(compareVersions).map((minHarbor) => ({ minHarbor, ids: byVersion.get(minHarbor)! })) };
}
