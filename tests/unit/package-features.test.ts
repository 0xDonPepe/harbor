import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listCatalog, loadPackage, readCatalogIndex } from '../../src/packages/catalog.js';
import {
  ACKNOWLEDGED_NARROWING,
  BASELINE,
  BASELINE_VERSION,
  checkConstraintSnapshot,
  compareConstraints,
  computeRequiredHarbor,
  declaredTooLow,
  describeSchema,
  FEATURE_SCHEMAS,
  FEATURES,
  featureKey,
  harborRequirement,
  maxHarbor,
  renderConstraintSnapshot,
  SNAPSHOT_UPDATE_COMMAND,
  usedFeaturePaths,
  type Constraints,
  type HarborFeature,
} from '../../src/packages/features.js';
import { compareVersions } from '../../src/packages/versions.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { MINIMAL_COMPOSE, MINIMAL_MANIFEST, REPO_CATALOG } from './helpers.js';

// Decision 159: the package format only grows, and every field or value after the 0.28.0 baseline names the
// Harbor that first accepts it, so the catalog bundle can stamp minHarbor and older boxes never choke.
const described = Object.entries(FEATURE_SCHEMAS).map(([root, schema]) => describeSchema(schema, root));
const schemaKeys = described.flatMap((d) => d.keys);
const schemaValues = new Map(described.flatMap((d) => [...d.values]));
const constraints = new Map(described.flatMap((d) => [...d.constraints]));
const SNAPSHOT_FILE = path.resolve(import.meta.dirname, '../../src/packages/features-constraints.json');
const isIndex = (k: string): boolean => k === 'index' || k.startsWith('index.') || k.startsWith('index=');

const manifest = parseRestrictedYaml(Buffer.from(MINIMAL_MANIFEST), 'manifest.yaml');
const withCommand = parseRestrictedYaml(Buffer.from(MINIMAL_COMPOSE + '    command: ["serve", "--port", "80"]\n'), 'compose.yaml');
const plain = parseRestrictedYaml(Buffer.from(MINIMAL_COMPOSE), 'compose.yaml');
const docs = (compose: unknown, release?: unknown, m: unknown = manifest) => ({ manifest: m, compose, release });

describe('package features (decision 159)', () => {
  it('walks every field and enum value of the manifest, compose-source, release.json and index schemas', () => {
    expect(schemaKeys.length).toBeGreaterThan(200);
    for (const k of [
      'manifest', 'compose', 'release', 'index', 'manifest.endpoints.*.kind=api', 'manifest.secrets[].bindings[].encode=url', 'compose.services.*.command',
      'compose.services.*.command[0]', 'compose.services.*.command[]', 'compose.services.*.healthcheck.test[0]=CMD', 'compose.volumes.*',
      'manifest.apiVersion=harbor/v1alpha1', 'release.images.*.platform=linux/amd64', 'release.qualification.status=pending', 'index.packages.*.minHarbor',
    ]) {
      expect(schemaKeys).toContain(k);
    }
    expect(schemaKeys).not.toContain('compose.services.*.healthcheck.test[]=CMD'); // a fixed position has its own segment
    expect(schemaValues.get('manifest.secrets[].bytes=32')).toBe(32);
    expect(constraints.get('compose.services.*.environment.*')).toEqual({ maxLength: 4096, type: 'string' });
    expect(constraints.get('compose.services')).toMatchObject({ maxProperties: 16, minProperties: 1, propertyNames: { pattern: expect.any(String) }, type: 'object' });
    expect(constraints.get('manifest')).toMatchObject({ additionalProperties: false, required: expect.arrayContaining(['ui']) });
  });

  it('refuses any schema keyword the walker does not understand (combinators, $ref, patternProperties, ...)', () => {
    for (const bad of [
      { type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'number' }] } } },
      { type: 'object', properties: { a: { oneOf: [{ type: 'string' }] } } },
      { allOf: [{ type: 'object' }] },
      { type: 'object', if: { required: ['a'] }, then: { required: ['b'] } },
      { type: 'object', properties: { a: { not: { const: 1 } } } },
      { $defs: { x: { type: 'string' } }, properties: { a: { $ref: '#/$defs/x' } } },
      { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
      { type: 'object', dependentSchemas: { a: { required: ['b'] } } },
      { type: 'object', unevaluatedProperties: false },
      { type: 'array', items: { type: 'string', default: 'x' } },
      { type: 'object', propertyNames: { anyOf: [{ pattern: 'a' }] } },
    ]) {
      expect(() => describeSchema(bad, 'manifest'), JSON.stringify(bad)).toThrow(/not understood by src\/packages\/features\.ts/);
    }
  });

  it('every schema field and value is either baseline or recorded in FEATURES', () => {
    const known = new Set([...BASELINE, ...FEATURES.map(featureKey)]);
    const unrecorded = schemaKeys.filter((k) => !known.has(k));
    const index = unrecorded.filter(isIndex);
    expect(
      index,
      `index.json format changed: ${index.join(', ')}. Older Harbors reject the WHOLE index on an entry key or value they do not know (minHarbor cannot ` +
        `protect it), so this needs a new index schemaVersion or must stay out of the index.`,
    ).toEqual([]);
    const pkg = unrecorded.filter((k) => !isIndex(k));
    expect(
      pkg,
      `new package format paths/values not recorded: ${pkg.join(', ')}. Add each to FEATURES in src/packages/features.ts ` +
        `with since = the next Harbor release, so the catalog bundle stamps minHarbor and older Harbors list the package as unavailable instead of failing on it.`,
    ).toEqual([]);
  });

  it('the format only grows: no baseline or recorded field or value ever leaves the schemas', () => {
    const present = new Set(schemaKeys);
    const gone = [...BASELINE, ...FEATURES.map(featureKey)].filter((k) => !present.has(k));
    expect(
      gone,
      `removed or renamed from the package format: ${gone.join(', ')}. The format only grows (decision 159): keep accepting it and migrate old packages in the engine.`,
    ).toEqual([]);
    expect(new Set(BASELINE).size).toBe(BASELINE.length);
  });

  it('the format only grows: every node constraint matches the committed snapshot, or its change is recorded', () => {
    const current = renderConstraintSnapshot(constraints);
    const snapshot = existsSync(SNAPSHOT_FILE) ? (JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) as Record<string, Constraints>) : {};
    const { problems, stale } = checkConstraintSnapshot(snapshot, constraints);
    expect(problems, `package format constraints changed:\n  ${problems.join('\n  ')}`).toEqual([]);
    const reordered = !stale.length && existsSync(SNAPSHOT_FILE) && readFileSync(SNAPSHOT_FILE, 'utf8') !== current;
    if ((stale.length || reordered) && process.env['UPDATE_FEATURE_BASELINE'] === '1') {
      writeFileSync(SNAPSHOT_FILE, current);
      return;
    }
    expect(
      stale,
      `src/packages/features-constraints.json is out of date for: ${stale.join(', ')}. The changes are recorded (new paths in FEATURES/BASELINE, ` +
        `widenings with a \`when\` entry, or ACKNOWLEDGED_NARROWING), so regenerate it with \`${SNAPSHOT_UPDATE_COMMAND}\` and commit the file.`,
    ).toEqual([]);
    expect(reordered, `src/packages/features-constraints.json is not in schema order: regenerate it with \`${SNAPSHOT_UPDATE_COMMAND}\``).toBe(false);
  });

  it('FEATURES and ACKNOWLEDGED_NARROWING entries are well formed and newer than the baseline', () => {
    const baseline = new Set(BASELINE);
    const paths = new Set(constraints.keys());
    for (const f of FEATURES) {
      const k = featureKey(f);
      expect(f.since, k).toMatch(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/); // the index.json minHarbor pattern
      expect(compareVersions(f.since, BASELINE_VERSION), k).toBeGreaterThan(0);
      if (!f.when) expect(baseline.has(k), `${k} is already baseline`).toBe(false);
      expect(f.note.length, k).toBeGreaterThan(0);
      expect(isIndex(f.path), `${k}: index.json fields cannot be gated by minHarbor (older Harbors reject the whole index)`).toBe(false);
      expect(paths.has(f.path), `${k}: no such schema path`).toBe(true);
      if (f.value !== undefined) expect(typeof f.value, `${k}: the value's JSON type must be the schema's`).toBe(typeof schemaValues.get(k));
    }
    for (const a of ACKNOWLEDGED_NARROWING) {
      expect(paths.has(a.path), a.path).toBe(true);
      expect(Number.isInteger(a.decision) && a.decision >= 159, a.path).toBe(true);
      expect(a.note.length, a.path).toBeGreaterThan(0);
    }
  });

  it('nothing the frozen test catalog uses needs a minimum today', () => {
    for (const id of Object.keys(readCatalogIndex(REPO_CATALOG).packages)) {
      const pkg = loadPackage(REPO_CATALOG, id);
      expect(computeRequiredHarbor({ manifest: pkg.manifest, compose: pkg.compose, release: pkg.release }), id).toBeNull();
    }
    expect(listCatalog(REPO_CATALOG, 'bundled', { harborVersion: BASELINE_VERSION }).every((i) => i.availability === 'available')).toBe(true);
  });

  it('collapses author-chosen keys to *, array items to [] and fixed positions to [0]; records the root', () => {
    const used = usedFeaturePaths(FEATURE_SCHEMAS.compose, 'compose', withCommand);
    expect(used.get('compose')).toEqual([withCommand]);
    expect(used.get('compose.services.*.command')).toEqual([['serve', '--port', '80']]);
    expect(used.get('compose.services.*.command[0]')).toEqual(['serve']);
    expect(used.get('compose.services.*.command[]')).toEqual(['--port', '80']);
    expect(used.has('compose.services.web')).toBe(false);
    expect(usedFeaturePaths(FEATURE_SCHEMAS.manifest, 'manifest', manifest).get('manifest.endpoints.*.browserContext')).toEqual(['secure']);
  });

  it('computes the highest version over the fields, values and widened values a package uses', () => {
    const table: HarborFeature[] = [
      { path: 'compose.services.*.command', since: '0.29.0', note: 'pretend command is new' },
      { path: 'manifest.endpoints.*.browserContext', value: 'ordinary', since: '0.31.0', note: 'a value the package does not use' },
      { path: 'manifest.health.expectedStatus[]', when: (v) => v === 200, since: '0.30.0', note: 'a widened limit' },
    ];
    expect(computeRequiredHarbor(docs(plain), table)).toBe('0.30.0');
    expect(harborRequirement(docs(withCommand), table)).toEqual({ minHarbor: '0.30.0', because: ['manifest.health.expectedStatus[] (0.30.0)', 'compose.services.*.command (0.29.0)'] });
    expect(computeRequiredHarbor(docs(withCommand), table.slice(0, 2))).toBe('0.29.0');
    expect(computeRequiredHarbor(docs(plain), table.slice(0, 2))).toBeNull();
    expect(computeRequiredHarbor(docs(plain), [{ path: 'manifest.endpoints.*.browserContext', value: 'secure', since: '0.32.0', note: 'used value' }])).toBe('0.32.0');
    expect(computeRequiredHarbor(docs(withCommand))).toBeNull(); // the real table: command is baseline
  });

  it('matches values by their string form and fixed positions only where they are', () => {
    const m = { ...(manifest as object), secrets: [{ id: 'key', source: 'generated', bytes: 32, encoding: 'hex' }] };
    expect(computeRequiredHarbor(docs(plain, undefined, m), [{ path: 'manifest.secrets[].bytes', value: '32', since: '0.29.0', note: 'string form' }])).toBe('0.29.0');
    expect(computeRequiredHarbor(docs(plain, undefined, m), [{ path: 'manifest.secrets[].bytes', value: 32, since: '0.29.0', note: 'number' }])).toBe('0.29.0');
    expect(computeRequiredHarbor(docs(plain, undefined, m), [{ path: 'manifest.secrets[].bytes', value: 64, since: '0.29.0', note: 'unused' }])).toBeNull();
    // `serve` is the program (command[0]); a value feature on the later arguments must not see it, and vice versa
    expect(computeRequiredHarbor(docs(withCommand), [{ path: 'compose.services.*.command[]', value: 'serve', since: '0.29.0', note: 'args' }])).toBeNull();
    expect(computeRequiredHarbor(docs(withCommand), [{ path: 'compose.services.*.command[0]', value: 'serve', since: '0.29.0', note: 'program' }])).toBe('0.29.0');
    expect(computeRequiredHarbor(docs(withCommand), [{ path: 'compose.services.*.command[]', value: '80', since: '0.29.0', note: 'args' }])).toBe('0.29.0');
  });

  it('reads release.json and the document roots (a relaxed top-level required)', () => {
    const release = { schemaVersion: 1, images: { web: { platform: 'linux/arm64' } }, qualification: { status: 'pending' } };
    const table: HarborFeature[] = [
      { path: 'release.images.*.platform', value: 'linux/arm64', since: '0.29.0', note: 'pretend arm64 is new' },
      { path: 'manifest', when: (m) => !('ui' in (m as object)), since: '0.30.0', note: 'pretend ui became optional' },
    ];
    expect(harborRequirement(docs(plain, release), table)).toEqual({ minHarbor: '0.29.0', because: ['release.images.*.platform=linux/arm64 (0.29.0)'] });
    expect(computeRequiredHarbor(docs(plain, undefined), table)).toBeNull();
    const { ui: _ui, ...noUi } = manifest as Record<string, unknown>;
    expect(harborRequirement(docs(plain, release, noUi), table).because).toEqual(['manifest (0.30.0)', 'release.images.*.platform=linux/arm64 (0.29.0)']);
  });

  it('classifies a constraint change as narrowed, widened or of unknown direction', () => {
    const c = (before: Constraints, after: Constraints) => compareConstraints('p', before, after);
    expect(c({ type: 'string', maxLength: 4096 }, { type: 'string', maxLength: 4096 })).toBeNull();
    expect(c({ maxLength: 4096 }, { maxLength: 1024 })).toMatchObject({ narrowed: ['maxLength 4096 -> 1024'], widened: [], unknown: [] });
    expect(c({ maxProperties: 16 }, { maxProperties: 32 })).toMatchObject({ narrowed: [], widened: ['maxProperties 16 -> 32'] });
    expect(c({ maxItems: 16 }, {})).toMatchObject({ widened: ['maxItems 16 -> unset'] });
    expect(c({ minLength: 1 }, { minLength: 2 })?.narrowed).toHaveLength(1);
    expect(c({}, { minimum: 0 })?.narrowed).toHaveLength(1);
    expect(c({ required: ['a', 'b'] }, { required: ['a'] })?.widened).toHaveLength(1);
    expect(c({ required: ['a'] }, { required: ['a', 'b'] })?.narrowed).toHaveLength(1);
    expect(c({ type: 'string' }, { type: ['number', 'string'] })).toMatchObject({ narrowed: [], widened: [expect.any(String)] });
    expect(c({ type: 'integer' }, { type: 'number' })).toMatchObject({ narrowed: [], widened: [expect.any(String)] });
    expect(c({ type: 'number' }, { type: 'integer' })?.narrowed).toHaveLength(1);
    expect(c({ additionalProperties: false }, {})).toMatchObject({ widened: [expect.any(String)] });
    expect(c({}, { additionalProperties: false })?.narrowed).toHaveLength(1);
    expect(c({ uniqueItems: true }, {})?.widened).toHaveLength(1);
    expect(c({ pattern: '^a$' }, { pattern: '^[ab]$' })).toMatchObject({ narrowed: [], widened: [], unknown: [expect.any(String)] });
    expect(c({}, { pattern: '^a$' })?.narrowed).toHaveLength(1);
    expect(c({ format: 'uri' }, {})?.widened).toHaveLength(1);
    expect(c({ propertyNames: { pattern: 'a' } }, { propertyNames: { pattern: 'b' } })?.unknown).toHaveLength(1);
  });

  it('the snapshot guard: a widening needs a when entry, a narrowing is a violation, an index change needs a new schemaVersion', () => {
    const base: Record<string, Constraints> = { manifest: { type: 'object' }, 'manifest.a': { maxLength: 64 }, 'index.packages.*': { additionalProperties: false } };
    const now = (over: Record<string, Constraints>) => new Map(Object.entries({ ...base, ...over }));
    expect(checkConstraintSnapshot(base, now({}), [], [])).toEqual({ problems: [], stale: [] });
    // widened, unrecorded -> problem; recorded with `when` -> accepted, snapshot stale
    const wide = checkConstraintSnapshot(base, now({ 'manifest.a': { maxLength: 128 } }), [], []);
    expect(wide.problems).toEqual([expect.stringMatching(/^manifest\.a: changed \(maxLength 64 -> 128\)\. If it only widens, add a FEATURES entry \{ path: 'manifest\.a', when:/)]);
    const recorded: HarborFeature[] = [{ path: 'manifest.a', when: (v) => typeof v === 'string' && v.length > 64, since: '0.29.0', note: 'longer' }];
    expect(checkConstraintSnapshot(base, now({ 'manifest.a': { maxLength: 128 } }), recorded, [])).toEqual({ problems: [], stale: ['manifest.a'] });
    // a non-when entry on the path does not excuse a widening
    expect(checkConstraintSnapshot(base, now({ 'manifest.a': { maxLength: 128 } }), [{ path: 'manifest.a', since: '0.29.0', note: 'x' }], []).problems).toHaveLength(1);
    // narrowed -> the format only grows, even with a when entry; an acknowledged narrowing is accepted
    const narrow = checkConstraintSnapshot(base, now({ 'manifest.a': { maxLength: 32 } }), recorded, []);
    expect(narrow.problems).toEqual([expect.stringMatching(/^manifest\.a: narrowed \(maxLength 64 -> 32\)\. The format only grows \(decision 159\).*ACKNOWLEDGED_NARROWING/)]);
    expect(checkConstraintSnapshot(base, now({ 'manifest.a': { maxLength: 32 } }), [], [{ path: 'manifest.a', decision: 170, note: 'deliberate' }])).toEqual({ problems: [], stale: ['manifest.a'] });
    // index: any change, even a widening with a when entry
    const idx = checkConstraintSnapshot(base, now({ 'index.packages.*': {} }), [{ path: 'index.packages.*', when: () => true, since: '0.29.0', note: 'x' }], []);
    expect(idx.problems).toEqual([expect.stringMatching(/index\.json format changed.*needs a new index schemaVersion or must stay out of the index/)]);
    // a new path only makes the snapshot stale (the key guard demands its FEATURES entry); a vanished one is a violation
    expect(checkConstraintSnapshot(base, now({ 'manifest.b': { type: 'string' } }), [], [])).toEqual({ problems: [], stale: ['manifest.b'] });
    const gone = new Map(Object.entries(base));
    gone.delete('manifest.a');
    expect(checkConstraintSnapshot(base, gone, [], []).problems).toEqual([expect.stringMatching(/^manifest\.a: gone from the schemas\. The format only grows/)]);
  });

  it('stamps max(declared, computed) and flags a declared value that is too low', () => {
    expect(maxHarbor(null, null)).toBeNull();
    expect(maxHarbor('0.28.0', null)).toBe('0.28.0');
    expect(maxHarbor(undefined, '0.29.0')).toBe('0.29.0');
    expect(maxHarbor('0.28.0', '0.29.0')).toBe('0.29.0');
    expect(maxHarbor('0.30.0', '0.29.0')).toBe('0.30.0');
    expect(declaredTooLow('0.28.0', '0.29.0')).toBe(true);
    expect(declaredTooLow('0.29.0', '0.29.0')).toBe(false);
    expect(declaredTooLow('0.30.0', '0.29.0')).toBe(false);
    expect(declaredTooLow(null, '0.29.0')).toBe(false);
    expect(declaredTooLow('0.28.0', null)).toBe(false);
  });
});
