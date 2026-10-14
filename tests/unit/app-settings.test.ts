// Decision 180: app settings. A package declares typed, non-secret values (integer, number, boolean, string,
// choice); the operator changes them; Harbor renders them as environment literals. Only overrides are stored, so
// a release that changes a default moves every app that kept it. The rules are pure (planner/settings.ts).
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validateManifestReferences, validateManifestShape } from '../../src/packages/manifest.js';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { identityFor } from '../../src/planner/identity.js';
import { renderCompose } from '../../src/planner/render.js';
import { applySettingValues, checkSubmittedSettings, effectiveSettings, installSettingChanges, parseSettingInput, plannedConfigureSettings, plannedInstallSettings, plannedUpdateSettings, pruneOverrides, settingDtos } from '../../src/planner/settings.js';
import { settingLine } from '../../src/cli/plan-summary.js';
import { changedValues, draftOf, optionsSummary, parseDraft, settingText } from '../../web/src/app/setting-draft.js';
import { HarborError } from '../../src/errors.js';
import type { Manifest } from '../../src/contracts/types.js';
import { MINIMAL_COMPOSE, MINIMAL_MANIFEST } from './helpers.js';

const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'x');
const manifestOf = (s: string) => validateManifestShape(y(s));
const composeOf = (s: string) => validateComposeSource(y(s));
const checked = (m: string, c = MINIMAL_COMPOSE) => {
  const manifest = manifestOf(m);
  validateManifestReferences(manifest, composeOf(c));
  return manifest;
};
const refusal = (m: string, c = MINIMAL_COMPOSE): string => {
  try {
    checked(m, c);
  } catch (e) {
    expect(HarborError.is(e), String(e)).toBe(true);
    return [(e as HarborError).message, ...(e as HarborError).details].join('\n');
  }
  throw new Error('accepted');
};

const SETTINGS = `settings:
  - id: context-length
    label: "Context length (tokens)"
    help: "How much text a model keeps in mind. More uses more memory."
    type: integer
    default: 8192
    min: 2048
    max: 131072
    bindings:
      - {service: web, environment: OLLAMA_CONTEXT_LENGTH}
  - id: flash-attention
    label: "Flash attention"
    type: boolean
    default: false
    onValue: "1"
    offValue: "0"
    bindings:
      - {service: web, environment: OLLAMA_FLASH_ATTENTION}
  - id: kv-cache
    label: "Memory cache precision"
    type: choice
    default: f16
    choices:
      - {value: f16, label: "Full precision"}
      - {value: q8_0}
      - {value: q4_0}
    bindings:
      - {service: web, environment: OLLAMA_KV_CACHE_TYPE}
  - id: keep-alive
    label: "Keep models loaded"
    type: string
    default: "5m"
    maxLength: 16
    bindings:
      - {service: web, environment: OLLAMA_KEEP_ALIVE}
      - {service: web, environment: KEEP_ALIVE_NOTE, template: "keep {{value}} please"}
  - id: temperature
    label: "Temperature"
    type: number
    default: 0.8
    min: 0
    max: 2
    bindings:
      - {service: web, environment: TEMPERATURE}
`;
const M = MINIMAL_MANIFEST + SETTINGS;
const one = (body: string) => MINIMAL_MANIFEST + `settings:\n  - id: s\n    label: S\n${body}`;

describe('settings in the package format (decision 180)', () => {
  it('accepts every type with its own rules and keeps them as declared', () => {
    const m = checked(M);
    expect(m.settings?.map((s) => [s.id, s.type, s.default])).toEqual([
      ['context-length', 'integer', 8192],
      ['flash-attention', 'boolean', false],
      ['kv-cache', 'choice', 'f16'],
      ['keep-alive', 'string', '5m'],
      ['temperature', 'number', 0.8],
    ]);
  });
  it('a manifest without settings is unchanged (the field is optional)', () => {
    expect(checked(MINIMAL_MANIFEST).settings).toBeUndefined();
  });
  it('refuses unknown keys and bad shapes (the schema stays closed)', () => {
    expect(() => manifestOf(one('    type: integer\n    default: 1\n    unit: tokens\n    bindings: [{service: web, environment: A}]\n'))).toThrow(HarborError);
    expect(() => manifestOf(one('    type: float\n    default: 1\n    bindings: [{service: web, environment: A}]\n'))).toThrow(HarborError);
    expect(() => manifestOf(one('    type: integer\n    default: 1\n    bindings: [{service: web, environment: A, format: url}]\n'))).toThrow(HarborError);
    expect(() => manifestOf(one('    type: integer\n    default: 1\n    bindings: []\n'))).toThrow(HarborError);
    expect(() => manifestOf(one('    type: string\n    default: "a\\nb"\n    bindings: [{service: web, environment: A}]\n'))).toThrow(HarborError);
    expect(() => manifestOf(MINIMAL_MANIFEST + 'settings:\n  - id: Bad_Id\n    label: S\n    type: boolean\n    default: true\n    bindings: [{service: web, environment: A}]\n')).toThrow(HarborError);
    expect(() => manifestOf(one('    type: string\n    default: x\n    bindings: [{service: web, environment: A, template: "has $HOME {{value}}"}]\n'))).toThrow(HarborError);
  });
  it('refuses a default that does not fit, and rules that belong to another type', () => {
    expect(refusal(one('    type: integer\n    default: 1\n    min: 2\n    bindings: [{service: web, environment: A}]\n'))).toContain('the default 1 does not fit');
    expect(refusal(one('    type: integer\n    default: 1.5\n    bindings: [{service: web, environment: A}]\n'))).toContain('does not fit');
    expect(refusal(one('    type: boolean\n    default: "true"\n    bindings: [{service: web, environment: A}]\n'))).toContain('does not fit');
    expect(refusal(one('    type: choice\n    default: c\n    choices: [{value: a}, {value: b}]\n    bindings: [{service: web, environment: A}]\n'))).toContain('does not fit');
    expect(refusal(one('    type: choice\n    default: a\n    bindings: [{service: web, environment: A}]\n'))).toContain('needs choices');
    expect(refusal(one('    type: choice\n    default: a\n    choices: [{value: a}, {value: a}]\n    bindings: [{service: web, environment: A}]\n'))).toContain('listed twice');
    expect(refusal(one('    type: boolean\n    default: true\n    min: 1\n    bindings: [{service: web, environment: A}]\n'))).toContain('min and max apply to integer and number');
    expect(refusal(one('    type: integer\n    default: 3\n    min: 5\n    max: 1\n    bindings: [{service: web, environment: A}]\n'))).toContain('min is larger than max');
    expect(refusal(one('    type: integer\n    default: 3\n    maxLength: 4\n    bindings: [{service: web, environment: A}]\n'))).toContain('maxLength applies to string');
    expect(refusal(one('    type: string\n    default: x\n    choices: [{value: a}]\n    bindings: [{service: web, environment: A}]\n'))).toContain('choices apply to choice');
    expect(refusal(one('    type: string\n    default: x\n    onValue: "1"\n    bindings: [{service: web, environment: A}]\n'))).toContain('onValue and offValue apply to boolean');
    expect(refusal(one('    type: boolean\n    default: true\n    onValue: "yes"\n    offValue: "yes"\n    bindings: [{service: web, environment: A}]\n'))).toContain('must differ');
    expect(refusal(one('    type: string\n    default: "toolong"\n    maxLength: 3\n    bindings: [{service: web, environment: A}]\n'))).toContain('does not fit');
  });
  it('a duplicate id, an unknown service and a template without its slot are refused', () => {
    expect(refusal(M + '  - id: kv-cache\n    label: Again\n    type: boolean\n    default: true\n    bindings: [{service: web, environment: OTHER}]\n')).toContain('setting id kv-cache is duplicated');
    expect(refusal(one('    type: boolean\n    default: true\n    bindings: [{service: db, environment: A}]\n'))).toContain('settings.s references unknown service db');
    expect(refusal(one('    type: string\n    default: x\n    bindings: [{service: web, environment: A, template: "no slot here"}]\n'))).toContain('template must contain {{value}} exactly once');
  });
  it('a variable a setting binds is its alone: not a compose literal, a secret, a link or another setting', () => {
    const literal = refusal(one('    type: integer\n    default: 1\n    bindings: [{service: web, environment: OLLAMA_NUM_PARALLEL}]\n'), MINIMAL_COMPOSE + '    environment:\n      OLLAMA_NUM_PARALLEL: "1"\n');
    expect(literal).toContain('settings.s targets web.OLLAMA_NUM_PARALLEL, which compose.yaml already sets literally');
    expect(literal).toContain("move that value into the setting's default");
    const secret = MINIMAL_MANIFEST + 'secrets:\n  - id: key\n    bytes: 32\n    encoding: hex\n    retention: retain\n    bindings: [{service: web, environment: API_KEY}]\n' + 'settings:\n  - id: s\n    label: S\n    type: string\n    default: x\n    bindings: [{service: web, environment: API_KEY}]\n';
    expect(refusal(secret)).toContain('settings.s and secrets.key both target web.API_KEY');
    const link = MINIMAL_MANIFEST + 'links:\n  - id: ollama\n    purpose: Models\n    bindings: [{service: web, environment: OLLAMA_URL}]\n' + 'settings:\n  - id: s\n    label: S\n    type: string\n    default: x\n    bindings: [{service: web, environment: OLLAMA_URL}]\n';
    expect(refusal(link)).toContain('settings.s and links.ollama both target web.OLLAMA_URL');
    expect(refusal(M + '  - id: again\n    label: Again\n    type: boolean\n    default: true\n    bindings: [{service: web, environment: OLLAMA_KV_CACHE_TYPE}]\n')).toContain('settings.again and settings.kv-cache both target');
  });
});

describe('rendering settings (pure)', () => {
  const identity = identityFor('0a0a0a0a-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111');
  const endpoints = [{ id: 'web', service: 'web', containerPort: 80, hostPort: 18080 }];
  const compose = composeOf(MINIMAL_COMPOSE);
  const envOf = (m: Manifest, overrides?: Record<string, string | number | boolean>) => {
    const r = renderCompose({ manifest: m, compose, identity, endpoints, secretValues: null, ...(overrides ? { settingOverrides: overrides } : {}) });
    return { env: parseYaml(r.yaml).services.web.environment as Record<string, string>, generated: r.generatedEnv['web'], yaml: r.yaml };
  };

  it('every setting at its default when nothing is stored; booleans use onValue/offValue; templates fill {{value}}', () => {
    const { env, generated } = envOf(manifestOf(M));
    expect(env).toEqual({ OLLAMA_CONTEXT_LENGTH: '8192', OLLAMA_FLASH_ATTENTION: '0', OLLAMA_KV_CACHE_TYPE: 'f16', OLLAMA_KEEP_ALIVE: '5m', KEEP_ALIVE_NOTE: 'keep 5m please', TEMPERATURE: '0.8' });
    expect(generated).toEqual(['KEEP_ALIVE_NOTE', 'OLLAMA_CONTEXT_LENGTH', 'OLLAMA_FLASH_ATTENTION', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_KV_CACHE_TYPE', 'TEMPERATURE']);
  });
  it('overrides win; a stored value the release does not allow falls back to the default', () => {
    const { env } = envOf(manifestOf(M), { 'context-length': 16384, 'flash-attention': true, 'kv-cache': 'q8_0', temperature: 9, gone: 'x' });
    expect(env['OLLAMA_CONTEXT_LENGTH']).toBe('16384');
    expect(env['OLLAMA_FLASH_ATTENTION']).toBe('1');
    expect(env['OLLAMA_KV_CACHE_TYPE']).toBe('q8_0');
    expect(env['TEMPERATURE']).toBe('0.8');
    expect(env['gone']).toBeUndefined();
  });
  it('booleans without onValue/offValue render true/false', () => {
    const m = manifestOf(one('    type: boolean\n    default: true\n    bindings: [{service: web, environment: FLAG}]\n'));
    expect(envOf(m).env['FLAG']).toBe('true');
    expect(envOf(m, { s: false }).env['FLAG']).toBe('false');
  });
  it('a $ in a value never expands a variable: it is escaped for Compose like every literal', () => {
    const { env, yaml } = envOf(manifestOf(M), { 'keep-alive': '$HOME${X}' });
    expect(env['OLLAMA_KEEP_ALIVE']).toBe('$$HOME$${X}');
    expect(env['KEEP_ALIVE_NOTE']).toBe('keep $$HOME$${X} please');
    expect(yaml).not.toMatch(/[^$]\$HOME/);
  });
});

describe('values, plans and submissions (pure)', () => {
  const m = manifestOf(M);

  it('effective values and the overrides worth keeping (unknown and disallowed ones drop out; a chosen default resets)', () => {
    expect(effectiveSettings(m, { 'context-length': 4096 })['context-length']).toBe(4096);
    // an override equal to the default stays: only an update can leave one there, and it is still the operator's
    expect(pruneOverrides(m, { 'context-length': 8192, 'kv-cache': 'q4_0', temperature: 5, unknown: 1 })).toEqual({ 'context-length': 8192, 'kv-cache': 'q4_0' });
    expect(applySettingValues(m, { 'kv-cache': 'q4_0' }, { 'kv-cache': 'f16', 'flash-attention': true })).toEqual({ 'flash-attention': true });
    expect(applySettingValues(m, { 'context-length': 8192 }, { 'flash-attention': true })).toEqual({ 'context-length': 8192, 'flash-attention': true });
    const dtos = settingDtos(m, { 'kv-cache': 'q4_0' });
    expect(dtos.find((d) => d.id === 'kv-cache')).toMatchObject({ value: 'q4_0', default: 'f16', overridden: true, choices: [{ value: 'f16', label: 'Full precision' }, { value: 'q8_0', label: 'q8_0' }, { value: 'q4_0', label: 'q4_0' }] });
    expect(dtos.find((d) => d.id === 'context-length')).toMatchObject({ value: 8192, overridden: false, min: 2048, max: 131072, maxLength: null, help: 'How much text a model keeps in mind. More uses more memory.' });
    expect(dtos.find((d) => d.id === 'keep-alive')?.maxLength).toBe(16);
  });

  it('install plans ask about every setting at its default and say so in one change line', () => {
    const planned = plannedInstallSettings(m);
    expect(planned.every((s) => s.ask && s.change === 'new' && s.value === s.default)).toBe(true);
    expect(installSettingChanges(m)).toEqual(['Apply its 5 settings (Context length (tokens): 8192, Flash attention: off, Memory cache precision: Full precision (f16), Keep models loaded: 5m, Temperature: 0.8), or the values you choose under Options']);
    expect(installSettingChanges(manifestOf(MINIMAL_MANIFEST))).toEqual([]);
    expect(settingLine(planned[0]!)).toBe('Context length (tokens) (context-length): 8192 (default; --set context-length=<value> to choose)');
  });

  it('a submission may only carry allowed values for settings the plan asks about (SETTING_INVALID)', () => {
    const planned = plannedInstallSettings(m);
    expect(checkSubmittedSettings(planned, { 'context-length': 16384, 'flash-attention': true })).toEqual({ 'context-length': 16384, 'flash-attention': true });
    expect(checkSubmittedSettings(planned, undefined)).toEqual({});
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return `${(e as HarborError).code}: ${(e as HarborError).message}`;
      }
      return 'accepted';
    };
    expect(code(() => checkSubmittedSettings(planned, { 'context-length': 1 }))).toBe('SETTING_INVALID: Context length (tokens) (setting context-length) must be a whole number from 2048 to 131072');
    expect(code(() => checkSubmittedSettings(planned, { 'context-length': '16384' }))).toContain('SETTING_INVALID');
    expect(code(() => checkSubmittedSettings(planned, { 'kv-cache': 'q2' }))).toBe('SETTING_INVALID: Memory cache precision (setting kv-cache) must be one of f16, q8_0, q4_0');
    expect(code(() => checkSubmittedSettings(planned, { 'keep-alive': 'a\nb' }))).toContain('text on one line');
    expect(code(() => checkSubmittedSettings(planned, { nope: 1 }))).toBe('SETTING_INVALID: this plan does not ask for setting nope');
    // an update that asks about nothing refuses every value
    expect(code(() => checkSubmittedSettings([], { 'kv-cache': 'f16' }))).toContain('does not ask for setting kv-cache');
  });

  it('configure plans list "old -> new" lines, "back to the default", and skip what does not change', () => {
    const r = plannedConfigureSettings(m, { 'kv-cache': 'q4_0' }, { 'context-length': 16384, 'kv-cache': 'f16', 'flash-attention': false });
    expect(r.changes).toEqual(['Context length (tokens): 8192 -> 16384', 'Memory cache precision: q4_0 -> Full precision (f16) (back to the default)']);
    expect(r.values).toEqual({ 'context-length': 16384, 'kv-cache': 'f16' });
    expect(r.settings.map((s) => [s.id, s.change, s.previous, s.value, s.overridden])).toEqual([
      ['context-length', 'set', 8192, 16384, true],
      ['kv-cache', 'set', 'q4_0', 'f16', false],
    ]);
    expect(settingLine(r.settings[1]!)).toBe('Memory cache precision (kv-cache): Full (f16) (q4_0) -> Full precision (f16) (default)'.replace('Full (f16) (q4_0)', 'q4_0'));
    expect(() => plannedConfigureSettings(m, {}, { 'context-length': 999999 })).toThrow(/must be a whole number from 2048 to 131072/);
    expect(() => plannedConfigureSettings(m, {}, { nope: 1 })).toThrow(/has no setting nope/);
  });

  it('update plans: a new setting is asked at its default, a dropped one and a value no longer allowed say so', () => {
    const next = manifestOf(
      MINIMAL_MANIFEST +
        `settings:
  - id: context-length
    label: "Context length (tokens)"
    type: integer
    default: 4096
    min: 2048
    max: 32768
    bindings:
      - {service: web, environment: OLLAMA_CONTEXT_LENGTH}
  - id: kv-cache
    label: "Memory cache precision"
    type: choice
    default: q8_0
    choices: [{value: f16}, {value: q8_0}]
    bindings:
      - {service: web, environment: OLLAMA_KV_CACHE_TYPE}
  - id: parallel
    label: "Parallel requests"
    type: integer
    default: 1
    min: 1
    max: 8
    bindings:
      - {service: web, environment: OLLAMA_NUM_PARALLEL}
`,
    );
    const r = plannedUpdateSettings(m, next, { 'context-length': 65536, 'keep-alive': '10m' });
    expect(r.settings.map((s) => [s.id, s.change, s.ask, s.previous])).toEqual([
      ['context-length', 'reset', false, 65536],
      ['parallel', 'new', true, null],
      ['flash-attention', 'dropped', false, null],
      ['keep-alive', 'dropped', false, '10m'],
      ['temperature', 'dropped', false, null],
    ]);
    expect(r.changes).toEqual([
      'Context length (tokens): your value 65536 is not allowed by this release (it takes a whole number from 2048 to 32768); it goes back to the default 4096',
      'Memory cache precision: the default changes from Full precision (f16) to q8_0 (you kept the default, so the app follows it)',
      'New setting Parallel requests: 1 (the default; change it under Options or later on the app page)',
      'Setting Flash attention is no longer part of this release',
      'Setting Keep models loaded is no longer part of this release; your value 10m is dropped',
      'Setting Temperature is no longer part of this release',
    ]);
    // the runner's merge keeps only what the new release allows (auto-update keeps flowing)
    expect(applySettingValues(next, { 'context-length': 65536, 'keep-alive': '10m' }, {})).toEqual({});
    expect(applySettingValues(next, { 'context-length': 16384 }, { parallel: 4 })).toEqual({ 'context-length': 16384, parallel: 4 });
    // the same release twice: nothing to say
    expect(plannedUpdateSettings(m, m, { 'kv-cache': 'q4_0' })).toEqual({ settings: [], changes: [] });
  });

  it('an update whose new default equals the operator\'s value keeps it as theirs: a later default change does not move it', () => {
    const at = (d: number) => ({ settings: [{ ...m.settings!.find((x) => x.id === 'context-length')!, default: d }] });
    const r1 = at(2048);
    const r2 = at(8192);
    const r3 = at(4096);
    // the operator chose 8192 while the default was 2048
    let stored = applySettingValues(r1, {}, { 'context-length': 8192 });
    expect(stored).toEqual({ 'context-length': 8192 });
    // r2 moves the default onto 8192: nothing to say, and the runner's merge (no values chosen) keeps the override
    expect(plannedUpdateSettings(r1, r2, stored)).toEqual({ settings: [], changes: [] });
    stored = applySettingValues(r2, stored, {});
    expect(stored).toEqual({ 'context-length': 8192 });
    expect(settingDtos(r2, stored)[0]).toMatchObject({ value: 8192, overridden: true });
    // r3 moves the default to 4096: the app stays at 8192, and the plan does not claim the operator kept the default
    expect(plannedUpdateSettings(r2, r3, stored)).toEqual({ settings: [], changes: [] });
    expect(effectiveSettings(r3, applySettingValues(r3, stored, {}))['context-length']).toBe(8192);
    // asking for the default again on the app page means "follow the default" from now on
    const again = plannedConfigureSettings(r2, stored, { 'context-length': 8192 });
    expect(again.values).toEqual({ 'context-length': 8192 });
    expect(again.changes).toEqual(['Context length (tokens): stays 8192, now as the default (a later default change moves it)']);
    expect(applySettingValues(r2, stored, again.values)).toEqual({});
    // with no override, the same request changes nothing
    expect(plannedConfigureSettings(r2, {}, { 'context-length': 8192 }).changes).toEqual([]);
  });

  it('the CLI reads --set text as the setting type', () => {
    expect(parseSettingInput({ id: 'n', label: 'N', type: 'integer' }, '16384')).toBe(16384);
    expect(parseSettingInput({ id: 'n', label: 'N', type: 'number' }, '0.5')).toBe(0.5);
    expect(parseSettingInput({ id: 'b', label: 'B', type: 'boolean' }, 'on')).toBe(true);
    expect(parseSettingInput({ id: 'b', label: 'B', type: 'boolean' }, 'false')).toBe(false);
    expect(parseSettingInput({ id: 's', label: 'S', type: 'string' }, '5m')).toBe('5m');
    expect(() => parseSettingInput({ id: 'n', label: 'N', type: 'integer' }, 'lots')).toThrow(/takes a number/);
    expect(() => parseSettingInput({ id: 'b', label: 'B', type: 'boolean' }, 'maybe')).toThrow(/takes on or off/);
  });
});

describe('the console settings form (web/src/app/setting-draft.ts)', () => {
  const dtos = settingDtos(manifestOf(M), { 'kv-cache': 'q4_0' });
  it('drafts hold what the inputs show; only changed, valid values are sent', () => {
    const draft = draftOf(dtos, (s) => s.value);
    expect(draft['context-length']).toBe('8192');
    expect(draft['flash-attention']).toBe(false);
    expect(changedValues(dtos, draft, (s) => s.value)).toEqual({ values: {}, problem: null, invalid: [] });
    const edited = { ...draft, 'context-length': '16384', 'flash-attention': true, 'kv-cache': 'f16' };
    expect(changedValues(dtos, edited, (s) => s.value)).toEqual({ values: { 'context-length': 16384, 'flash-attention': true, 'kv-cache': 'f16' }, problem: null, invalid: [] });
    expect(changedValues(dtos, { ...draft, 'context-length': '12.5' }, (s) => s.value).problem).toBe('Context length (tokens): a whole number from 2048 to 131072');
    // an entry that cannot be used is counted, not dropped, so the review's Options summary can say so
    expect(changedValues(dtos, { ...draft, 'context-length': '', 'flash-attention': true }, (s) => s.value)).toMatchObject({ values: { 'flash-attention': true }, invalid: ['context-length'] });
    expect(parseDraft(dtos[0]!, '')).toEqual({ problem: 'Context length (tokens): a whole number from 2048 to 131072' });
    expect(settingText(dtos[1]!, true)).toBe('on');
    expect(settingText(dtos[2]!, 'f16')).toBe('Full precision');
  });
  it('the Options summary never says "defaults" while an entry needs fixing', () => {
    expect(optionsSummary(0, 0, null)).toBe('defaults');
    expect(optionsSummary(0, 1, null)).toBe('1 to fix');
    expect(optionsSummary(2, 1, null)).toBe('1 to fix, 2 changed');
    expect(optionsSummary(0, 0, { newCount: 2 })).toBe('2 new, at their defaults');
    expect(optionsSummary(0, 1, { newCount: 2 })).toBe('1 to fix');
  });
});
