// The checks behind `pnpm catalog:verify` (scripts/catalog-verify.ts), importable so tests can inject a feature table.
// Every index package must load exactly as the daemon loads it, and a minHarbor declared by hand in index.json must
// not be lower than what the package's fields need (decision 159; the bundle stamps the computed value anyway).
import { loadPackage, readCatalogIndex } from '../src/packages/catalog.js';
import { declaredTooLow, FEATURES, harborRequirement, type HarborFeature } from '../src/packages/features.js';

export interface CatalogVerifyResult {
  lines: string[];
  failed: number;
  total: number;
}

export function verifyCatalog(catalogDir: string, opts: { features?: readonly HarborFeature[] } = {}): CatalogVerifyResult {
  const index = readCatalogIndex(catalogDir);
  const lines: string[] = [];
  let failed = 0;
  for (const id of Object.keys(index.packages)) {
    try {
      const pkg = loadPackage(catalogDir, id);
      const declared = index.packages[id]!.minHarbor ?? null;
      const need = harborRequirement(pkg.manifest, pkg.compose, opts.features ?? FEATURES);
      if (declaredTooLow(declared, need.minHarbor)) {
        throw new Error(
          `index.json declares minHarbor ${declared} but the package uses ${need.because.join(', ')}: ` +
            `raise it to ${need.minHarbor}, or remove it (the catalog bundle stamps the computed value)`,
        );
      }
      const images = Object.values(pkg.release.images).map((i) => i.reference).join(',');
      lines.push(`ok   ${id}@${pkg.revision} qualification=${pkg.release.qualification.status} minHarbor declared=${declared ?? 'none'} computed=${need.minHarbor ?? 'none'} images=${images}`);
    } catch (e) {
      failed++;
      lines.push(`FAIL ${id}: ${(e as Error).message}`);
    }
  }
  return { lines, failed, total: Object.keys(index.packages).length };
}
