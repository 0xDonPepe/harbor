import { COMPOSE_SOURCE_SCHEMA } from '../contracts/compose.schema.js';
import { MANIFEST_SCHEMA } from '../contracts/manifest.schema.js';
import { CATALOG_INDEX_SCHEMA, RELEASE_SCHEMA } from '../contracts/release.schema.js';
import { compareVersions } from './versions.js';

// Decision 159: which Harbor a package needs, computed from the fields it actually uses (StartOS-style:
// stamped at bundle time, never typed by hand). The package format only grows (Umbrel-style): a field or
// value an official package may use is never removed, renamed or narrowed. A new optional field or value
// gets an entry in FEATURES with the Harbor version that first accepts it; the catalog bundle then stamps
// `minHarbor` into index.json, and an older Harbor lists the package as "needs Harbor x.y.z or newer"
// instead of failing to parse it. Pure: no I/O.
//
// Paths: a root (`manifest`, `compose`, `release` = release.json, `index` = the catalog index.json) + `.`
// property names; `*` = a key the author chooses (services, endpoints, environment names); `[]` = an array
// item; `[0]` = a fixed position (prefixItems). `path=value` names one enum/const value of a field.
// The guard (tests/unit/package-features.test.ts) also snapshots every node's own constraints (type, pattern,
// limits, required, ...) in features-constraints.json: a widened one needs a `when` entry on that path, a
// narrowed one is a format violation (ACKNOWLEDGED_NARROWING, with a decision, for a deliberate one).

export interface HarborFeature {
  path: string;
  // only this enum/const value of the field (a new value an older validator refuses)
  value?: string | number | boolean;
  // only values matching this (an existing field whose pattern, limit, type or required list was widened;
  // on a root path, `value` is the whole document: `{ path: 'manifest', when: (m) => !('ui' in (m as object)) }`)
  when?: (value: unknown) => boolean;
  // the first Harbor release that accepts it ("0.29.0")
  since: string;
  note: string;
}

// Everything the format accepted when the catalog moved out (0.28.0, decision 158) needs no minimum:
// Harbor before 0.28 never fetches the signed catalog. Add new fields and values HERE, with the next
// release version; tests/unit/package-features.test.ts fails for a schema path that is in neither list.
export const FEATURES: readonly HarborFeature[] = [];

export const BASELINE_VERSION = '0.28.0';

// The 0.28.0 format, every field and every enum/const value. Never remove an entry (the format only grows);
// the test fails when one of these disappears from the schemas.
export const BASELINE: readonly string[] = [
  // manifest.yaml
  'manifest', 'manifest.apiVersion', 'manifest.apiVersion=harbor/v1alpha1', 'manifest.kind', 'manifest.kind=Application',
  'manifest.metadata', 'manifest.metadata.id', 'manifest.metadata.name', 'manifest.metadata.description',
  'manifest.defaultCredentials', 'manifest.defaultCredentials.username', 'manifest.defaultCredentials.password', 'manifest.defaultCredentials.note',
  'manifest.hooks', 'manifest.hooks.afterStart', 'manifest.hooks.afterStart.service', 'manifest.hooks.afterStart.user',
  'manifest.hooks.afterStart.command', 'manifest.hooks.afterStart.command[]', 'manifest.hooks.afterStart.timeoutSeconds',
  'manifest.provisionedCredentials', 'manifest.provisionedCredentials.service', 'manifest.provisionedCredentials.passwordEnv',
  'manifest.provisionedCredentials.usernameEnv', 'manifest.provisionedCredentials.username', 'manifest.provisionedCredentials.note',
  'manifest.provisionedCredentials.label',
  'manifest.release', 'manifest.release.revision', 'manifest.release.version',
  'manifest.deployment', 'manifest.deployment.compose', 'manifest.deployment.compose=compose.yaml', 'manifest.deployment.multiInstance',
  'manifest.deployment.services', 'manifest.deployment.services.*', 'manifest.deployment.services.*=application',
  'manifest.deployment.services.*=infrastructure',
  'manifest.endpoints', 'manifest.endpoints.*', 'manifest.endpoints.*.service', 'manifest.endpoints.*.containerPort',
  'manifest.endpoints.*.scheme', 'manifest.endpoints.*.scheme=http', 'manifest.endpoints.*.exposure', 'manifest.endpoints.*.exposure=direct',
  'manifest.endpoints.*.browserContext', 'manifest.endpoints.*.browserContext=secure', 'manifest.endpoints.*.browserContext=ordinary',
  'manifest.endpoints.*.httpsRequired', 'manifest.endpoints.*.kind', 'manifest.endpoints.*.kind=web', 'manifest.endpoints.*.kind=api',
  'manifest.health', 'manifest.health.endpoint', 'manifest.health.path', 'manifest.health.expectedStatus', 'manifest.health.expectedStatus[]',
  'manifest.health.timeoutSeconds', 'manifest.health.deadlineSeconds',
  'manifest.ui', 'manifest.ui.primaryEndpoint',
  'manifest.storage', 'manifest.storage[]', 'manifest.storage[].id', 'manifest.storage[].composeVolume', 'manifest.storage[].purpose',
  'manifest.storage[].retention', 'manifest.storage[].retention=retain', 'manifest.storage[].external', 'manifest.storage[].external.hint',
  'manifest.storage[].external.required', 'manifest.storage[].external.readOnly',
  'manifest.secrets', 'manifest.secrets[]', 'manifest.secrets[].id', 'manifest.secrets[].source', 'manifest.secrets[].source=generated',
  'manifest.secrets[].source=operator', 'manifest.secrets[].bytes', 'manifest.secrets[].bytes=32', 'manifest.secrets[].encoding',
  'manifest.secrets[].encoding=hex', 'manifest.secrets[].prompt', 'manifest.secrets[].optional', 'manifest.secrets[].minLength',
  'manifest.secrets[].maxLength', 'manifest.secrets[].retention', 'manifest.secrets[].retention=retain', 'manifest.secrets[].showOnce',
  'manifest.secrets[].bindings', 'manifest.secrets[].bindings[]', 'manifest.secrets[].bindings[].service', 'manifest.secrets[].bindings[].environment',
  'manifest.secrets[].bindings[].template', 'manifest.secrets[].bindings[].encode', 'manifest.secrets[].bindings[].encode=url',
  'manifest.links', 'manifest.links[]', 'manifest.links[].id', 'manifest.links[].purpose', 'manifest.links[].optional', 'manifest.links[].provider',
  'manifest.links[].provider.packages', 'manifest.links[].provider.packages[]', 'manifest.links[].provider.endpoint', 'manifest.links[].bindings',
  'manifest.links[].bindings[]', 'manifest.links[].bindings[].service', 'manifest.links[].bindings[].environment', 'manifest.links[].bindings[].format',
  'manifest.links[].bindings[].format=url', 'manifest.links[].bindings[].format=authority', 'manifest.links[].bindings[].format=host',
  'manifest.links[].bindings[].format=port',
  'manifest.configuration', 'manifest.configuration[]', 'manifest.configuration[].service', 'manifest.configuration[].environment',
  'manifest.configuration[].endpoint', 'manifest.configuration[].format', 'manifest.configuration[].format=url', 'manifest.configuration[].format=origin',
  'manifest.configuration[].format=authority', 'manifest.configuration[].format=host', 'manifest.configuration[].format=scheme',
  'manifest.setup', 'manifest.setup.endpoint', 'manifest.setup.instructions',
  'manifest.presentation', 'manifest.presentation.tagline', 'manifest.presentation.category', 'manifest.presentation.category=productivity',
  'manifest.presentation.category=media', 'manifest.presentation.category=files', 'manifest.presentation.category=automation',
  'manifest.presentation.category=network', 'manifest.presentation.category=developer', 'manifest.presentation.category=ai',
  'manifest.presentation.category=security', 'manifest.presentation.category=finance', 'manifest.presentation.category=home',
  'manifest.presentation.category=other', 'manifest.presentation.icon', 'manifest.presentation.gallery', 'manifest.presentation.gallery[]',
  'manifest.presentation.developer', 'manifest.presentation.website', 'manifest.presentation.releaseNotes', 'manifest.presentation.sizeHint',
  'manifest.presentation.hideFromHome', 'manifest.presentation.widget', 'manifest.presentation.widget.endpoint', 'manifest.presentation.widget.path',
  'manifest.presentation.widget.kind', 'manifest.presentation.widget.kind=metrics', 'manifest.presentation.widget.kind=list',
  'manifest.presentation.widget.refreshSeconds',
  // compose.yaml (the restricted source subset)
  'compose', 'compose.services', 'compose.services.*', 'compose.services.*.image', 'compose.services.*.build', 'compose.services.*.build.context',
  'compose.services.*.build.dockerfile', 'compose.services.*.command', 'compose.services.*.command[0]', 'compose.services.*.command[]', 'compose.services.*.environment',
  'compose.services.*.environment.*', 'compose.services.*.depends_on', 'compose.services.*.depends_on.*', 'compose.services.*.depends_on.*.condition',
  'compose.services.*.depends_on.*.condition=service_started', 'compose.services.*.depends_on.*.condition=service_healthy',
  'compose.services.*.healthcheck', 'compose.services.*.healthcheck.test', 'compose.services.*.healthcheck.test[0]',
  'compose.services.*.healthcheck.test[0]=CMD', 'compose.services.*.healthcheck.test[]', 'compose.services.*.healthcheck.interval', 'compose.services.*.healthcheck.timeout',
  'compose.services.*.healthcheck.retries', 'compose.services.*.healthcheck.start_period', 'compose.services.*.volumes',
  'compose.services.*.volumes[]', 'compose.services.*.volumes[].type', 'compose.services.*.volumes[].type=volume',
  'compose.services.*.volumes[].source', 'compose.services.*.volumes[].target', 'compose.services.*.volumes[].read_only',
  'compose.volumes', 'compose.volumes.*',
  // release.json
  'release', 'release.schemaVersion', 'release.schemaVersion=1', 'release.package', 'release.package.id', 'release.package.revision',
  'release.files', 'release.files.manifest.yaml', 'release.files.manifest.yaml.sha256', 'release.files.compose.yaml',
  'release.files.compose.yaml.sha256', 'release.files.README.md', 'release.files.README.md.sha256',
  'release.assets', 'release.assets.*', 'release.assets.*.sha256',
  'release.builds', 'release.builds.*', 'release.builds.*.context', 'release.builds.*.dockerfile', 'release.builds.*.commit', 'release.builds.*.tag',
  'release.images', 'release.images.*', 'release.images.*.reference', 'release.images.*.repository', 'release.images.*.tag',
  'release.images.*.platform', 'release.images.*.platform=linux/amd64', 'release.images.*.platformDigest', 'release.images.*.appVersion',
  'release.images.*.imageCreated', 'release.images.*.source',
  'release.qualification', 'release.qualification.status', 'release.qualification.status=passed', 'release.qualification.status=blocked',
  'release.qualification.status=pending', 'release.qualification.date', 'release.qualification.node', 'release.qualification.dockerEngine',
  'release.qualification.dockerCompose', 'release.qualification.hostOs', 'release.qualification.appVersions', 'release.qualification.appVersions.*',
  'release.qualification.notes', 'release.qualification.notes[]',
  // the catalog's index.json (no FEATURES: an older Harbor refuses the whole index on one unknown entry key or value)
  'index', 'index.schemaVersion', 'index.schemaVersion=1', 'index.packages', 'index.packages.*', 'index.packages.*.revision',
  'index.packages.*.dir', 'index.packages.*.minHarbor',
];

// Deliberate narrowings of an existing field (a format violation by default: the format only grows). Each one
// names the decision that accepted breaking the packages that relied on the wider form.
export interface AcknowledgedNarrowing {
  path: string;
  decision: number;
  note: string;
}
export const ACKNOWLEDGED_NARROWING: readonly AcknowledgedNarrowing[] = [];

// The documents of a package, by root: what `computeRequiredHarbor` reads.
export const PACKAGE_SCHEMAS = { manifest: MANIFEST_SCHEMA, compose: COMPOSE_SOURCE_SCHEMA, release: RELEASE_SCHEMA } as const;
// Everything the guard walks. `index` is not a package document: an older Harbor refuses the WHOLE index.json on
// one unknown entry key or value, so index changes cannot be gated by minHarbor (they need a new index schemaVersion).
export const FEATURE_SCHEMAS = { ...PACKAGE_SCHEMAS, index: CATALOG_INDEX_SCHEMA } as const;
export type FeatureRoot = keyof typeof FEATURE_SCHEMAS;

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode | boolean;
  prefixItems?: readonly SchemaNode[];
  enum?: readonly unknown[];
  const?: unknown;
  [keyword: string]: unknown;
}

const isNode = (v: unknown): v is SchemaNode => typeof v === 'object' && v !== null && !Array.isArray(v);

// The walk understands exactly these keywords. Anything else (anyOf/oneOf/allOf, if/then/else, not, $ref/$defs,
// patternProperties, dependentSchemas, unevaluated*, contains, default, ...) throws, so a schema edit that
// introduces one fails the guard until the walker learns it, instead of hiding fields from it.
const CHILD_KEYWORDS = new Set(['properties', 'additionalProperties', 'items', 'prefixItems']);
const VALUE_KEYWORDS = new Set(['enum', 'const']);
const MIN_KEYWORDS = new Set(['minLength', 'minimum', 'exclusiveMinimum', 'minItems', 'minProperties']);
const MAX_KEYWORDS = new Set(['maxLength', 'maximum', 'exclusiveMaximum', 'maxItems', 'maxProperties']);
const OPAQUE_KEYWORDS = new Set(['pattern', 'format', 'multipleOf', 'propertyNames']); // a change has no direction we can tell
const CONSTRAINT_KEYWORDS = new Set([...MIN_KEYWORDS, ...MAX_KEYWORDS, ...OPAQUE_KEYWORDS, 'type', 'required', 'uniqueItems']);
const ANNOTATION_KEYWORDS = new Set(['$schema', '$id', '$comment', 'title', 'description']);
const PROPERTY_NAMES_KEYWORDS = new Set(['pattern', 'minLength', 'maxLength', 'format']);

// A node's own constraints (no child schemas, no enum/const: those are the `path=value` keys), as a stable JSON
// object. A boolean additionalProperties/items is a constraint; a schema there is a child path (`.*`, `[]`).
export type Constraints = Record<string, unknown>;

export interface SchemaDescription {
  // every path and `path=value`
  keys: string[];
  // `path=value` -> the value as the schema states it (its JSON type matters: 64 is not "64")
  values: Map<string, unknown>;
  // path -> that node's own constraints
  constraints: Map<string, Constraints>;
}

export function featureKey(f: Pick<HarborFeature, 'path' | 'value'>): string {
  return f.value === undefined ? f.path : `${f.path}=${String(f.value)}`;
}

const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable) : isNode(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;

// Every field path (the root included: `manifest`), every enum/const value (`path=value`) and every node's own
// constraints. `*` = a key the author chooses, `[]` = an array item, `[0]` = a fixed (prefixItems) position.
export function describeSchema(schema: unknown, root: string): SchemaDescription {
  const keys = new Set<string>();
  const values = new Map<string, unknown>();
  const constraints = new Map<string, Constraints>();
  const visit = (node: SchemaNode, p: string): void => {
    const own: Constraints = {};
    for (const [k, v] of Object.entries(node)) {
      if (ANNOTATION_KEYWORDS.has(k) || VALUE_KEYWORDS.has(k)) continue;
      if (CHILD_KEYWORDS.has(k)) {
        if ((k === 'additionalProperties' || k === 'items') && typeof v === 'boolean') own[k] = v;
        continue;
      }
      if (!CONSTRAINT_KEYWORDS.has(k)) throw new Error(`${p}: schema keyword "${k}" is not understood by src/packages/features.ts; teach describeSchema/usedFeaturePaths about it first`);
      if (k === 'propertyNames') {
        for (const pk of Object.keys(v as object)) if (!PROPERTY_NAMES_KEYWORDS.has(pk)) throw new Error(`${p}: propertyNames keyword "${pk}" is not understood by src/packages/features.ts`);
      }
      own[k] = k === 'required' || (k === 'type' && Array.isArray(v)) ? [...(v as unknown[])].sort() : v;
    }
    if (keys.has(p)) throw new Error(`${p}: two schema nodes share this path`);
    keys.add(p);
    constraints.set(p, stable(own) as Constraints);
    const vals = node.enum ?? ('const' in node ? [node.const] : []);
    for (const v of vals) {
      keys.add(`${p}=${String(v)}`);
      values.set(`${p}=${String(v)}`, v);
    }
    for (const [k, sub] of Object.entries(node.properties ?? {})) visit(sub, `${p}.${k}`);
    if (isNode(node.additionalProperties)) visit(node.additionalProperties, `${p}.*`);
    (node.prefixItems ?? []).forEach((sub, i) => visit(sub, `${p}[${i}]`));
    if (isNode(node.items)) visit(node.items, `${p}[]`);
  };
  if (!isNode(schema)) throw new Error(`${root}: not a schema object`);
  visit(schema, root);
  return { keys: [...keys], values, constraints };
}

export function schemaFeatureKeys(schema: unknown, root: string): string[] {
  return describeSchema(schema, root).keys;
}

// How one node's constraints moved. `narrowed`: an old valid document may now fail (the format only grows, so
// that is a violation). `widened`/`unknown`: a new document may fail on an older Harbor (needs a `when` entry).
export interface ConstraintChange {
  path: string;
  narrowed: string[];
  widened: string[];
  unknown: string[];
}

const typeCovers = (types: unknown[], t: unknown): boolean => types.includes(t) || (t === 'integer' && types.includes('number'));
const asList = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function compareConstraints(path: string, before: Constraints, after: Constraints): ConstraintChange | null {
  const change: ConstraintChange = { path, narrowed: [], widened: [], unknown: [] };
  for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const label = `${k} ${JSON.stringify(a) ?? 'unset'} -> ${JSON.stringify(b) ?? 'unset'}`;
    const into = (dir: 'narrowed' | 'widened' | 'unknown'): void => void change[dir].push(label);
    if (MIN_KEYWORDS.has(k)) into(((b as number | undefined) ?? -Infinity) > ((a as number | undefined) ?? -Infinity) ? 'narrowed' : 'widened');
    else if (MAX_KEYWORDS.has(k)) into(((b as number | undefined) ?? Infinity) < ((a as number | undefined) ?? Infinity) ? 'narrowed' : 'widened');
    else if (k === 'required') {
      if (asList(b).some((r) => !asList(a).includes(r))) into('narrowed');
      if (asList(a).some((r) => !asList(b).includes(r))) into('widened');
    } else if (k === 'type') {
      // no type keyword = any type
      if (b !== undefined && (a === undefined || asList(a).some((t) => !typeCovers(asList(b), t)))) into('narrowed');
      if (a !== undefined && (b === undefined || asList(b).some((t) => !typeCovers(asList(a), t)))) into('widened');
    } else if (k === 'additionalProperties' || k === 'items' || k === 'uniqueItems') {
      // additionalProperties/items: false = refused (unset or a schema = allowed); uniqueItems: true = refused
      const refuses = (v: unknown): boolean => (k === 'uniqueItems' ? v === true : v === false);
      if (refuses(b) !== refuses(a)) into(refuses(b) ? 'narrowed' : 'widened');
    } else if (a === undefined) into('narrowed'); // a new pattern/format/multipleOf/propertyNames
    else if (b === undefined) into('widened');
    else into('unknown');
  }
  return change.narrowed.length || change.widened.length || change.unknown.length ? change : null;
}

// The field paths a document uses, each with every value found at it (guided by the schema, so author-chosen
// keys collapse to `*`). The root itself is recorded too (`manifest` -> the whole document), so a relaxed
// top-level `required` can be expressed as `{ path: 'manifest', when: (m) => !('ui' in m) }`. Keys the schema does
// not know are skipped: the validator refuses them anyway.
export function usedFeaturePaths(schema: unknown, root: string, doc: unknown): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  const visit = (node: SchemaNode, value: unknown, p: string): void => {
    const seen = out.get(p);
    if (seen) seen.push(value);
    else out.set(p, [value]);
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const fixed = node.prefixItems?.[i];
        if (fixed) visit(fixed, item, `${p}[${i}]`);
        else if (isNode(node.items)) visit(node.items, item, `${p}[]`);
      });
    } else if (isNode(value)) {
      for (const [k, v] of Object.entries(value)) {
        const own = node.properties?.[k];
        if (own) visit(own, v, `${p}.${k}`);
        else if (isNode(node.additionalProperties)) visit(node.additionalProperties, v, `${p}.*`);
      }
    }
  };
  if (isNode(schema)) visit(schema, doc, root);
  return out;
}

export interface HarborRequirement {
  minHarbor: string | null;
  // the features that set it ("compose.services.*.command (0.29.0)"), highest first
  because: string[];
}

// One package's documents as loaded (`release` = the parsed release.json). All three are required on purpose:
// pass `undefined` explicitly where a document does not exist.
export interface PackageDocuments {
  manifest: unknown;
  compose: unknown;
  release: unknown;
}

// A YAML/JSON scalar matches a value feature by its string form, so `value: 64` and `value: '64'` behave the same
// (the well-formedness test also pins the feature value's JSON type to the schema's).
const sameValue = (v: unknown, want: HarborFeature['value']): boolean => v !== null && typeof v !== 'object' && String(v) === String(want);

export function harborRequirement(docs: PackageDocuments, features: readonly HarborFeature[] = FEATURES): HarborRequirement {
  const used = new Map<string, unknown[]>();
  for (const [root, schema] of Object.entries(PACKAGE_SCHEMAS)) {
    for (const [p, v] of usedFeaturePaths(schema, root, docs[root as keyof PackageDocuments])) used.set(p, v);
  }
  const hits = features.filter((f) => {
    const values = used.get(f.path);
    if (!values) return false;
    if (f.value !== undefined) return values.some((v) => sameValue(v, f.value));
    if (f.when) return values.some((v) => f.when!(v));
    return true;
  });
  hits.sort((a, b) => compareVersions(b.since, a.since) || featureKey(a).localeCompare(featureKey(b)));
  return { minHarbor: hits[0]?.since ?? null, because: hits.map((f) => `${featureKey(f)} (${f.since})`) };
}

// The oldest Harbor that accepts this package; null = any Harbor that reads the catalog. (Not catalog.ts's
// `requiredHarbor`, which reads the minHarbor an index entry already carries.)
export function computeRequiredHarbor(docs: PackageDocuments, features: readonly HarborFeature[] = FEATURES): string | null {
  return harborRequirement(docs, features).minHarbor;
}

// The higher of two optional versions (what the bundle stamps: max(declared, computed)).
export function maxHarbor(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return compareVersions(a, b) >= 0 ? a : b;
}

// An author who declares minHarbor by hand must not declare it lower than the fields demand.
export function declaredTooLow(declared: string | null | undefined, computed: string | null): boolean {
  return Boolean(declared && computed && compareVersions(declared, computed) < 0);
}

// The guard over the committed constraint snapshot (src/packages/features-constraints.json; used by
// tests/unit/package-features.test.ts). `problems` are format violations or unrecorded changes; `stale` lists the
// paths whose recorded change is accepted but whose snapshot must be regenerated (and committed).
export interface SnapshotCheck {
  problems: string[];
  stale: string[];
}

export const SNAPSHOT_UPDATE_COMMAND = 'UPDATE_FEATURE_BASELINE=1 pnpm test package-features';

export function checkConstraintSnapshot(
  snapshot: Readonly<Record<string, Constraints>>,
  current: ReadonlyMap<string, Constraints>,
  features: readonly HarborFeature[] = FEATURES,
  acknowledged: readonly AcknowledgedNarrowing[] = ACKNOWLEDGED_NARROWING,
): SnapshotCheck {
  const problems: string[] = [];
  const stale: string[] = [];
  for (const path of Object.keys(snapshot)) {
    if (!current.has(path)) problems.push(`${path}: gone from the schemas. The format only grows (decision 159): keep accepting it and migrate old packages in the engine.`);
  }
  for (const [path, now] of current) {
    const before = snapshot[path];
    if (!before) {
      stale.push(path);
      continue;
    }
    const change = compareConstraints(path, before, now);
    if (!change) continue;
    const what = [...change.narrowed, ...change.widened, ...change.unknown].join('; ');
    const ack = acknowledged.find((a) => a.path === path);
    if (path === 'index' || path.startsWith('index.')) {
      if (ack) stale.push(path);
      else problems.push(`${path}: index.json format changed (${what}). Older Harbors reject the WHOLE index on an entry key or value they do not know, so this needs a new index schemaVersion or must stay out of the index.`);
      continue;
    }
    let ok = true;
    if (change.narrowed.length && !ack) {
      ok = false;
      problems.push(
        `${path}: narrowed (${change.narrowed.join('; ')}). The format only grows (decision 159): a published package may rely on the wider form. ` +
          `Revert it, or list it in ACKNOWLEDGED_NARROWING in src/packages/features.ts with the decision that accepts the break.`,
      );
    }
    const loosened = [...change.widened, ...change.unknown];
    if (loosened.length && !ack && !features.some((f) => f.path === path && f.when)) {
      ok = false;
      problems.push(
        `${path}: changed (${loosened.join('; ')}). If it only widens, add a FEATURES entry { path: '${path}', when: (v) => <true for values an older Harbor refuses>, since: <next release> } ` +
          `in src/packages/features.ts; if it narrows, the format only grows (revert it, or ACKNOWLEDGED_NARROWING with a decision).`,
      );
    }
    if (ok) stale.push(path);
  }
  return { problems, stale };
}

// The snapshot file body: one path per line, in schema order, stable JSON (what SNAPSHOT_UPDATE_COMMAND writes).
export function renderConstraintSnapshot(current: ReadonlyMap<string, Constraints>): string {
  return `{\n${[...current].map(([p, c]) => `  ${JSON.stringify(p)}: ${JSON.stringify(c)}`).join(',\n')}\n}\n`;
}
