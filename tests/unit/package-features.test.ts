import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEALTHCHECK_BOUNDS } from '../../src/contracts/compose.schema.js';
import { parseDuration } from '../../src/contracts/patterns.js';
import { listCatalog, loadPackage, readCatalogIndex } from '../../src/packages/catalog.js';
import {
  BASELINE,
  BASELINE_VERSION,
  checkConstraintSnapshot,
  checkEntries,
  CODE_CONSTRAINTS,
  CODE_RULES,
  codeConstraints,
  compareConstraints,
  computeRequiredHarbor,
  declaredTooLow,
  describeFormat,
  describeSchema,
  FEATURE_SCHEMAS,
  FEATURES,
  featureKey,
  harborRequirement,
  maxHarbor,
  renderConstraintSnapshot,
  SNAPSHOT_UPDATE_COMMAND,
  snapshotEntries,
  usedFeaturePaths,
  type AcknowledgedNarrowing,
  type ConstraintSnapshot,
  type Constraints,
  type HarborFeature,
} from '../../src/packages/features.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { MINIMAL_COMPOSE, MINIMAL_MANIFEST, REPO_CATALOG } from './helpers.js';

// Decision 159: the package format only grows, and every field or value after the 0.28.0 baseline names the
// Harbor that first accepts it, so the catalog bundle can stamp minHarbor and older boxes never choke.
const format = describeFormat();
const schemaKeys = format.keys;
const constraints = format.constraints;
const SNAPSHOT_FILE = path.resolve(import.meta.dirname, '../../src/packages/features-constraints.json');
const isIndex = (k: string): boolean => k === 'index' || k.startsWith('index.') || k.startsWith('index=');
const readSnapshot = (): ConstraintSnapshot | null => {
  if (!existsSync(SNAPSHOT_FILE)) return null;
  const raw = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) as Partial<ConstraintSnapshot>;
  return { constraints: raw.constraints ?? {}, entries: raw.entries ?? [] };
};

// BASELINE is the 0.28.0 format and closed. These two numbers change only if someone edits it, which is the bug.
const BASELINE_SIZE = 248;
const BASELINE_SHA256 = 'a9fe8530433bb960cc802e5b7cb8cf39a472de431090e7ea457806b5224006db';
const fingerprint = (keys: readonly string[]): string => createHash('sha256').update([...keys].sort().join('\n')).digest('hex');

// In-memory copies of the format for the bypass tests (the real schema files are never touched).
type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const mutated = (root: keyof typeof FEATURE_SCHEMAS, edit: (schema: Mutable) => void, code: Record<string, Constraints> = CODE_CONSTRAINTS): Map<string, Constraints> => {
  const copy = structuredClone(FEATURE_SCHEMAS[root]) as Mutable;
  edit(copy);
  return describeFormat({ ...FEATURE_SCHEMAS, [root]: copy }, code).constraints;
};
const snapshotOf = (c: ReadonlyMap<string, Constraints>, features: readonly HarborFeature[] = [], acks: readonly AcknowledgedNarrowing[] = []): ConstraintSnapshot => ({
  constraints: Object.fromEntries(c),
  entries: snapshotEntries(features, acks),
});
const today = snapshotOf(constraints);
const ENV = 'compose.services.*.environment.*';
const envSchema = (s: Mutable): Mutable => s['properties'].services.additionalProperties.properties.environment.additionalProperties;
const envMax = constraints.get(ENV)!['maxLength'] as number;
const longEnv = (n: number): HarborFeature => ({ path: ENV, when: (v) => typeof v === 'string' && v.length > n, since: '0.29.0', note: `longer than ${n}` });

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
    // today's values are the snapshot test's business (a recorded widening legitimately changes them); here only
    // that the code-enforced rules are merged in and enum/const values are kept with their JSON types
    expect(constraints.get(ENV)).toMatchObject({ 'x-refuses': String(CODE_RULES.interpolation) });
    expect(constraints.get('compose.services.*.healthcheck.interval')).toMatchObject({ 'x-minimumMs': HEALTHCHECK_BOUNDS.intervalMs.min, 'x-maximumMs': HEALTHCHECK_BOUNDS.intervalMs.max });
    expect(constraints.get('manifest.secrets[].bytes')?.['enum']).toContain(format.values.get('manifest.secrets[].bytes=32'));
    // enum/const values keep their JSON type
    const d = describeSchema({ type: 'object', properties: { n: { const: 32 }, s: { const: '32' }, e: { enum: ['b', 'a', 1] } } }, 'manifest');
    expect(d.values.get('manifest.n=32')).toBe(32);
    expect(d.values.get('manifest.s=32')).toBe('32');
    expect(d.constraints.get('manifest.n')).toEqual({ enum: [32] });
    expect(d.constraints.get('manifest.s')).toEqual({ enum: ['32'] });
    expect(d.constraints.get('manifest.e')).toEqual({ enum: ['a', 'b', 1] }); // sorted by JSON text
    expect(() => describeSchema({ enum: [32, '32'] }, 'manifest')).toThrow(/share the string form/);
    expect(() => describeFormat(FEATURE_SCHEMAS, { 'compose.nope': { 'x-maximumMs': 1 } })).toThrow(/CODE_CONSTRAINTS names a path the schemas do not have/);
    expect(() => describeFormat(FEATURE_SCHEMAS, { [ENV]: { 'x-other': 1 } })).toThrow(/not understood/);
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
      { type: 'string', 'x-maximumMs': 5 }, // code constraints come from CODE_CONSTRAINTS only
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
        `with since = the next Harbor release (never to BASELINE: that is the closed 0.28.0 format), so the catalog bundle stamps minHarbor and older ` +
        `Harbors list the package as unavailable instead of failing on it.`,
    ).toEqual([]);
  });

  it('BASELINE is frozen: the 0.28.0 format is closed', () => {
    const message =
      `BASELINE in src/packages/features.ts changed (${BASELINE.length} entries, sha256 ${fingerprint(BASELINE)}). It is the 0.28.0 format and closed: ` +
      `never add, edit or remove an entry. A new path or value goes in FEATURES with since = the next Harbor release, so the bundle stamps minHarbor.`;
    expect(BASELINE.length, message).toBe(BASELINE_SIZE);
    expect(fingerprint(BASELINE), message).toBe(BASELINE_SHA256);
    expect(new Set(BASELINE).size).toBe(BASELINE.length);
    // the fingerprint sees an added key
    expect(fingerprint([...BASELINE, 'index.packages.*.deprecated'])).not.toBe(BASELINE_SHA256);
  });

  it('the format only grows: no baseline or recorded field or value ever leaves the schemas', () => {
    const present = new Set(schemaKeys);
    const gone = [...BASELINE, ...FEATURES.map(featureKey)].filter((k) => !present.has(k));
    expect(
      gone,
      `removed or renamed from the package format: ${gone.join(', ')}. The format only grows (decision 159): keep accepting it and migrate old packages in the engine.`,
    ).toEqual([]);
  });

  it('the format only grows: every node constraint matches the committed snapshot, or its change is recorded', () => {
    const snapshot = readSnapshot() ?? { constraints: {}, entries: [] };
    const current = renderConstraintSnapshot(constraints);
    const { problems, stale } = checkConstraintSnapshot(snapshot, constraints);
    expect(problems, `package format constraints changed:\n  ${problems.join('\n  ')}`).toEqual([]);
    const reordered = !stale.length && existsSync(SNAPSHOT_FILE) && readFileSync(SNAPSHOT_FILE, 'utf8') !== current;
    if ((stale.length || reordered) && process.env['UPDATE_FEATURE_BASELINE'] === '1') {
      writeFileSync(SNAPSHOT_FILE, current);
      return;
    }
    // only reached when every change is recorded (problems is empty)
    expect(
      stale,
      `src/packages/features-constraints.json is out of date for: ${stale.join(', ')}. Every change listed is recorded in src/packages/features.ts, ` +
        `so regenerate the file with \`${SNAPSHOT_UPDATE_COMMAND}\` and commit it.`,
    ).toEqual([]);
    expect(reordered, `src/packages/features-constraints.json is not in schema order: regenerate it with \`${SNAPSHOT_UPDATE_COMMAND}\``).toBe(false);
  });

  it('FEATURES and ACKNOWLEDGED_NARROWING entries are well formed and newer than the baseline', () => {
    expect(checkEntries(format)).toEqual([]);
    const accepts = constraints.get(ENV)!;
    const problems = checkEntries(format, {
      features: [
        { path: 'index.packages.*.minHarbor', since: '0.29.0', note: 'index' },
        { path: 'manifest.secrets[].bytes', value: '32', since: '0.29.0', note: 'wrong JSON type' },
        { path: 'manifest.secrets[].bytes', value: 4095, since: '0.29.0', note: 'not in the schema' },
        { ...longEnv(1) }, // a when entry without accepts
        { path: ENV, accepts, since: '0.29.0', note: 'accepts without when' },
        { path: 'manifest.endpoints.*.kind', value: 'web', since: '0.29.0', note: 'baseline value' },
        { path: 'manifest.nope', since: '0.28.0', note: '' },
      ],
      acknowledged: [
        { path: 'index.packages.*', decision: 170, accepts: {}, note: 'an index narrowing' },
        { path: ENV, decision: 12, accepts, note: 'old decision' },
      ],
    });
    for (const want of [
      /^FEATURES index\.packages\.\*\.minHarbor .*cannot be gated by minHarbor/,
      /^FEATURES manifest\.secrets\[\]\.bytes=32 .*JSON type must be the schema's \(32 \(number\)\)/,
      /^FEATURES manifest\.secrets\[\]\.bytes=4095 .*no such enum\/const value/,
      /^FEATURES compose\.services\.\*\.environment\.\* .*needs accepts/,
      /^FEATURES compose\.services\.\*\.environment\.\* .*accepts belongs to a when entry only/,
      /^FEATURES manifest\.endpoints\.\*\.kind=web .*already baseline/,
      /^FEATURES manifest\.nope .*newer than the 0\.28\.0 baseline/,
      /^FEATURES manifest\.nope .*no such schema path/,
      /^FEATURES manifest\.nope .*needs a note/,
      /^ACKNOWLEDGED_NARROWING index\.packages\.\* .*index\.json paths cannot be acknowledged/,
      /^ACKNOWLEDGED_NARROWING compose\.services\.\*\.environment\.\* \(decision 12\).*>= 159/,
    ]) {
      expect(problems, String(want)).toContainEqual(expect.stringMatching(want));
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
    // enum/const values, with their JSON types
    expect(c({ enum: [32] }, { enum: ['32'] })).toMatchObject({ narrowed: ['enum value 32 (number) removed'], added: ['32'] });
    expect(c({ enum: ['a'] }, { enum: ['a', 'b'] })).toMatchObject({ narrowed: [], widened: [], added: ['b'] });
    expect(c({}, { enum: ['a'] })?.narrowed).toHaveLength(1);
    expect(c({ enum: ['a'] }, {})?.widened).toHaveLength(1);
    // code-enforced rules
    expect(c({ 'x-maximumMs': 300000 }, { 'x-maximumMs': 900000 })).toMatchObject({ widened: ['x-maximumMs 300000 -> 900000'] });
    expect(c({ 'x-minimumMs': 1000 }, { 'x-minimumMs': 5000 })?.narrowed).toHaveLength(1);
    expect(c({ 'x-refuses': '/a/' }, {})?.widened).toHaveLength(1);
    expect(c({ 'x-refuses': '/a/' }, { 'x-refuses': '/b/' })?.unknown).toHaveLength(1);
  });

  it('the snapshot guard: a widening needs a when entry, a narrowing is a violation, an index change needs a new schemaVersion', () => {
    const base: ConstraintSnapshot = { constraints: { manifest: { type: 'object' }, 'manifest.a': { maxLength: 64 }, 'index.packages.*': { additionalProperties: false } }, entries: [] };
    const now = (over: Record<string, Constraints>) => new Map(Object.entries({ ...base.constraints, ...over }));
    const none = { features: [], acknowledged: [], baseline: ['manifest', 'manifest.a', 'index.packages.*'] };
    expect(checkConstraintSnapshot(base, now({}), none)).toEqual({ problems: [], stale: [] });
    // widened, unrecorded -> problem; recorded with `when` + accepts -> accepted, snapshot stale
    const wide = checkConstraintSnapshot(base, now({ 'manifest.a': { maxLength: 128 } }), none);
    expect(wide.problems).toEqual([expect.stringMatching(/^manifest\.a: changed \(maxLength 64 -> 128\)\. If it widens, add a FEATURES entry \{ path: 'manifest\.a', when: .*accepts: \{"maxLength":128\}/)]);
    const recorded: HarborFeature[] = [{ path: 'manifest.a', when: (v) => typeof v === 'string' && v.length > 64, accepts: { maxLength: 128 }, since: '0.29.0', note: 'longer' }];
    expect(checkConstraintSnapshot(base, now({ 'manifest.a': { maxLength: 128 } }), { ...none, features: recorded })).toEqual({
      problems: [],
      stale: [`entry {"accepts":{"maxLength":128},"feature":"manifest.a","since":"0.29.0"}`, 'manifest.a'],
    });
    // a non-when entry on the path does not excuse a widening
    expect(checkConstraintSnapshot(base, now({ 'manifest.a': { maxLength: 128 } }), { ...none, features: [{ path: 'manifest.a', since: '0.29.0', note: 'x' }] }).problems).toHaveLength(1);
    // narrowed -> the format only grows, even with a when entry; an acknowledged narrowing is accepted
    const narrow = checkConstraintSnapshot(base, now({ 'manifest.a': { maxLength: 32 } }), { ...none, features: recorded });
    expect(narrow.problems).toEqual([expect.stringMatching(/^manifest\.a: narrowed \(maxLength 64 -> 32\)\. The format only grows \(decision 159\).*ACKNOWLEDGED_NARROWING entry \{ path: 'manifest\.a', decision: .*accepts: \{"maxLength":32\}/)]);
    const ack: AcknowledgedNarrowing[] = [{ path: 'manifest.a', decision: 170, accepts: { maxLength: 32 }, note: 'deliberate' }];
    expect(checkConstraintSnapshot(base, now({ 'manifest.a': { maxLength: 32 } }), { ...none, acknowledged: ack }).problems).toEqual([]);
    // a new path: recorded in FEATURES -> stale; unrecorded -> a problem that never suggests BASELINE; a new index path -> problem
    expect(checkConstraintSnapshot(base, now({ 'manifest.b': { type: 'string' } }), { ...none, features: [{ path: 'manifest.b', since: '0.29.0', note: 'new' }] }).stale).toContain('manifest.b');
    const unrecorded = checkConstraintSnapshot(base, now({ 'manifest.b': { type: 'string' } }), none).problems;
    expect(unrecorded).toEqual([expect.stringMatching(/^manifest\.b: new path, not recorded\. Add FEATURES \{ path: 'manifest\.b', since: .*never BASELINE/)]);
    expect(checkConstraintSnapshot(base, now({ 'index.packages.*.x': { type: 'string' } }), none).problems).toEqual([expect.stringMatching(/^index\.packages\.\*\.x: new index\.json path\..*new index schemaVersion/)]);
    // a vanished path is a violation
    const gone = new Map(Object.entries(base.constraints));
    gone.delete('manifest.a');
    expect(checkConstraintSnapshot(base, gone, none).problems).toEqual([expect.stringMatching(/^manifest\.a: gone from the schemas\. The format only grows/)]);
  });

  // Each of these is a bypass of the 8aea83c guard, replayed on in-memory copies of the real format.
  it('bypass 1: an ACKNOWLEDGED_NARROWING clears only the narrowed part of a change', () => {
    const wider = mutated('compose', (s) => void (envSchema(s)['maxLength'] = envMax * 2));
    const ack: AcknowledgedNarrowing[] = [{ path: ENV, decision: 170, accepts: wider.get(ENV)!, note: 'not a narrowing' }];
    expect(checkConstraintSnapshot(today, wider, { acknowledged: ack, features: [] }).problems).toEqual([
      expect.stringMatching(/^compose\.services\.\*\.environment\.\*: changed \(maxLength \d+ -> \d+\)\. If it widens, add a FEATURES entry/),
    ]);
    // a mixed change needs both: the ACK for the narrowed part, a when entry for the widened one
    const mixed = mutated('compose', (s) => Object.assign(envSchema(s), { maxLength: envMax * 2, pattern: '^[^\\n]*$' }));
    const both: AcknowledgedNarrowing[] = [{ ...ack[0]!, accepts: mixed.get(ENV)! }];
    expect(checkConstraintSnapshot(today, mixed, { acknowledged: both, features: [] }).problems).toHaveLength(1);
    expect(checkConstraintSnapshot(today, mixed, { acknowledged: both, features: [{ ...longEnv(envMax), accepts: mixed.get(ENV)! }] }).problems).toEqual([]);
  });

  it('bypass 2: an ACKNOWLEDGED_NARROWING never excuses an index.json change', () => {
    const loose = mutated('index', (s) => void delete s['properties'].packages.additionalProperties['additionalProperties']);
    const ack: AcknowledgedNarrowing[] = [{ path: 'index.packages.*', decision: 170, accepts: loose.get('index.packages.*')!, note: 'x' }];
    expect(checkConstraintSnapshot(today, loose, { acknowledged: ack, features: [] }).problems).toEqual([
      expect.stringMatching(/^index\.packages\.\*: index\.json format changed \(additionalProperties false -> unset\)\..*new index schemaVersion/),
    ]);
    expect(checkEntries(format, { acknowledged: ack, features: [] })).toEqual([expect.stringMatching(/index\.json paths cannot be acknowledged/)]);
  });

  it('bypass 3: an entry covers only the state it accepted; a later change needs a new entry, and committed entries are pinned', () => {
    const at8k = mutated('compose', (s) => void (envSchema(s)['maxLength'] = envMax * 2));
    const first: HarborFeature = { ...longEnv(envMax), accepts: at8k.get(ENV)! };
    expect(checkConstraintSnapshot(today, at8k, { features: [first] }).problems).toEqual([]);
    // committed: the snapshot now holds envMax*2 and pins the entry
    const committed = snapshotOf(at8k, [first]);
    const at16k = mutated('compose', (s) => void (envSchema(s)['maxLength'] = envMax * 4));
    expect(checkConstraintSnapshot(committed, at16k, { features: [first] }).problems).toEqual([
      expect.stringMatching(/^compose\.services\.\*\.environment\.\*: changed \(maxLength (\d+) -> \d+\)\. The FEATURES `when` entries on this path accepted \{.*"maxLength":\1.*\} \(0\.29\.0\) only/),
    ]);
    // editing the committed entry instead of adding one is refused (a 0.29.0 Harbor stays at envMax*2)
    const edited: HarborFeature = { ...first, accepts: at16k.get(ENV)! };
    expect(checkConstraintSnapshot(committed, at16k, { features: [edited] }).problems).toEqual([expect.stringMatching(/is pinned in src\/packages\/features-constraints\.json and is now changed or gone.*append-only/)]);
    expect(checkConstraintSnapshot(committed, at8k, { features: [] }).problems).toEqual([expect.stringMatching(/is now changed or gone/)]);
    // a new entry for the new state is accepted, and minHarbor follows the value
    const second: HarborFeature = { ...longEnv(envMax * 2), accepts: at16k.get(ENV)!, since: '0.30.0' };
    expect(checkConstraintSnapshot(committed, at16k, { features: [first, second] }).problems).toEqual([]);
    const env = (n: number) => parseRestrictedYaml(Buffer.from(MINIMAL_COMPOSE + `    environment:\n      LONG: "${'x'.repeat(n)}"\n`), 'compose.yaml');
    expect(computeRequiredHarbor(docs(env(envMax)), [first, second])).toBeNull();
    expect(computeRequiredHarbor(docs(env(envMax + 1)), [first, second])).toBe('0.29.0');
    expect(computeRequiredHarbor(docs(env(envMax * 2 + 1)), [first, second])).toBe('0.30.0');
    // the same for an ACK
    const at2k = mutated('compose', (s) => void (envSchema(s)['maxLength'] = envMax / 2));
    const ack: AcknowledgedNarrowing = { path: ENV, decision: 170, accepts: at2k.get(ENV)!, note: 'x' };
    const at1k = mutated('compose', (s) => void (envSchema(s)['maxLength'] = envMax / 4));
    expect(checkConstraintSnapshot(snapshotOf(at2k, [], [ack]), at1k, { acknowledged: [ack], features: [] }).problems).toEqual([
      expect.stringMatching(/narrowed \(maxLength \d+ -> \d+\).*ACKNOWLEDGED_NARROWING for this path accepted .* only/),
    ]);
  });

  it('bypass 4: a new path is not accepted through BASELINE', () => {
    const deprecated = mutated('index', (s) => void (s['properties'].packages.additionalProperties.properties.deprecated = { type: 'boolean' }));
    // even with the path smuggled into a copy of BASELINE, the index rule holds
    expect(checkConstraintSnapshot(today, deprecated, { baseline: [...BASELINE, 'index.packages.*.deprecated'] }).problems).toEqual([
      expect.stringMatching(/^index\.packages\.\*\.deprecated: new index\.json path/),
    ]);
    const newField = mutated('manifest', (s) => void (s['properties'].metadata.properties.tagline = { type: 'string' }));
    expect(checkConstraintSnapshot(today, newField).problems).toEqual([expect.stringMatching(/^manifest\.metadata\.tagline: new path, not recorded\..*never BASELINE/)]);
    // and the BASELINE copy itself fails the frozen-baseline test
    expect(fingerprint([...BASELINE, 'manifest.metadata.tagline'])).not.toBe(BASELINE_SHA256);
  });

  it('bypass 5: an enum/const value keeps its JSON type (const 32 -> "32" is a change)', () => {
    const asString = mutated('manifest', (s) => {
      const bytes = s['properties'].secrets.items.properties.bytes;
      delete bytes.enum;
      bytes.const = '32';
    });
    expect(asString.get('manifest.secrets[].bytes')).not.toEqual(constraints.get('manifest.secrets[].bytes'));
    const { problems } = checkConstraintSnapshot(today, asString);
    expect(problems).toContainEqual(expect.stringMatching(/^manifest\.secrets\[\]\.bytes: narrowed \(enum value 32 \(number\) removed\)/));
    expect(problems).toContainEqual(expect.stringMatching(/^manifest\.secrets\[\]\.bytes: new enum\/const value "32" \(string\)/));
    // a new value is accepted with a value entry of the same JSON type, not of another
    const with48 = mutated('manifest', (s) => {
      const bytes = s['properties'].secrets.items.properties.bytes;
      bytes.enum = [...((bytes.enum as unknown[] | undefined) ?? [bytes.const]), 48];
      delete bytes.const;
    });
    const v48: HarborFeature = { path: 'manifest.secrets[].bytes', value: 48, since: '0.29.0', note: '48 bytes' };
    expect(checkConstraintSnapshot(today, with48, { features: [v48] }).problems).toEqual([]);
    expect(checkConstraintSnapshot(today, with48, { features: [{ ...v48, value: '48' }] }).problems).toEqual([expect.stringMatching(/new enum\/const value 48 \(number\)/)]);
  });

  it('bypass 6: limits enforced in code (healthcheck durations, interpolation, the secret template slot) are guarded too', () => {
    const interval = 'compose.services.*.healthcheck.interval';
    const maxMs = HEALTHCHECK_BOUNDS.intervalMs.max;
    const longer = describeFormat(FEATURE_SCHEMAS, codeConstraints({ ...CODE_RULES, healthcheck: { ...HEALTHCHECK_BOUNDS, intervalMs: { ...HEALTHCHECK_BOUNDS.intervalMs, max: maxMs * 3 } } })).constraints;
    expect(checkConstraintSnapshot(today, longer).problems).toEqual([expect.stringMatching(new RegExp(`^compose\\.services\\.\\*\\.healthcheck\\.interval: changed \\(x-maximumMs ${maxMs} -> ${maxMs * 3}\\)\\. If it widens`))]);
    const longInterval: HarborFeature = { path: interval, when: (v) => (parseDuration(String(v)) ?? 0) > maxMs, accepts: longer.get(interval)!, since: '0.29.0', note: 'longer intervals' };
    expect(checkConstraintSnapshot(today, longer, { features: [longInterval] }).problems).toEqual([]);
    const hc = (v: string) => parseRestrictedYaml(Buffer.from(MINIMAL_COMPOSE + `    healthcheck:\n      test: ["CMD", "true"]\n      interval: ${v}\n`), 'compose.yaml');
    expect(computeRequiredHarbor(docs(hc(`${maxMs + 1000}ms`)), [longInterval])).toBe('0.29.0');
    expect(computeRequiredHarbor(docs(hc(`${maxMs}ms`)), [longInterval])).toBeNull();
    // a relaxed interpolation rule changes every path it guards
    const relaxed = describeFormat(FEATURE_SCHEMAS, codeConstraints({ ...CODE_RULES, interpolation: /\$\{/ })).constraints;
    const changed = checkConstraintSnapshot(today, relaxed).problems;
    expect(changed).toHaveLength(Object.values(CODE_CONSTRAINTS).filter((c) => 'x-refuses' in c).length);
    expect(changed).toContainEqual(expect.stringMatching(/^compose\.services\.\*\.environment\.\*: changed \(x-refuses /));
    const slot = describeFormat(FEATURE_SCHEMAS, codeConstraints({ ...CODE_RULES, secretTemplateSlot: '{{secret}}' })).constraints;
    expect(checkConstraintSnapshot(today, slot).problems).toEqual([expect.stringMatching(/^manifest\.secrets\[\]\.bindings\[\]\.template: changed \(x-slotOnce /)]);
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
