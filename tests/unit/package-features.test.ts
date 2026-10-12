import { describe, expect, it } from 'vitest';
import { listCatalog, loadPackage, readCatalogIndex } from '../../src/packages/catalog.js';
import {
  BASELINE,
  BASELINE_VERSION,
  declaredTooLow,
  FEATURE_SCHEMAS,
  FEATURES,
  featureKey,
  harborRequirement,
  maxHarbor,
  requiredHarbor,
  schemaFeatureKeys,
  usedFeaturePaths,
  type HarborFeature,
} from '../../src/packages/features.js';
import { compareVersions } from '../../src/packages/versions.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { MINIMAL_COMPOSE, MINIMAL_MANIFEST, REPO_CATALOG } from './helpers.js';

// Decision 159: the package format only grows, and every field or value after the 0.28.0 baseline names the
// Harbor that first accepts it, so the catalog bundle can stamp minHarbor and older boxes never choke.
const schemaKeys = [...schemaFeatureKeys(FEATURE_SCHEMAS.manifest, 'manifest'), ...schemaFeatureKeys(FEATURE_SCHEMAS.compose, 'compose')];
const manifest = parseRestrictedYaml(Buffer.from(MINIMAL_MANIFEST), 'manifest.yaml');
const withCommand = parseRestrictedYaml(Buffer.from(MINIMAL_COMPOSE + '    command: ["serve", "--port", "80"]\n'), 'compose.yaml');
const plain = parseRestrictedYaml(Buffer.from(MINIMAL_COMPOSE), 'compose.yaml');

describe('package features (decision 159)', () => {
  it('walks every field and enum value of the manifest and compose-source schemas', () => {
    expect(schemaKeys.length).toBeGreaterThan(150);
    for (const k of ['manifest.endpoints.*.kind=api', 'manifest.secrets[].bindings[].encode=url', 'compose.services.*.command', 'compose.services.*.healthcheck.test[]=CMD', 'compose.volumes.*', 'manifest.apiVersion=harbor/v1alpha1']) {
      expect(schemaKeys).toContain(k);
    }
  });

  it('every schema field and value is either baseline or recorded in FEATURES', () => {
    const known = new Set([...BASELINE, ...FEATURES.map(featureKey)]);
    const unrecorded = schemaKeys.filter((k) => !known.has(k));
    expect(
      unrecorded,
      `new package format paths/values not recorded: ${unrecorded.join(', ')}. Add each to FEATURES in src/packages/features.ts ` +
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

  it('FEATURES entries are well formed and newer than the baseline', () => {
    const baseline = new Set(BASELINE);
    for (const f of FEATURES) {
      expect(f.since, featureKey(f)).toMatch(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/); // the index.json minHarbor pattern
      expect(compareVersions(f.since, BASELINE_VERSION), featureKey(f)).toBeGreaterThan(0);
      if (!f.when) expect(baseline.has(featureKey(f)), `${featureKey(f)} is already baseline`).toBe(false);
      expect(f.note.length, featureKey(f)).toBeGreaterThan(0);
    }
  });

  it('nothing the frozen test catalog uses needs a minimum today', () => {
    for (const id of Object.keys(readCatalogIndex(REPO_CATALOG).packages)) {
      const pkg = loadPackage(REPO_CATALOG, id);
      expect(requiredHarbor(pkg.manifest, pkg.compose), id).toBeNull();
    }
    expect(listCatalog(REPO_CATALOG, 'bundled', { harborVersion: BASELINE_VERSION }).every((i) => i.availability === 'available')).toBe(true);
  });

  it('collapses author-chosen keys to * and array items to []', () => {
    const used = usedFeaturePaths(FEATURE_SCHEMAS.compose, 'compose', withCommand);
    expect(used.get('compose.services.*.command')).toEqual([['serve', '--port', '80']]);
    expect(used.get('compose.services.*.command[]')).toEqual(['serve', '--port', '80']);
    expect(used.has('compose.services.web')).toBe(false);
    expect(usedFeaturePaths(FEATURE_SCHEMAS.manifest, 'manifest', manifest).get('manifest.endpoints.*.browserContext')).toEqual(['secure']);
  });

  it('computes the highest version over the fields, values and widened values a package uses', () => {
    const table: HarborFeature[] = [
      { path: 'compose.services.*.command', since: '0.29.0', note: 'pretend command is new' },
      { path: 'manifest.endpoints.*.browserContext', value: 'ordinary', since: '0.31.0', note: 'a value the package does not use' },
      { path: 'manifest.health.expectedStatus[]', when: (v) => v === 200, since: '0.30.0', note: 'a widened limit' },
    ];
    expect(requiredHarbor(manifest, plain, table)).toBe('0.30.0');
    expect(harborRequirement(manifest, withCommand, table)).toEqual({ minHarbor: '0.30.0', because: ['manifest.health.expectedStatus[] (0.30.0)', 'compose.services.*.command (0.29.0)'] });
    expect(requiredHarbor(manifest, withCommand, table.slice(0, 2))).toBe('0.29.0');
    expect(requiredHarbor(manifest, plain, table.slice(0, 2))).toBeNull();
    expect(requiredHarbor(manifest, plain, [{ path: 'manifest.endpoints.*.browserContext', value: 'secure', since: '0.32.0', note: 'used value' }])).toBe('0.32.0');
    expect(requiredHarbor(manifest, withCommand)).toBeNull(); // the real table: command is baseline
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
