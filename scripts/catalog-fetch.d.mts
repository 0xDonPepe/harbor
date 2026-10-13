import type * as BundleLib from '../src/packages/catalog-bundle.js';
import type * as CatalogLib from '../src/packages/catalog.js';
import type * as SignLib from '../src/signing.js';
import type { ReleaseKey } from '../src/release-keys.js';
import type { CatalogIndex } from '../src/contracts/types.js';

export interface CatalogLibs {
  bundleLib: typeof BundleLib;
  catalogLib: typeof CatalogLib;
  signLib: typeof SignLib;
  keys: readonly ReleaseKey[];
}
export interface CatalogSigning {
  signLib: typeof SignLib;
  keys: readonly ReleaseKey[];
  // refuse a catalog without catalog.json.sig (a bad signature is always refused)
  required: boolean;
}
export interface FetchedCatalog {
  bundle: { meta: BundleLib.CatalogBundleMeta; files: Map<string, Buffer> };
  raw: { meta: Buffer; zip: Buffer };
  source: string;
  official: boolean;
  signedBy: string | null;
}
export declare function loadCatalogLibs(): Promise<CatalogLibs>;
export declare function checkCatalogSignature(meta: Buffer, sig: Buffer | null, signing: CatalogSigning, source: string): string | null;
export declare function fetchCatalogBundle(bundleLib: typeof BundleLib, env: Record<string, string | undefined>, signing: CatalogSigning): Promise<FetchedCatalog>;
export declare function extractCatalog(dir: string, fetched: FetchedCatalog, libs: Pick<CatalogLibs, 'bundleLib' | 'catalogLib'>): CatalogIndex;
