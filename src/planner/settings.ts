import { SECRET_TEMPLATE_SLOT } from '../contracts/patterns.js';
import type { PlanSettingDto, SettingDto } from '../contracts/api.js';
import type { Manifest, ManifestSetting, SettingValue } from '../contracts/types.js';
import { HarborError } from '../errors.js';

// App settings (decision 180): pure rules for typed, non-secret values the operator can change. Values are
// visible (DTOs, plans, events, logs, backups). Only explicit overrides are stored (instances/<id>/settings.json);
// the effective value is the override, else the current release's default.

export const SETTING_STRING_MAX = 256;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001F\u007F]/;

type Settings = Pick<Manifest, 'settings'>;
type SettingDef = Pick<ManifestSetting, 'label' | 'type' | 'min' | 'max' | 'maxLength' | 'choices' | 'onValue' | 'offValue'> & { id: string };

export function settingsOf(manifest: Settings): ManifestSetting[] {
  return manifest.settings ?? [];
}

// How a value reads in plans, the console and the CLI: on/off, a choice's label, else the value itself.
export function formatSettingValue(def: { type: ManifestSetting['type']; choices?: { value: string; label?: string }[] | null | undefined }, v: SettingValue): string {
  if (def.type === 'boolean') return v === true ? 'on' : 'off';
  if (def.type === 'choice') {
    const c = (def.choices ?? []).find((x) => x.value === v);
    return c?.label && c.label !== c.value ? `${c.label} (${c.value})` : String(v);
  }
  if (def.type === 'string') return v === '' ? '(empty)' : String(v);
  return String(v);
}

// What the setting accepts, in words (error messages and help).
export function allowedText(def: SettingDef): string {
  const range = (what: string) => {
    if (def.min !== undefined && def.max !== undefined) return `${what} from ${def.min} to ${def.max}`;
    if (def.min !== undefined) return `${what} of at least ${def.min}`;
    if (def.max !== undefined) return `${what} of at most ${def.max}`;
    return what;
  };
  switch (def.type) {
    case 'integer':
      return range('a whole number');
    case 'number':
      return range('a number');
    case 'boolean':
      return 'on or off (true or false)';
    case 'choice':
      return `one of ${(def.choices ?? []).map((c) => c.value).join(', ')}`;
    case 'string':
      return `text on one line, at most ${def.maxLength ?? SETTING_STRING_MAX} characters`;
  }
}

// Why a value is not acceptable for this setting (null = fine).
export function settingValueProblem(def: SettingDef, value: unknown): string | null {
  const bad = () => `${def.label} (setting ${def.id}) must be ${allowedText(def)}`;
  switch (def.type) {
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return bad();
      if (def.type === 'integer' && !Number.isInteger(value)) return bad();
      if (def.min !== undefined && value < def.min) return bad();
      if (def.max !== undefined && value > def.max) return bad();
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : bad();
    case 'choice':
      return typeof value === 'string' && (def.choices ?? []).some((c) => c.value === value) ? null : bad();
    case 'string':
      if (typeof value !== 'string' || CONTROL.test(value) || value.length > (def.maxLength ?? SETTING_STRING_MAX)) return bad();
      return null;
  }
}

// The environment literal one binding receives (before Compose escaping).
export function settingBindingValue(def: ManifestSetting, binding: ManifestSetting['bindings'][number], v: SettingValue): string {
  const text = def.type === 'boolean' ? (v === true ? (def.onValue ?? 'true') : (def.offValue ?? 'false')) : String(v);
  return binding.template ? binding.template.split(SECRET_TEMPLATE_SLOT).join(text) : text;
}

const same = (a: SettingValue | undefined, b: SettingValue | undefined) => a !== undefined && b !== undefined && a === b;

// Effective values: a stored override that is still allowed, else the release's default.
export function effectiveSettings(manifest: Settings, overrides: Record<string, SettingValue>): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const s of settingsOf(manifest)) {
    const o = overrides[s.id];
    out[s.id] = o !== undefined && settingValueProblem(s, o) === null ? o : s.default;
  }
  return out;
}

// The overrides this release keeps: known to it and allowed by it. An override equal to the default stays (the
// operator chose that value; a release that later moves the default must not move it), except where a configure
// or install request sets a value equal to the default (applySettingValues: that means "follow the default").
export function pruneOverrides(manifest: Settings, overrides: Record<string, SettingValue>): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const s of settingsOf(manifest)) {
    const o = overrides[s.id];
    if (o === undefined || settingValueProblem(s, o) !== null) continue;
    out[s.id] = o;
  }
  return out;
}

function baseDto(s: ManifestSetting, value: SettingValue, overridden: boolean): SettingDto {
  return {
    id: s.id,
    label: s.label,
    help: s.help ?? null,
    type: s.type,
    default: s.default,
    value,
    overridden,
    min: s.min ?? null,
    max: s.max ?? null,
    maxLength: s.type === 'string' ? (s.maxLength ?? SETTING_STRING_MAX) : null,
    choices: s.type === 'choice' ? (s.choices ?? []).map((c) => ({ value: c.value, label: c.label ?? c.value })) : null,
  };
}

// The app page / `harbor settings`: every setting with its effective value.
export function settingDtos(manifest: Settings, overrides: Record<string, SettingValue>): SettingDto[] {
  const eff = effectiveSettings(manifest, overrides);
  const kept = pruneOverrides(manifest, overrides);
  return settingsOf(manifest).map((s) => baseDto(s, eff[s.id]!, s.id in kept));
}

const lineValue = (s: ManifestSetting, v: SettingValue) => formatSettingValue(s, v);

// Install plans: every setting at its default; the submission may carry other values. (An adopted drive app
// starts at the defaults: adopt submits its own plan, and the values chosen stayed with the other machine.)
export function plannedInstallSettings(manifest: Settings): PlanSettingDto[] {
  return settingsOf(manifest).map((s) => ({ ...baseDto(s, s.default, false), change: 'new', ask: true, previous: null }));
}

export function installSettingChanges(manifest: Settings): string[] {
  const all = settingsOf(manifest);
  if (!all.length) return [];
  return [`Apply ${all.length === 1 ? 'its setting' : `its ${all.length} settings`} (${all.map((s) => `${s.label}: ${lineValue(s, s.default)}`).join(', ')}), or the values you choose under Options`];
}

// Update plans: settings the new release adds (asked, at their default), the ones it drops, and stored values
// the new release no longer allows (reset to its default, so auto-update keeps flowing).
export function plannedUpdateSettings(current: Settings, next: Settings, overrides: Record<string, SettingValue>): { settings: PlanSettingDto[]; changes: string[] } {
  const settings: PlanSettingDto[] = [];
  const changes: string[] = [];
  const before = new Map(settingsOf(current).map((s) => [s.id, s]));
  const after = new Map(settingsOf(next).map((s) => [s.id, s]));
  for (const s of settingsOf(next)) {
    const old = before.get(s.id);
    if (!old) {
      settings.push({ ...baseDto(s, s.default, false), change: 'new', ask: true, previous: null });
      changes.push(`New setting ${s.label}: ${lineValue(s, s.default)} (the default; change it under Options or later on the app page)`);
      continue;
    }
    const o = overrides[s.id];
    // an override equal to the old default is still the operator's choice (it outlived a default change)
    const stored = o !== undefined && settingValueProblem(old, o) === null ? o : undefined;
    if (stored !== undefined && settingValueProblem(s, stored) !== null) {
      settings.push({ ...baseDto(s, s.default, false), change: 'reset', ask: false, previous: stored });
      changes.push(`${s.label}: your value ${lineValue(old, stored)} is not allowed by this release (it takes ${allowedText(s)}); it goes back to the default ${lineValue(s, s.default)}`);
    } else if (stored === undefined && !same(old.default, s.default)) {
      changes.push(`${s.label}: the default changes from ${lineValue(old, old.default)} to ${lineValue(s, s.default)} (you kept the default, so the app follows it)`);
    }
  }
  for (const old of settingsOf(current)) {
    if (after.has(old.id)) continue;
    const o = overrides[old.id];
    const stored = o !== undefined && settingValueProblem(old, o) === null ? o : undefined;
    settings.push({ ...baseDto(old, stored ?? old.default, stored !== undefined), change: 'dropped', ask: false, previous: stored ?? null });
    changes.push(stored !== undefined ? `Setting ${old.label} is no longer part of this release; your value ${lineValue(old, stored)} is dropped` : `Setting ${old.label} is no longer part of this release`);
  }
  return { settings, changes };
}

// Configure plans: the values the request carries, checked against the installed release. Returns the change
// lines and the values to apply (a value equal to the default removes the override).
export function plannedConfigureSettings(manifest: Settings, overrides: Record<string, SettingValue>, requested: Record<string, unknown>): { settings: PlanSettingDto[]; changes: string[]; values: Record<string, SettingValue> } {
  const defs = new Map(settingsOf(manifest).map((s) => [s.id, s]));
  const eff = effectiveSettings(manifest, overrides);
  const kept = pruneOverrides(manifest, overrides);
  const settings: PlanSettingDto[] = [];
  const changes: string[] = [];
  const values: Record<string, SettingValue> = {};
  for (const [id, raw] of Object.entries(requested)) {
    const s = defs.get(id);
    if (!s) throw new HarborError('SETTING_INVALID', `this app has no setting ${id}`, { nextAction: defs.size ? `Its settings are: ${[...defs.keys()].join(', ')}.` : 'This app has no settings.' });
    const problem = settingValueProblem(s, raw);
    if (problem) throw new HarborError('SETTING_INVALID', problem, { nextAction: `Pass a value that is ${allowedText(s)}.` });
    const v = raw as SettingValue;
    const was = eff[id]!;
    const toDefault = same(v, s.default);
    // the default's value, kept as the operator's own choice (an update moved the default onto it): asking for the
    // default again means "follow the default from now on"
    const pinned = toDefault && kept[id] !== undefined;
    if (same(v, was) && !pinned) continue; // nothing changes
    values[id] = v;
    settings.push({ ...baseDto(s, v, !toDefault), change: 'set', ask: false, previous: was });
    changes.push(same(v, was) ? `${s.label}: stays ${lineValue(s, v)}, now as the default (a later default change moves it)` : `${s.label}: ${lineValue(s, was)} -> ${lineValue(s, v)}${toDefault ? ' (back to the default)' : ''}`);
  }
  return { settings, changes, values };
}

// A setting as a DTO describes it (plans keep the definition, not the manifest)
export function defOfDto(s: SettingDto): SettingDef {
  return { id: s.id, label: s.label, type: s.type, ...(s.min !== null ? { min: s.min } : {}), ...(s.max !== null ? { max: s.max } : {}), ...(s.maxLength !== null ? { maxLength: s.maxLength } : {}), ...(s.choices ? { choices: s.choices } : {}) };
}

// Checks a submission against the plan: only settings the plan asks for, each with an allowed value.
export function checkSubmittedSettings(planned: PlanSettingDto[], values: Record<string, unknown> | undefined): Record<string, SettingValue> {
  const asked = planned.filter((s) => s.ask);
  const out: Record<string, SettingValue> = {};
  for (const [id, v] of Object.entries(values ?? {})) {
    const s = asked.find((x) => x.id === id);
    if (!s) throw new HarborError('SETTING_INVALID', `this plan does not ask for setting ${id}`, { nextAction: asked.length ? `It asks for: ${asked.map((x) => x.id).join(', ')}.` : 'Submit without settings (change them on the app page later).' });
    const def = defOfDto(s);
    const problem = settingValueProblem(def, v);
    if (problem) throw new HarborError('SETTING_INVALID', problem, { nextAction: `Choose a value that is ${allowedText(def)}.` });
    out[id] = v as SettingValue;
  }
  return out;
}

// Merge chosen values into the stored overrides for this release: unknown and disallowed values drop out, and a
// chosen value equal to the default removes that override (the app follows the default again). Overrides the
// request does not name stay as they are, even one an update's new default happens to equal.
export function applySettingValues(manifest: Settings, overrides: Record<string, SettingValue>, values: Record<string, SettingValue>): Record<string, SettingValue> {
  const out = pruneOverrides(manifest, { ...overrides, ...values });
  for (const s of settingsOf(manifest)) if (s.id in values && same(values[s.id], s.default)) delete out[s.id];
  return out;
}

// CLI `--set id=value`: the text typed, read as the setting's type (the plan or app page says which).
export function parseSettingInput(def: Pick<SettingDto, 'id' | 'label' | 'type'>, raw: string): SettingValue {
  if (def.type === 'integer' || def.type === 'number') {
    const n = raw.trim() === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(n)) throw new HarborError('SETTING_INVALID', `${def.label} (setting ${def.id}) takes a number, not "${raw}"`);
    return n;
  }
  if (def.type === 'boolean') {
    const t = raw.trim().toLowerCase();
    if (['true', 'on', 'yes', '1'].includes(t)) return true;
    if (['false', 'off', 'no', '0'].includes(t)) return false;
    throw new HarborError('SETTING_INVALID', `${def.label} (setting ${def.id}) takes on or off, not "${raw}"`);
  }
  return raw;
}
