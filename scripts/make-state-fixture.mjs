#!/usr/bin/env node
// Builds tests/fixtures/state/<tag>/: a state directory written by an OLD Harbor release (upgrade-jump test).
//
//   node scripts/make-state-fixture.mjs <tag> [tag ...] [--force]
//
// The fixtures are frozen test data: the script refuses a tag whose folder already exists unless --force is given
// (a regenerated fixture gets new ids and keys, so it is a new binary diff, not a refresh).
//
// For each tag it checks the release out into a temporary git worktree OUTSIDE this repository, installs its
// dependencies, and runs scripts/state-fixture/driver.mts with THAT release's own code: its daemon in fake mode
// (FakeDocker, fake Tailscale/Caddy/kernel crypto) driven through its public API. The state directory, the data
// folder (an encrypted app home) and fixture.json (what was made, plus the fake engine's containers/volumes/
// networks) are copied into tests/fixtures/state/<tag>/; the worktree and the scratch root are removed.
// Nothing touches Docker or a live host. pnpm install runs with --prefer-offline, so it only downloads packages that
// are missing from pnpm's cache.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const force = args.includes('--force');
const tags = args.filter((a) => a !== '--force');
if (!tags.length) {
  console.error('usage: node scripts/make-state-fixture.mjs <tag> [tag ...] [--force]   (for example v0.25.0)');
  process.exit(2);
}
const driver = path.join(repo, 'scripts', 'state-fixture', 'driver.mts');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });

for (const tag of tags) {
  if (!/^v\d+\.\d+\.\d+(-[a-z0-9.]+)?$/.test(tag)) throw new Error(`not a release tag: ${tag}`);
  const out = path.join(repo, 'tests', 'fixtures', 'state', tag);
  if (existsSync(out) && !force) throw new Error(`${path.relative(repo, out)} exists and is frozen test data; pass --force to replace it`);
  // A fixed, neutral root: its absolute path is recorded in the state (app homes) and in fixture.json.
  const tmp = realpathSync('/tmp');
  const wt = path.join(tmp, `harbor-old-${tag}`);
  const root = path.join(tmp, `harbor-fixture-${tag}`);
  rmSync(root, { recursive: true, force: true });
  try {
    if (existsSync(wt)) run('git', ['-C', repo, 'worktree', 'remove', '--force', wt]);
    run('git', ['-C', repo, 'worktree', 'add', '--detach', wt, tag]);
    run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--silent'], wt);
    cpSync(driver, path.join(wt, 'fixture-driver.mts'));
    run(path.join(wt, 'node_modules', '.bin', 'tsx'), ['fixture-driver.mts', root], wt);

    // A cleanly closed daemon checkpoints its WAL: the fixture is harbor.db alone.
    const wal = path.join(root, 'state', 'harbor.db-wal');
    if (existsSync(wal) && statSync(wal).size > 0) throw new Error('the old daemon left a non-empty WAL behind');
    rmSync(out, { recursive: true, force: true });
    cpSync(path.join(root, 'state'), path.join(out, 'state'), { recursive: true, filter: (src) => !/harbor\.db-(wal|shm)$/.test(src) });
    cpSync(path.join(root, 'data'), path.join(out, 'data'), { recursive: true });
    writeFileSync(path.join(out, 'fixture.json'), readFileSync(path.join(root, 'fixture.json')));
    if (readdirSync(path.join(out, 'state')).some((f) => /^harbor\.db-/.test(f))) throw new Error('the fixture must hold harbor.db alone');
    console.log(`wrote ${path.relative(repo, out)}`);
  } finally {
    if (existsSync(wt)) run('git', ['-C', repo, 'worktree', 'remove', '--force', wt]);
    rmSync(root, { recursive: true, force: true });
  }
}
