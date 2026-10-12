// Bundle an app catalog for publishing (decision 158; run by the harbor-apps CI):
//   pnpm catalog:bundle <catalogDir> --out <dir> --commit <sha> --serial <unix-seconds> [--summary <file>]
// Writes <out>/catalog.zip and <out>/catalog.json (the zip's sha256 + size: an integrity check). The serial is
// the committer time of the catalog commit (git log -1 --format=%ct): Harbor only ever moves to a higher one.
// --summary also writes {serial, commit, packages:[{id, revision, version|null, minHarbor|null}]} (sorted by id)
// as JSON: what the harbor-apps publish job builds its release notes from (never from the human log below).
// Fails without writing anything when any package does not validate exactly as the daemon loads it.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUNDLE_FILES } from '../src/packages/catalog-bundle.js';
import { buildCatalogBundle } from './catalog-bundle-build.js';
import { resolveCatalogDir } from './catalog-dir.mjs';

const USAGE = 'usage: catalog-bundle.ts <catalogDir> --out <dir> --commit <sha> --serial <unix-seconds> [--summary <file>]';
const args = process.argv.slice(2).filter((a) => a !== '--');
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const valued = new Set(['--out', '--commit', '--serial', '--summary']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
const out = opt('--out');
const commit = opt('--commit');
const serial = Number(opt('--serial'));
const summary = opt('--summary');
const unknown = args.filter((a) => a.startsWith('--') && !valued.has(a));
if (!out || !commit || !opt('--serial') || positional.length > 1 || unknown.length || (args.includes('--summary') && !summary)) {
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
  if (summary) {
    const packages = [...built.packages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((p) => ({ id: p.id, revision: p.revision, version: p.version, minHarbor: p.minHarbor }));
    const file = path.resolve(process.env['INIT_CWD'] ?? process.cwd(), summary);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ serial: built.parsed.serial, commit, packages }, null, 2) + '\n');
  }
  // `ok   <id>@<revision>[ (<version>)][ minHarbor=<x.y.z>]`: for people; tools read --summary instead
  for (const p of built.packages) console.log(`ok   ${p.id}@${p.revision}${p.version ? ` (${p.version})` : ''}${p.minHarbor ? ` minHarbor=${p.minHarbor}` : ''}`);
  console.log(`${path.join(outDir, BUNDLE_FILES.zip)} ${built.parsed.zip.bytes} bytes sha256 ${built.parsed.zip.sha256}`);
  console.log(`${path.join(outDir, BUNDLE_FILES.meta)} serial ${built.parsed.serial} (${built.parsed.createdAt}) commit ${commit}, ${built.parsed.packages} packages`);
  if (summary) console.log(`summary ${path.resolve(process.env['INIT_CWD'] ?? process.cwd(), summary)}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
