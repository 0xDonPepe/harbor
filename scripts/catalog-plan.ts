// Which Harbor release each app of a catalog must be validated with (decision 161):
//   pnpm catalog:plan [<catalogDir> | --catalog <dir>]
// Prints {"groups":[{"minHarbor":"0.28.0","ids":["actual",...]},...]} on stdout: the apps grouped by their declared
// release.minHarbor (absent = 0.28.0), groups sorted by version, ids sorted. The harbor-apps CI runs each group's
// apps through that Harbor release's own `catalog:verify`. Every package is validated with this Harbor's loader
// first; exit 1 (reason on stderr) when one does not load or declares an invalid minimum (not canonical x.y.z, below 0.28.2,
// or an index.json minHarbor that differs from the manifest's). Without a dir it resolves as scripts/catalog-dir.mjs.
import { resolveCatalogDir } from './catalog-dir.mjs';
import { planCatalog } from './catalog-verify-lib.js';

const args = process.argv.slice(2).filter((a) => a !== '--');
const at = args.indexOf('--catalog');
let catalogDir: string;
try {
  catalogDir = resolveCatalogDir(at >= 0 ? args[at + 1] : args.find((a) => !a.startsWith('--')));
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
try {
  process.stdout.write(JSON.stringify(planCatalog(catalogDir)) + '\n');
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
