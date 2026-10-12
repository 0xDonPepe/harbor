#!/usr/bin/env node
// pnpm package — build the relocatable Ubuntu x86-64 release archive:
//   release/harbor-<version>-linux-x64.tar.gz  (+ SHA256SUMS)
// Contents: bin/ launchers, dist/ (compiled daemon+CLI+bootstrap), web/ (built UI), catalog/,
// targets/, node/ (official Node.js linux-x64 runtime, checksum-verified), node_modules/ (production
// deps, hoisted, with better-sqlite3's shipped linux-x64 prebuild), docs/, package.json, release.json.
// No npm/pnpm/compilation happens on the destination host.
// catalog/ is the offline seed (decision 158): the latest signed bundle published by carlosalaniz/harbor-apps,
// verified against the pinned key and extracted (index.json + package dirs + catalog.json + catalog.json.sig).
// "Latest" is resolved once to its tag c<serial>; all three files come from releases/download/c<serial>.
//   HARBOR_CATALOG_BUNDLE=<dir>      use catalog.zip/catalog.json/catalog.json.sig from <dir> instead of downloading
//   HARBOR_CATALOG_PUBLIC_KEY=<b64>  trust this SPKI key instead of the official one (local test builds only;
//                                    recorded in release.json, never set in CI)
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, lstatSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NODE_VERSION = process.env.HARBOR_NODE_VERSION ?? 'v24.12.0';
const TARGET = 'linux-x64';
const name = `harbor-${pkg.version}-${TARGET}`;
const releaseDir = path.join(ROOT, 'release');
const cacheDir = path.join(releaseDir, 'cache');
const stage = path.join(releaseDir, 'stage', name);
const skipBuild = process.argv.includes('--skip-build');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
async function download(url, dest) {
  if (existsSync(dest)) return;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// 1. Build
if (!skipBuild) {
  run('pnpm', ['build']);
}
for (const f of ['dist/daemon.js', 'dist/cli/main.js', 'dist/packages/catalog-bundle.js', 'web/dist/index.html', 'targets/s3/manifest.yaml']) {
  if (!existsSync(path.join(ROOT, f))) throw new Error(`missing build output ${f}`);
}

// 1b. App catalog seed: the signed harbor-apps bundle, verified before anything is staged. No silent empty catalog.
const bundleLib = await import(new URL('../dist/packages/catalog-bundle.js', import.meta.url).href);
const catalogLib = await import(new URL('../dist/packages/catalog.js', import.meta.url).href);
const catalogKey = process.env.HARBOR_CATALOG_PUBLIC_KEY ?? bundleLib.OFFICIAL_CATALOG_PUBLIC_KEY;
if (catalogKey !== bundleLib.OFFICIAL_CATALOG_PUBLIC_KEY) console.warn('WARNING: HARBOR_CATALOG_PUBLIC_KEY overrides the official catalog key; this archive is for local testing only');
async function fetchAsset(url, max) {
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow', signal: globalThis.AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (is there a published catalog release on carlosalaniz/harbor-apps?)`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > max) throw new Error(`${url}: ${bytes.length} bytes exceeds ${max}`);
  return bytes;
}
// Resolve "latest" once (the Location of releases/latest names tag c<serial>) and fetch all three files from that
// fixed tag: per-file `latest/download` requests could mix two bundles when harbor-apps publishes mid-download.
async function resolveCatalogTag() {
  const releases = bundleLib.catalogReleasesBase(bundleLib.OFFICIAL_CATALOG_URL);
  console.log(`resolving ${releases}/latest`);
  const res = await fetch(`${releases}/latest`, { redirect: 'manual', signal: globalThis.AbortSignal.timeout(60_000) });
  if (res.status < 300 || res.status > 399) throw new Error(`${releases}/latest: HTTP ${res.status}, expected a redirect to the latest tag (is there a published catalog release on carlosalaniz/harbor-apps?)`);
  const serial = bundleLib.catalogTagFromLocation(res.headers.get('location'), releases);
  return { serial, url: bundleLib.catalogDownloadBase(releases, serial) };
}
const pinned = process.env.HARBOR_CATALOG_BUNDLE ? null : await resolveCatalogTag();
const catalogSource = pinned ? pinned.url : path.resolve(process.env.INIT_CWD ?? process.cwd(), process.env.HARBOR_CATALOG_BUNDLE);
const bundleRaw = {};
for (const [k, name] of Object.entries(bundleLib.BUNDLE_FILES)) {
  const max = k === 'zip' ? bundleLib.MAX_BUNDLE_ZIP_BYTES : bundleLib.MAX_BUNDLE_META_BYTES;
  bundleRaw[k] = process.env.HARBOR_CATALOG_BUNDLE ? readFileSync(path.join(catalogSource, name)) : await fetchAsset(`${catalogSource}/${name}`, max);
}
let bundle;
try {
  bundle = bundleLib.openBundle({ meta: bundleRaw.meta, sig: bundleRaw.sig.toString('utf8'), zip: bundleRaw.zip }, [catalogKey]);
  if (pinned && bundle.meta.serial !== pinned.serial) throw new Error(`tag c${pinned.serial} carries a catalog with serial ${bundle.meta.serial}`);
} catch (e) {
  console.error(`app catalog from ${catalogSource}: ${e.message}; no release archive was built`);
  process.exit(1);
}
console.log(`app catalog serial ${bundle.meta.serial} (${bundle.meta.createdAt}, commit ${bundle.meta.commit.slice(0, 12)}, ${bundle.meta.packages} packages) from ${catalogSource}: signature verified`);

// 2. Node runtime (official tarball, verified against the published SHASUMS256.txt)
mkdirSync(cacheDir, { recursive: true });
const tarball = `node-${NODE_VERSION}-${TARGET}.tar.xz`;
const tarballPath = path.join(cacheDir, tarball);
const sumsPath = path.join(cacheDir, `SHASUMS256-${NODE_VERSION}.txt`);
await download(`https://nodejs.org/dist/${NODE_VERSION}/${tarball}`, tarballPath);
await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, sumsPath);
const expected = readFileSync(sumsPath, 'utf8').split('\n').find((l) => l.endsWith(`  ${tarball}`))?.split(/\s+/)[0];
if (!expected) throw new Error(`no checksum for ${tarball} in SHASUMS256.txt`);
const actual = sha256(tarballPath);
if (actual !== expected) throw new Error(`Node tarball checksum mismatch: ${actual} != ${expected}`);
console.log(`node ${NODE_VERSION} ${TARGET} sha256 ${actual} verified`);

// 3. Stage
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(path.join(stage, 'node'));
run('tar', ['-xJf', tarballPath, '-C', path.join(stage, 'node'), '--strip-components=1']);
rmSync(path.join(stage, 'node', 'lib', 'node_modules', 'npm'), { recursive: true, force: true }); // npm is not used on the host
rmSync(path.join(stage, 'node', 'lib', 'node_modules', 'corepack'), { recursive: true, force: true });
for (const f of ['CHANGELOG.md', 'README.md', 'bin/npm', 'bin/npx', 'bin/corepack']) {
  try {
    unlinkSync(path.join(stage, 'node', f)); // also removes dangling symlinks
  } catch {
    /* absent */
  }
}
cpSync(path.join(ROOT, 'dist'), path.join(stage, 'dist'), { recursive: true });
cpSync(path.join(ROOT, 'web', 'dist'), path.join(stage, 'web'), { recursive: true });
const stageCatalog = path.join(stage, 'catalog');
for (const [name, bytes] of bundle.files) {
  if (path.isAbsolute(name) || name.split('/').some((seg) => seg === '..' || seg === '')) throw new Error(`catalog.zip: unsafe entry ${name}`);
  mkdirSync(path.dirname(path.join(stageCatalog, name)), { recursive: true });
  writeFileSync(path.join(stageCatalog, name), bytes);
}
writeFileSync(path.join(stageCatalog, bundleLib.BUNDLE_FILES.meta), bundleRaw.meta); // verbatim: the daemon reads the seed serial from it
writeFileSync(path.join(stageCatalog, bundleLib.BUNDLE_FILES.sig), bundleRaw.sig);
const catalogIndex = catalogLib.readCatalogIndex(stageCatalog);
const catalogIds = Object.keys(catalogIndex.packages);
if (!catalogIds.length || catalogIds.length !== bundle.meta.packages) throw new Error(`catalog.zip lists ${catalogIds.length} packages, catalog.json says ${bundle.meta.packages}`);
for (const id of catalogIds) catalogLib.loadPackage(stageCatalog, id); // every seeded package loads exactly as the daemon loads it
cpSync(path.join(ROOT, 'targets'), path.join(stage, 'targets'), { recursive: true }); // backup place packages (decision 152)
cpSync(path.join(ROOT, 'release-assets', 'bin'), path.join(stage, 'bin'), { recursive: true });
for (const b of readdirSync(path.join(stage, 'bin'))) chmodSync(path.join(stage, 'bin', b), 0o755);
mkdirSync(path.join(stage, 'docs'), { recursive: true });
for (const d of ['README.md', 'docs/OPERATOR_GUIDE.md', 'docs/openapi.json', 'TDD.md']) if (existsSync(path.join(ROOT, d))) cpSync(path.join(ROOT, d), path.join(stage, 'docs', path.basename(d)));

// 4. Production dependencies (hoisted layout, no lifecycle scripts; native module comes from shipped prebuilds)
const depStage = path.join(releaseDir, 'stage', `${name}-deps`);
rmSync(depStage, { recursive: true, force: true });
mkdirSync(depStage, { recursive: true });
// Full manifest so --frozen-lockfile matches; --prod skips devDependencies at install time.
cpSync(path.join(ROOT, 'package.json'), path.join(depStage, 'package.json'));
cpSync(path.join(ROOT, 'pnpm-lock.yaml'), path.join(depStage, 'pnpm-lock.yaml'));
writeFileSync(path.join(depStage, '.npmrc'), 'node-linker=hoisted\nsymlink=false\nignore-scripts=true\nside-effects-cache=false\n');
run('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'], { cwd: depStage, env: { ...process.env, npm_config_platform: 'linux', npm_config_arch: 'x64' } });
cpSync(path.join(depStage, 'node_modules'), path.join(stage, 'node_modules'), { recursive: true, dereference: true });
rmSync(path.join(stage, 'node_modules', '.pnpm'), { recursive: true, force: true });
rmSync(path.join(stage, 'node_modules', '.modules.yaml'), { force: true });
// Keep only the prebuild we ship for; the others are dead weight.
const prebuilds = path.join(stage, 'node_modules', 'better-sqlite3', 'prebuilds');
if (!existsSync(path.join(prebuilds, 'linux-x64.node'))) throw new Error('better-sqlite3 linux-x64 prebuild missing');
for (const f of readdirSync(prebuilds)) if (f !== 'linux-x64.node') rmSync(path.join(prebuilds, f));
rmSync(path.join(stage, 'node_modules', 'better-sqlite3', 'deps'), { recursive: true, force: true });
rmSync(depStage, { recursive: true, force: true });
writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module' }, null, 2));

// 5. Release manifest
let commit = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout */
}
writeFileSync(
  path.join(stage, 'release.json'),
  JSON.stringify(
    {
      product: 'harbor',
      version: pkg.version,
      target: TARGET,
      builtAt: new Date().toISOString(),
      commit,
      node: { version: NODE_VERSION, tarball, sha256: actual, source: `https://nodejs.org/dist/${NODE_VERSION}/` },
      packages: Object.fromEntries(Object.entries(catalogIndex.packages).map(([id, e]) => [id, e.revision])),
      catalog: { serial: bundle.meta.serial, commit: bundle.meta.commit, createdAt: bundle.meta.createdAt, source: catalogSource, publicKey: catalogKey, official: catalogKey === bundleLib.OFFICIAL_CATALOG_PUBLIC_KEY },
      dependencies: pkg.dependencies,
    },
    null,
    2,
  ) + '\n',
);

// 6. Archive + checksums (numeric owner 0, sorted entries; mtimes reflect the build)
const archive = path.join(releaseDir, `${name}.tar.gz`);
rmSync(archive, { force: true });
const files = [];
(function walk(dir, rel) {
  for (const e of readdirSync(dir).sort()) {
    const p = path.join(dir, e);
    const r = path.posix.join(rel, e);
    files.push(r);
    if (lstatSync(p).isDirectory()) walk(p, r);
  }
})(stage, name);
const listFile = path.join(releaseDir, 'stage', `${name}.files`);
writeFileSync(listFile, files.join('\n') + '\n');
// bsdtar (macOS) would embed xattr/provenance headers that GNU tar warns about; disable them.
// GNU tar (Linux/CI) does not know --no-xattrs/--no-mac-metadata/--no-acls: use only portable flags there.
const gnu = process.platform !== 'darwin';
const tarArgs = gnu
  ? ['--owner=0', '--group=0', '--numeric-owner', '--sort=name', '-czf', archive, '-C', path.join(releaseDir, 'stage'), '-T', listFile]
  : ['--uid', '0', '--gid', '0', '--numeric-owner', '--no-xattrs', '--no-mac-metadata', '--no-acls', '-czf', archive, '-C', path.join(releaseDir, 'stage'), '-T', listFile, '-n'];
run('tar', tarArgs, { env: { ...process.env, COPYFILE_DISABLE: '1', GZIP: '-n' } });
rmSync(listFile);
const sum = sha256(archive);
writeFileSync(path.join(releaseDir, 'SHA256SUMS'), `${sum}  ${path.basename(archive)}\n`);
const size = (statSync(archive).size / 1024 / 1024).toFixed(1);
console.log(`\n${archive} (${size} MiB)\nsha256 ${sum}\nnode ${NODE_VERSION} ${TARGET}; commit ${commit ?? 'n/a'}; app catalog serial ${bundle.meta.serial} (${catalogIds.length} packages)`);
