#!/usr/bin/env node
// Download the latest official app catalog published by carlosalaniz/harbor-apps over HTTPS, check its signature
// (catalog.json.sig, decision 168) when the release carries one, check the zip against its catalog.json, and
// extract it.
//   node scripts/catalog-fetch.mjs --out <dir>      (needs `pnpm build:server`: it uses the compiled bundle code)
// Writes <dir>/index.json + <dir>/<id>/... + catalog.json, the layout `pnpm catalog:verify <dir>`
// and the daemon read. Used by `pnpm package` (the offline seed) and by Harbor CI's official-catalog job, which
// checks that THIS commit still loads every published app (decision 159).
// "Latest" is resolved once to its tag c<serial>; every file comes from releases/download/c<serial>, so a
// release landing mid-download can never mix two bundles.
// Signature: a catalog.json.sig that is there must verify with a pinned release key (src/release-keys.ts), or the
// fetch fails. A missing one is accepted with a warning while the catalog repository starts signing, unless
// HARBOR_REQUIRE_SIGNED_CATALOG=1 (then this CLI, and `pnpm package --require-signature`, refuse it).
//   HARBOR_CATALOG_BUNDLE=<dir>      use catalog.zip/catalog.json(/catalog.json.sig) from <dir> instead of downloading
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NO_RELEASE = 'is there a published catalog release on carlosalaniz/harbor-apps?';
const SIG_FILE = 'catalog.json.sig';

export async function loadCatalogLibs() {
  const dist = (f) => path.join(ROOT, 'dist', f);
  for (const f of ['packages/catalog-bundle.js', 'packages/catalog.js', 'signing.js', 'release-keys.js']) {
    if (!existsSync(dist(f))) throw new Error(`dist/${f} is missing: run pnpm build:server first`);
  }
  return {
    bundleLib: await import(pathToFileURL(dist('packages/catalog-bundle.js')).href),
    catalogLib: await import(pathToFileURL(dist('packages/catalog.js')).href),
    signLib: await import(pathToFileURL(dist('signing.js')).href),
    keys: (await import(pathToFileURL(dist('release-keys.js')).href)).RELEASE_KEYS,
  };
}

// null on 404 when `missingOk` (an optional asset)
async function fetchAsset(url, max, missingOk = false) {
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow', signal: globalThis.AbortSignal.timeout(120_000) });
  if (missingOk && res.status === 404) return null;
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

// The signature verdict for catalog.json: throws on a bad one, and on a missing one when `required`.
// -> the pinned key id that signed it, or null (unsigned, accepted with a warning)
export function checkCatalogSignature(meta, sig, signing, source) {
  const v = signing.signLib.checkSignature(meta, sig, signing.keys);
  if (v.ok) return v.keyId;
  const problem = signing.signLib.signatureProblem(`the app catalog from ${source}`, SIG_FILE, v.reason, signing.keys);
  if (v.reason !== 'missing') throw new Error(problem);
  if (signing.required) throw new Error(`${problem}; HARBOR_REQUIRE_SIGNED_CATALOG=1 asks for a signed catalog`);
  console.warn(`warning: ${problem}; accepted because HARBOR_REQUIRE_SIGNED_CATALOG is not 1`);
  return null;
}

// Fetch (or read from HARBOR_CATALOG_BUNDLE) and check one bundle end to end (signature, zip vs catalog.json,
// schema, zip limits). Throws when the bundle does not check out.
//   signing = { signLib, keys, required }  (loadCatalogLibs gives signLib + keys)
//   -> { bundle: { meta, files }, raw: { meta, zip }, source, official, signedBy }   (official = downloaded, not a local dir)
export async function fetchCatalogBundle(bundleLib, env, signing) {
  const local = env.HARBOR_CATALOG_BUNDLE;
  const pinned = local ? null : await resolveCatalogTag(bundleLib);
  const source = pinned ? pinned.url : path.resolve(env.INIT_CWD ?? process.cwd(), local);
  const raw = {};
  for (const [k, name] of Object.entries(bundleLib.BUNDLE_FILES)) {
    const max = k === 'zip' ? bundleLib.MAX_BUNDLE_ZIP_BYTES : bundleLib.MAX_BUNDLE_META_BYTES;
    raw[k] = local ? readFileSync(path.join(source, name)) : await fetchAsset(`${source}/${name}`, max);
  }
  const sigPath = path.join(source, SIG_FILE);
  const sig = local ? (existsSync(sigPath) ? readFileSync(sigPath) : null) : await fetchAsset(`${source}/${SIG_FILE}`, signing.signLib.MAX_SIGNATURE_BYTES, true);
  let bundle;
  let signedBy;
  try {
    signedBy = checkCatalogSignature(raw.meta, sig, signing, source);
    bundle = bundleLib.openBundle({ meta: raw.meta, zip: raw.zip });
    if (pinned && bundle.meta.serial !== pinned.serial) throw new Error(`tag c${pinned.serial} carries a catalog with serial ${bundle.meta.serial}`);
  } catch (e) {
    throw new Error(`app catalog from ${source}: ${e.message}`, { cause: e });
  }
  console.log(`app catalog serial ${bundle.meta.serial} (${bundle.meta.createdAt}, commit ${bundle.meta.commit.slice(0, 12)}, ${bundle.meta.packages} packages) from ${source}: ${signedBy ? `signed (${signedBy}), ` : 'UNSIGNED, '}checksum verified`);
  return { bundle, raw, source, official: !local, signedBy };
}

// Extract a checked bundle into `dir` (catalog layout) and return its index. catalog.json is written verbatim
// beside it: the daemon reads the seed serial from it.
export function extractCatalog(dir, fetched, libs) {
  const { bundle, raw } = fetched;
  for (const [name, bytes] of bundle.files) {
    if (path.isAbsolute(name) || name.split('/').some((seg) => seg === '..' || seg === '')) throw new Error(`catalog.zip: unsafe entry ${name}`);
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), bytes);
  }
  writeFileSync(path.join(dir, libs.bundleLib.BUNDLE_FILES.meta), raw.meta);
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
    const fetched = await fetchCatalogBundle(libs.bundleLib, process.env, { signLib: libs.signLib, keys: libs.keys, required: process.env.HARBOR_REQUIRE_SIGNED_CATALOG === '1' });
    const index = extractCatalog(dir, fetched, libs);
    console.log(`${dir}: ${Object.keys(index.packages).length} packages`);
  } catch (e) {
    console.error(`catalog-fetch: ${e.message}`);
    process.exit(1);
  }
}
