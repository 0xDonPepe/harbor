// The catalog's upstream-update bot (decision 175): find newer upstream releases of the official apps and
// move a package to one. Runs in harbor-apps CI (.github/workflows/updates.yml) with the latest Harbor release.
//
//   pnpm catalog:upstream check [--catalog <dir>] [--policy <updates.json>] [--only id,id] [--json <file>]
//   pnpm catalog:upstream apply [--catalog <dir>] <id> <service>=<tag> [<service>=<tag> ...]
//
// check reads each app's pinned images (release.json), lists the registry's tags and picks, per group of
// services that move together, the newest tag of the same shape that has a linux/amd64 image at least
// minAgeDays old (default 2: a release gets a couple of days for its hotfix). Infrastructure services
// (databases, caches) stay on their major version; updates.json can hold a service, skip an app, or narrow
// the tags. Prints (or writes) {updates: [...], errors: [...]}; level is the biggest move (major/minor/patch).
//
// apply rewrites compose.yaml to the new tags, raises the revision (manifest and index.json), moves the
// version in release.version and the release notes, pins the digests (scripts/catalog-pin.mjs, which also
// refreshes the hashes) and marks the package `pending` until a smoke run (pnpm catalog:smoke --record)
// proves it on a real Docker host.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadPackage, readCatalogIndex } from '../src/packages/catalog.js';
import { imageVersion } from '../src/packages/version.js';
import { HARBOR_ROOT, catalogArg } from './catalog-dir.mjs';
import { listTags, resolve } from './registry.mjs';
import { checkPolicy, commonCandidates, isDataStore, lockstepGroups, maxLevel, newerTags, replaceVersions, tagVersion, type Candidate, type Level, type UpdatePolicy } from './upstream-tags.js';

export interface UpstreamChange {
  service: string;
  repository: string;
  from: string;
  to: string;
  level: Level;
}
export interface UpstreamUpdate {
  id: string;
  name: string;
  revision: string; // the catalog's revision now; apply raises it by one
  level: Level;
  fromVersion: string | null;
  toVersion: string | null;
  changes: UpstreamChange[];
}

const opt = (args: string[], flag: string): string | null => {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
  args.splice(i, 2);
  return v;
};

function readPolicy(file: string | null): UpdatePolicy {
  if (!file) return { schemaVersion: 1 };
  return checkPolicy(JSON.parse(readFileSync(path.resolve(process.env['INIT_CWD'] ?? process.cwd(), file), 'utf8')));
}

// The version people know for a set of tags: the main endpoint's service, as packageVersionOf() shows it.
function versionFor(pkg: ReturnType<typeof loadPackage>, tags: Record<string, string>): string | null {
  const own = pkg.manifest.release.version?.trim();
  const svc = pkg.manifest.endpoints[pkg.manifest.ui.primaryEndpoint]?.service;
  const tag = svc ? tags[svc] : undefined;
  if (tag) return imageVersion(tagVersion(tag));
  return own || null;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

export async function checkApp(catalogDir: string, id: string, policy: UpdatePolicy, tagCache: Map<string, Promise<string[]>>, now = Date.now()): Promise<UpstreamUpdate | null> {
  const rule = policy.apps?.[id] ?? {};
  if (rule.skip) return null;
  const pkg = loadPackage(catalogDir, id);
  const minAgeMs = (policy.defaults?.minAgeDays ?? 2) * 86_400_000;
  const images = Object.fromEntries(Object.entries(pkg.release.images).filter(([svc]) => !(rule.hold ?? []).includes(svc)).map(([svc, img]) => [svc, { repository: img.repository, tag: img.tag }]));
  const tagsOf = (repo: string) => {
    if (!tagCache.has(repo)) tagCache.set(repo, listTags(repo));
    return tagCache.get(repo)!;
  };
  const changes: UpstreamChange[] = [];
  for (const group of lockstepGroups(images)) {
    const per: Candidate[][] = [];
    for (const svc of group) {
      const img = images[svc]!;
      const infra = pkg.manifest.deployment.services[svc] === 'infrastructure' || isDataStore(img.repository);
      const match = rule.match?.[svc] ? new RegExp(rule.match[svc]!) : undefined;
      per.push(newerTags(img.tag, await tagsOf(img.repository), { withinMajor: infra, ...(match ? { match } : {}) }));
    }
    // the newest common tag that every member publishes for linux/amd64 and that is old enough; five tries
    for (const c of commonCandidates(per).slice(0, 5)) {
      let ok = true;
      for (const svc of group) {
        try {
          const r = await resolve(`${images[svc]!.repository}:${c.tag}`);
          const created = Date.parse(r.config?.created ?? '');
          const was = Date.parse(pkg.release.images[svc]!.imageCreated ?? '');
          if (Number.isFinite(created) && created > 0 && now - created < minAgeMs) ok = false; // too fresh
          if (Number.isFinite(created) && Number.isFinite(was) && created > 0 && was > 0 && created <= was) ok = false; // not newer than what runs
        } catch {
          ok = false; // no linux/amd64 image, or the tag vanished
        }
        if (!ok) break;
      }
      if (!ok) continue;
      for (const svc of group) changes.push({ service: svc, repository: images[svc]!.repository, from: images[svc]!.tag, to: c.tag, level: c.level });
      break;
    }
  }
  if (!changes.length) return null;
  const before = Object.fromEntries(Object.entries(pkg.release.images).map(([svc, img]) => [svc, img.tag]));
  const after = { ...before, ...Object.fromEntries(changes.map((c) => [c.service, c.to])) };
  return {
    id,
    name: pkg.manifest.metadata.name,
    revision: pkg.revision,
    level: maxLevel(changes.map((c) => c.level))!,
    fromVersion: versionFor(pkg, before),
    toVersion: versionFor(pkg, after),
    changes: changes.sort((a, b) => a.service.localeCompare(b.service)),
  };
}

export async function check(catalogDir: string, policy: UpdatePolicy, only: string[] | null): Promise<{ updates: UpstreamUpdate[]; errors: { id: string; message: string }[] }> {
  const ids = Object.keys(readCatalogIndex(catalogDir).packages).filter((id) => !only || only.includes(id)).sort();
  const cache = new Map<string, Promise<string[]>>();
  const updates: UpstreamUpdate[] = [];
  const errors: { id: string; message: string }[] = [];
  await pool(ids, 4, async (id) => {
    try {
      const u = await checkApp(catalogDir, id, policy, cache);
      if (u) updates.push(u);
    } catch (e) {
      errors.push({ id, message: e instanceof Error ? e.message.slice(0, 300) : String(e) });
    }
  });
  return { updates: updates.sort((a, b) => a.id.localeCompare(b.id)), errors: errors.sort((a, b) => a.id.localeCompare(b.id)) };
}

// Line-level edits keep each file as its author wrote it (comments, quoting, order).
export function apply(catalogDir: string, id: string, moves: Record<string, string>, today = new Date().toISOString().slice(0, 10)): { revision: string; fromVersion: string | null; toVersion: string | null } {
  const pkg = loadPackage(catalogDir, id);
  const dir = path.join(catalogDir, id);
  if (!/^\d+$/.test(pkg.revision)) throw new Error(`${id}: revision ${pkg.revision} is not a whole number; raise it by hand`);
  const revision = String(Number(pkg.revision) + 1);
  const before = Object.fromEntries(Object.entries(pkg.release.images).map(([svc, img]) => [svc, img.tag]));
  for (const [svc, tag] of Object.entries(moves)) {
    if (!pkg.release.images[svc]) throw new Error(`${id}: no image service ${svc}`);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new Error(`${id}/${svc}: ${tag} is not an image tag`);
  }
  const after = { ...before, ...moves };

  // compose.yaml: image lines of the moved services go back to repo:tag; catalog-pin pins them again
  const composePath = path.join(dir, 'compose.yaml');
  const lines = readFileSync(composePath, 'utf8').split('\n');
  let service: string | null = null;
  const moved = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const s = /^ {2}([a-z0-9-]+):\s*$/.exec(lines[i]!);
    if (s) service = s[1]!;
    const img = /^(\s+image:\s*)\S+(\s*#\s*tag:\s*\S+)?\s*$/.exec(lines[i]!);
    if (img && service && moves[service]) {
      lines[i] = `${img[1]}${pkg.release.images[service]!.repository}:${moves[service]}`;
      moved.add(service);
    }
  }
  for (const svc of Object.keys(moves)) if (!moved.has(svc)) throw new Error(`${id}/${svc}: no image line found in compose.yaml`);
  writeFileSync(composePath, lines.join('\n'));

  // manifest.yaml: revision + 1; the version words follow the images
  const fromVersion = versionFor(pkg, before);
  const toVersion = versionFor(pkg, after);
  const versionMoves = Object.keys(moves).map((svc) => ({ from: imageVersion(tagVersion(before[svc]!)), to: imageVersion(tagVersion(after[svc]!)) }));
  const manifestPath = path.join(dir, 'manifest.yaml');
  const m = readFileSync(manifestPath, 'utf8').split('\n');
  let block: string | null = null;
  let revised = false;
  for (let i = 0; i < m.length; i++) {
    const top = /^([a-zA-Z]+):/.exec(m[i]!);
    if (top) block = top[1]!;
    if (block === 'release' && /^ {2}revision:/.test(m[i]!)) {
      m[i] = `  revision: "${revision}"`;
      revised = true;
    } else if (block === 'release' && /^ {2}version:/.test(m[i]!) && fromVersion !== toVersion) {
      const cur = /^ {2}version:\s*"?([^"#]*?)"?\s*$/.exec(m[i]!)?.[1] ?? '';
      const next = replaceVersions(cur, versionMoves);
      m[i] = `  version: "${next !== cur ? next : toVersion}"`;
    } else if (block === 'presentation' && /^ {2}releaseNotes:/.test(m[i]!)) {
      m[i] = replaceVersions(m[i]!, versionMoves);
    }
  }
  if (!revised) throw new Error(`${id}: no release.revision line in manifest.yaml`);
  writeFileSync(manifestPath, m.join('\n'));

  // index.json: the same revision (the loader refuses a mismatch)
  const indexPath = path.join(catalogDir, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { packages: Record<string, { revision: string }> };
  index.packages[id]!.revision = revision;
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');

  // release.json: the old qualification described the old images; a smoke run records the new one
  const releasePath = path.join(dir, 'release.json');
  const release = JSON.parse(readFileSync(releasePath, 'utf8'));
  const moveText = Object.keys(moves).sort().map((svc) => `${svc} ${before[svc]} -> ${after[svc]}`).join(', ');
  release.package = { id, revision };
  release.qualification = { status: 'pending', date: today, notes: [`Automatic upstream update ${today} (pnpm catalog:upstream): ${moveText}. Not yet smoke-tested.`] };
  writeFileSync(releasePath, JSON.stringify(release, null, 2) + '\n');

  execFileSync('node', [path.join(HARBOR_ROOT, 'scripts', 'catalog-pin.mjs'), '--catalog', catalogDir, id], { stdio: ['ignore', 'inherit', 'inherit'], cwd: HARBOR_ROOT });
  return { revision, fromVersion, toVersion };
}

async function main(): Promise<void> {
  let parsed: { rest: string[]; dir: string };
  try {
    parsed = catalogArg(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const args = parsed.rest;
  const cmd = args.shift();
  if (cmd === 'check') {
    const policy = readPolicy(opt(args, '--policy'));
    const only = opt(args, '--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
    const jsonOut = opt(args, '--json');
    const result = await check(parsed.dir, policy, only);
    const text = JSON.stringify(result, null, 2) + '\n';
    if (jsonOut) writeFileSync(path.resolve(process.env['INIT_CWD'] ?? process.cwd(), jsonOut), text);
    else process.stdout.write(text);
    for (const u of result.updates) console.error(`${u.id}: ${u.fromVersion ?? '?'} -> ${u.toVersion ?? '?'} (${u.level}; ${u.changes.map((c) => `${c.service} ${c.from} -> ${c.to}`).join(', ')})`);
    for (const e of result.errors) console.error(`${e.id}: could not check: ${e.message}`);
    console.error(`${result.updates.length} update(s), ${result.errors.length} app(s) not checked`);
    return;
  }
  if (cmd === 'apply') {
    const [id, ...pairs] = args;
    if (!id || !pairs.length) throw new Error('usage: catalog-upstream.ts apply [--catalog <dir>] <id> <service>=<tag> ...');
    const moves = Object.fromEntries(pairs.map((p) => {
      const i = p.indexOf('=');
      if (i <= 0) throw new Error(`${p}: want <service>=<tag>`);
      return [p.slice(0, i), p.slice(i + 1)];
    }));
    const r = apply(parsed.dir, id, moves);
    console.log(`${id}: revision ${r.revision}${r.toVersion ? `, version ${r.fromVersion ?? '?'} -> ${r.toVersion}` : ''}; check it with pnpm catalog:verify and prove it with pnpm catalog:smoke`);
    return;
  }
  console.error('usage: catalog-upstream.ts check|apply ... (see the header of scripts/catalog-upstream.ts)');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
