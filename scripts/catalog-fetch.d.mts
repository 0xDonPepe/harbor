import type * as BundleLib from '../src/packages/catalog-bundle.js';
import type * as CatalogLib from '../src/packages/catalog.js';
import type { CatalogIndex } from '../src/contracts/types.js';

export interface CatalogLibs {
  bundleLib: typeof BundleLib;
  catalogLib: typeof CatalogLib;
}
export interface FetchedCatalog {
  bundle: { meta: BundleLib.CatalogBundleMeta; files: Map<string, Buffer> };
  raw: { meta: Buffer; zip: Buffer };
  source: string;
  official: boolean;
}
export declare function loadCatalogLibs(): Promise<CatalogLibs>;
export declare function fetchCatalogBundle(bundleLib: typeof BundleLib, env?: Record<string, string | undefined>): Promise<FetchedCatalog>;
export declare function extractCatalog(dir: string, fetched: FetchedCatalog, libs: CatalogLibs): CatalogIndex;
