// Load and fully validate every package of an app catalog exactly as the daemon does.
//   pnpm catalog:verify [<catalogDir> | --catalog <dir>] [--quiet]
// Harbor CI runs it on tests/fixtures/catalog; the harbor-apps CI runs it on its apps/ folder.
// Without a dir it resolves as in scripts/catalog-dir.mjs (HARBOR_CATALOG_DIR, then ../harbor-apps/apps).
import { listCatalog, loadPackage, readCatalogIndex } from '../src/packages/catalog.js';
import { resolveCatalogDir } from './catalog-dir.mjs';

const args = process.argv.slice(2).filter((a) => a !== '--');
const quiet = args.includes('--quiet');
const at = args.indexOf('--catalog');
let catalogDir: string;
try {
  catalogDir = resolveCatalogDir(at >= 0 ? args[at + 1] : args.find((a) => !a.startsWith('--')));
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
console.log(`catalog ${catalogDir}`);
const index = readCatalogIndex(catalogDir);
let failed = 0;
for (const id of Object.keys(index.packages)) {
  try {
    const pkg = loadPackage(catalogDir, id);
    console.log(`ok   ${id}@${pkg.revision} qualification=${pkg.release.qualification.status} images=${Object.values(pkg.release.images).map((i) => i.reference).join(',')}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${id}: ${(e as Error).message}`);
  }
}
if (!quiet) console.log(JSON.stringify(listCatalog(catalogDir), null, 2));
console.log(failed ? `${failed} of ${Object.keys(index.packages).length} packages failed` : `${Object.keys(index.packages).length} packages ok`);
process.exit(failed ? 1 : 0);
