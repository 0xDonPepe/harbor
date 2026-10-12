#!/usr/bin/env node
// Download the latest signed official app catalog (decision 158), verify it against the pinned key, and extract it.
//   node scripts/catalog-fetch.mjs --out <dir>      (needs `pnpm build:server`: it uses the compiled verifier)
// Writes <dir>/index.json + <dir>/<id>/... + catalog.json + catalog.json.sig, the layout `pnpm catalog:verify <dir>`
// and the daemon read. Used by `pnpm package` (the offline seed) and by Harbor CI's official-catalog job, which
// checks that THIS commit still loads every published app (decision 159).
// "Latest" is resolved once to its tag c<serial>; all three files come from releases/download/c<serial>, so a
// release landing mid-download can never mix two bundles.
//   HARBOR_CATALOG_BUNDLE=<dir>      use catalog.zip/catalog.json/catalog.json.sig from <dir> instead of downloading
//   HARBOR_CATALOG_PUBLIC_KEY=<b64>  trust this SPKI key instead of the official one (local tests only)
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NO_RELEASE = 'is there a published catalog release on carlosalaniz/harbor-apps?';

export async function loadCatalogLibs() {
  const dist = (f) => path.join(ROOT, 'dist', 'packages', f);
  if (!existsSync(dist('catalog-bundle.js')) || !existsSync(dist('catalog.js'))) throw new Error('dist/packages is missing: run pnpm build:server first');
  return {
    bundleLib: await import(pathToFileURL(dist('catalog-bundle.js')).href),
    catalogLib: await import(pathToFileURL(dist('catalog.js')).href),
  };
}

async function fetchAsset(url, max) {
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow', signal: globalThis.AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (${NO_RELEASE})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > max) throw new Error(`${url}: ${bytes.length} bytes exceeds ${max}`);
  return bytes;
}

// The serial and download base of the latest release (the Location of releases/latest names tag c<serial>).
async function resolveCatalogTag(bundleLib) {
  const releases = bundleLib.catalogReleasesBase(bundleLib.OFFICIAL_CATALOG_URL);
  console.log(`resolving ${releases}/latest`);
  const res = await fetch(`${releases}/latest`, { redirect: 'manual', signal: globalThis.AbortSignal.timeout(60_000) });
  if (res.status < 300 || res.status > 399) throw new Error(`${releases}/latest: HTTP ${res.status}, expected a redirect to the latest tag (${NO_RELEASE})`);
  let serial;
  try {
    serial = bundleLib.catalogTagFromLocation(res.headers.get('location'), releases);
  } catch (e) {
    // GitHub sends releases/latest to the bare releases page while no release exists
    throw new Error(`${e.message} (${NO_RELEASE})`, { cause: e });
  }
  return { serial, url: bundleLib.catalogDownloadBase(releases, serial) };
}

// Fetch (or read from HARBOR_CATALOG_BUNDLE) and verify one bundle end to end. Throws when nothing verifies.
//   -> { bundle: { meta, files }, raw: { meta, sig, zip }, source, key, official }
export async function fetchCatalogBundle(bundleLib, env = process.env) {
  const key = env.HARBOR_CATALOG_PUBLIC_KEY ?? bundleLib.OFFICIAL_CATALOG_PUBLIC_KEY;
  if (key !== bundleLib.OFFICIAL_CATALOG_PUBLIC_KEY) console.warn('WARNING: HARBOR_CATALOG_PUBLIC_KEY overrides the official catalog key; for local testing only');
  const local = env.HARBOR_CATALOG_BUNDLE;
  const pinned = local ? null : await resolveCatalogTag(bundleLib);
  const source = pinned ? pinned.url : path.resolve(env.INIT_CWD ?? process.cwd(), local);
  const raw = {};
  for (const [k, name] of Object.entries(bundleLib.BUNDLE_FILES)) {
    const max = k === 'zip' ? bundleLib.MAX_BUNDLE_ZIP_BYTES : bundleLib.MAX_BUNDLE_META_BYTES;
    raw[k] = local ? readFileSync(path.join(source, name)) : await fetchAsset(`${source}/${name}`, max);
  }
  let bundle;
  try {
    bundle = bundleLib.openBundle({ meta: raw.meta, sig: raw.sig.toString('utf8'), zip: raw.zip }, [key]);
    if (pinned && bundle.meta.serial !== pinned.serial) throw new Error(`tag c${pinned.serial} carries a catalog with serial ${bundle.meta.serial}`);
  } catch (e) {
    throw new Error(`app catalog from ${source}: ${e.message}`, { cause: e });
  }
  console.log(`app catalog serial ${bundle.meta.serial} (${bundle.meta.createdAt}, commit ${bundle.meta.commit.slice(0, 12)}, ${bundle.meta.packages} packages) from ${source}: signature verified`);
  return { bundle, raw, source, key, official: key === bundleLib.OFFICIAL_CATALOG_PUBLIC_KEY };
}

// Extract a verified bundle into `dir` (catalog layout) and return its index. The metadata and signature are
// written verbatim beside it: the daemon reads the seed serial from them.
export function extractCatalog(dir, fetched, libs) {
  const { bundle, raw } = fetched;
  for (const [name, bytes] of bundle.files) {
    if (path.isAbsolute(name) || name.split('/').some((seg) => seg === '..' || seg === '')) throw new Error(`catalog.zip: unsafe entry ${name}`);
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), bytes);
  }
  writeFileSync(path.join(dir, libs.bundleLib.BUNDLE_FILES.meta), raw.meta);
  writeFileSync(path.join(dir, libs.bundleLib.BUNDLE_FILES.sig), raw.sig);
  const index = libs.catalogLib.readCatalogIndex(dir);
  const ids = Object.keys(index.packages);
  if (!ids.length || ids.length !== bundle.meta.packages) throw new Error(`catalog.zip lists ${ids.length} packages, catalog.json says ${bundle.meta.packages}`);
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const at = args.indexOf('--out');
  const out = at >= 0 ? args[at + 1] : undefined;
  if (!out || out.startsWith('--')) {
    console.error('usage: catalog-fetch.mjs --out <dir>');
    process.exit(2);
  }
  const dir = path.resolve(process.env.INIT_CWD ?? process.cwd(), out);
  try {
    if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty; pass a new or empty directory`);
    mkdirSync(dir, { recursive: true });
    const libs = await loadCatalogLibs();
    const index = extractCatalog(dir, await fetchCatalogBundle(libs.bundleLib), libs);
    console.log(`${dir}: ${Object.keys(index.packages).length} packages`);
  } catch (e) {
    console.error(`catalog-fetch: ${e.message}`);
    process.exit(1);
  }
}
