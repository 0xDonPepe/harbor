// Bundle an app catalog for publishing (decision 158; run by the harbor-apps CI):
//   pnpm catalog:bundle <catalogDir> --out <dir> --commit <sha> --serial <unix-seconds>
// Writes <out>/catalog.zip and <out>/catalog.json (the zip's sha256 + size: an integrity check). The serial is
// the committer time of the catalog commit (git log -1 --format=%ct): Harbor only ever moves to a higher one.
// Fails without writing anything when any package does not validate exactly as the daemon loads it.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUNDLE_FILES } from '../src/packages/catalog-bundle.js';
import { buildCatalogBundle } from './catalog-bundle-build.js';
import { resolveCatalogDir } from './catalog-dir.mjs';

const USAGE = 'usage: catalog-bundle.ts <catalogDir> --out <dir> --commit <sha> --serial <unix-seconds>';
const args = process.argv.slice(2).filter((a) => a !== '--');
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const valued = new Set(['--out', '--commit', '--serial']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
const out = opt('--out');
const commit = opt('--commit');
const serial = Number(opt('--serial'));
if (!out || !commit || !opt('--serial') || positional.length > 1) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const catalogDir = resolveCatalogDir(positional[0]);
  const built = buildCatalogBundle(catalogDir, { commit, serial });
  const outDir = path.resolve(process.env['INIT_CWD'] ?? process.cwd(), out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, BUNDLE_FILES.zip), built.zip);
  writeFileSync(path.join(outDir, BUNDLE_FILES.meta), built.meta);
  for (const p of built.packages) console.log(`ok   ${p.id}@${p.revision}${p.version ? ` (${p.version})` : ''}`);
  console.log(`${path.join(outDir, BUNDLE_FILES.zip)} ${built.parsed.zip.bytes} bytes sha256 ${built.parsed.zip.sha256}`);
  console.log(`${path.join(outDir, BUNDLE_FILES.meta)} serial ${built.parsed.serial} (${built.parsed.createdAt}) commit ${commit}, ${built.parsed.packages} packages`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
