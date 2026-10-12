#!/usr/bin/env node
// Record a live qualification result in every bundled package's release.json.
//   node scripts/catalog-qualify.mjs [--catalog <dir>] <run-dir> passed|blocked "note" ["note" ...]
// The catalog dir resolves as in scripts/catalog-dir.mjs (HARBOR_CATALOG_DIR, then ../harbor-apps/apps).
// Only run after `pnpm test:vm -- --fresh` produced the evidence in <run-dir>.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { catalogArg } from './catalog-dir.mjs';

let parsed;
try {
  parsed = catalogArg(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const catalogDir = parsed.dir;
const [runDir, status, ...notes] = parsed.rest;
if (!runDir || !['passed', 'blocked'].includes(status)) { console.error('usage: catalog-qualify.mjs [--catalog <dir>] <run-dir> passed|blocked [notes...]'); process.exit(2); }
const report = JSON.parse(readFileSync(path.join(runDir, 'report.json'), 'utf8'));
const v = report.results.find((r) => r.id === 'A01')?.details?.versions ?? {};
const index = JSON.parse(readFileSync(path.join(catalogDir, 'index.json'), 'utf8'));
for (const id of Object.keys(index.packages)) {
  const file = path.join(catalogDir, id, 'release.json');
  const rel = JSON.parse(readFileSync(file, 'utf8'));
  const appVersions = Object.fromEntries(Object.entries(rel.images).map(([svc, img]) => [svc, img.appVersion ?? img.tag]));
  rel.qualification = {
    status,
    date: report.updatedAt.slice(0, 10),
    node: v.node ?? 'unknown',
    dockerEngine: v.docker ?? 'unknown',
    dockerCompose: v.compose ?? 'unknown',
    hostOs: `${v.ubuntu ?? 'unknown'} ${v.arch ?? ''}`.trim(),
    appVersions,
    notes: [...(rel.qualification.notes ?? []).filter((n) => !n.startsWith('Live run ')), `Live run ${path.basename(runDir)}: ${status}`, ...notes],
  };
  writeFileSync(file, JSON.stringify(rel, null, 2) + '\n');
  console.log(`${id}: qualification ${status} (${rel.qualification.date}, docker ${rel.qualification.dockerEngine}, compose ${rel.qualification.dockerCompose}, node ${rel.qualification.node})`);
}
