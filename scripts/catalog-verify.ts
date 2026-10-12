// Load and fully validate every package of an app catalog exactly as the daemon does.
//   pnpm catalog:verify [<catalogDir> | --catalog <dir>] [--quiet]
// Harbor CI runs it on tests/fixtures/catalog and on the latest published official catalog (job official-catalog);
// the harbor-apps CI runs it on its apps/ folder, and on one subset per declared release.minHarbor with that Harbor
// release's own copy of this script (decision 161). Also fails an index.json minHarbor that differs from the
// manifest's. Without a dir it resolves as in scripts/catalog-dir.mjs (HARBOR_CATALOG_DIR, then ../harbor-apps/apps).
import { listCatalog } from '../src/packages/catalog.js';
import { resolveCatalogDir } from './catalog-dir.mjs';
import { verifyCatalog } from './catalog-verify-lib.js';

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
const result = verifyCatalog(catalogDir);
for (const line of result.lines) console.log(line);
if (!quiet) console.log(JSON.stringify(listCatalog(catalogDir), null, 2));
console.log(result.failed ? `${result.failed} of ${result.total} packages failed` : `${result.total} packages ok`);
process.exit(result.failed ? 1 : 0);
