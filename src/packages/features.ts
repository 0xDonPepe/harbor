import { COMPOSE_SOURCE_SCHEMA } from '../contracts/compose.schema.js';
import { MANIFEST_SCHEMA } from '../contracts/manifest.schema.js';
import { compareVersions } from './versions.js';

// Decision 159: which Harbor a package needs, computed from the fields it actually uses (StartOS-style:
// stamped at bundle time, never typed by hand). The package format only grows (Umbrel-style): a field or
// value an official package may use is never removed, renamed or narrowed. A new optional field or value
// gets an entry in FEATURES with the Harbor version that first accepts it; the catalog bundle then stamps
// `minHarbor` into index.json, and an older Harbor lists the package as "needs Harbor x.y.z or newer"
// instead of failing to parse it. Pure: no I/O.
//
// Paths: `manifest.` / `compose.` + property names; `*` = a key the author chooses (services, endpoints,
// environment names); `[]` = an array item. `path=value` names one enum/const value of a field.

export interface HarborFeature {
  path: string;
  // only this enum/const value of the field (a new value an older validator refuses)
  value?: string | number | boolean;
  // only values matching this (an existing field whose pattern or limit was widened)
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
  'manifest.apiVersion', 'manifest.apiVersion=harbor/v1alpha1', 'manifest.kind', 'manifest.kind=Application',
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
  'compose.services', 'compose.services.*', 'compose.services.*.image', 'compose.services.*.build', 'compose.services.*.build.context',
  'compose.services.*.build.dockerfile', 'compose.services.*.command', 'compose.services.*.command[]', 'compose.services.*.environment',
  'compose.services.*.environment.*', 'compose.services.*.depends_on', 'compose.services.*.depends_on.*', 'compose.services.*.depends_on.*.condition',
  'compose.services.*.depends_on.*.condition=service_started', 'compose.services.*.depends_on.*.condition=service_healthy',
  'compose.services.*.healthcheck', 'compose.services.*.healthcheck.test', 'compose.services.*.healthcheck.test[]',
  'compose.services.*.healthcheck.test[]=CMD', 'compose.services.*.healthcheck.interval', 'compose.services.*.healthcheck.timeout',
  'compose.services.*.healthcheck.retries', 'compose.services.*.healthcheck.start_period', 'compose.services.*.volumes',
  'compose.services.*.volumes[]', 'compose.services.*.volumes[].type', 'compose.services.*.volumes[].type=volume',
  'compose.services.*.volumes[].source', 'compose.services.*.volumes[].target', 'compose.services.*.volumes[].read_only',
  'compose.volumes', 'compose.volumes.*',
];

export const FEATURE_SCHEMAS = { manifest: MANIFEST_SCHEMA, compose: COMPOSE_SOURCE_SCHEMA } as const;

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode | boolean;
  prefixItems?: readonly SchemaNode[];
  enum?: readonly unknown[];
  const?: unknown;
}

const isNode = (v: unknown): v is SchemaNode => typeof v === 'object' && v !== null && !Array.isArray(v);

export function featureKey(f: Pick<HarborFeature, 'path' | 'value'>): string {
  return f.value === undefined ? f.path : `${f.path}=${String(f.value)}`;
}

// Every field path and every enum/const value (`path=value`) a schema accepts.
export function schemaFeatureKeys(schema: unknown, root: string): string[] {
  const out = new Set<string>();
  const visit = (node: SchemaNode, p: string): void => {
    if (p !== root) out.add(p);
    const values = node.enum ?? ('const' in node ? [node.const] : []);
    for (const v of values) out.add(`${p}=${String(v)}`);
    for (const [k, sub] of Object.entries(node.properties ?? {})) visit(sub, `${p}.${k}`);
    if (isNode(node.additionalProperties)) visit(node.additionalProperties, `${p}.*`);
    for (const sub of node.prefixItems ?? []) visit(sub, `${p}[]`);
    if (isNode(node.items)) visit(node.items, `${p}[]`);
  };
  if (isNode(schema)) visit(schema, root);
  return [...out];
}

// The field paths a document uses, each with every value found at it (guided by the schema, so author-chosen
// keys collapse to `*`). Keys the schema does not know are skipped: the validator refuses them anyway.
export function usedFeaturePaths(schema: unknown, root: string, doc: unknown): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  const visit = (node: SchemaNode, value: unknown, p: string): void => {
    if (p !== root) {
      const seen = out.get(p);
      if (seen) seen.push(value);
      else out.set(p, [value]);
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const sub = node.prefixItems?.[i] ?? node.items;
        if (isNode(sub)) visit(sub, item, `${p}[]`);
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

export function harborRequirement(manifest: unknown, compose: unknown, features: readonly HarborFeature[] = FEATURES): HarborRequirement {
  const used = new Map([...usedFeaturePaths(MANIFEST_SCHEMA, 'manifest', manifest), ...usedFeaturePaths(COMPOSE_SOURCE_SCHEMA, 'compose', compose)]);
  const hits = features.filter((f) => {
    const values = used.get(f.path);
    if (!values) return false;
    if (f.value !== undefined) return values.includes(f.value);
    if (f.when) return values.some((v) => f.when!(v));
    return true;
  });
  hits.sort((a, b) => compareVersions(b.since, a.since) || featureKey(a).localeCompare(featureKey(b)));
  return { minHarbor: hits[0]?.since ?? null, because: hits.map((f) => `${featureKey(f)} (${f.since})`) };
}

// The oldest Harbor that accepts this manifest + compose pair; null = any Harbor that reads the catalog.
export function requiredHarbor(manifest: unknown, compose: unknown, features: readonly HarborFeature[] = FEATURES): string | null {
  return harborRequirement(manifest, compose, features).minHarbor;
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
