// Decision 180: the pure half of the settings form (no DOM, no relative imports, so unit tests can import it).
// A draft holds what the inputs show: numbers as the typed text, on/off as a boolean, text and choices as text.

type Value = string | number | boolean;
export interface SettingShape {
  id: string;
  label: string;
  type: 'integer' | 'number' | 'boolean' | 'string' | 'choice';
  default: Value;
  min: number | null;
  max: number | null;
  maxLength: number | null;
  choices: { value: string; label: string }[] | null;
}
export type SettingDraft = Record<string, string | boolean>;

export function toDraft(s: SettingShape, v: Value): string | boolean {
  return s.type === 'boolean' ? v === true : String(v);
}

export function draftOf<T extends SettingShape>(settings: T[], pick: (s: T) => Value): SettingDraft {
  return Object.fromEntries(settings.map((s) => [s.id, toDraft(s, pick(s))]));
}

// What the setting accepts, in the console's words.
export function allowedWords(s: SettingShape): string {
  const range = (what: string) => (s.min !== null && s.max !== null ? `${what} from ${s.min} to ${s.max}` : s.min !== null ? `${what} of at least ${s.min}` : s.max !== null ? `${what} of at most ${s.max}` : what);
  switch (s.type) {
    case 'integer':
      return range('a whole number');
    case 'number':
      return range('a number');
    case 'boolean':
      return 'on or off';
    case 'choice':
      return `one of ${(s.choices ?? []).map((c) => c.label).join(', ')}`;
    case 'string':
      return `one line of at most ${s.maxLength ?? 256} characters`;
  }
}

// The value a draft entry stands for, or why it cannot be used yet.
export function parseDraft(s: SettingShape, d: string | boolean | undefined): { value: Value } | { problem: string } {
  const bad = { problem: `${s.label}: ${allowedWords(s)}` };
  if (d === undefined) return { value: s.default };
  if (s.type === 'boolean') return { value: d === true };
  const text = String(d);
  if (s.type === 'integer' || s.type === 'number') {
    const n = text.trim() === '' ? Number.NaN : Number(text);
    if (!Number.isFinite(n) || (s.type === 'integer' && !Number.isInteger(n))) return bad;
    if ((s.min !== null && n < s.min) || (s.max !== null && n > s.max)) return bad;
    return { value: n };
  }
  if (s.type === 'choice') return (s.choices ?? []).some((c) => c.value === text) ? { value: text } : bad;
  // eslint-disable-next-line no-control-regex -- one line, no control characters
  if (/[\u0000-\u001F\u007F]/.test(text) || text.length > (s.maxLength ?? 256)) return bad;
  return { value: text };
}

// The values that differ from `base` (each setting's default at install, its current value on the app page),
// the first problem, if any, and every setting whose entry cannot be used yet (`invalid`, ids).
export function changedValues<T extends SettingShape>(settings: T[], draft: SettingDraft, base: (s: T) => Value): { values: Record<string, Value>; problem: string | null; invalid: string[] } {
  const values: Record<string, Value> = {};
  const invalid: string[] = [];
  let problem: string | null = null;
  for (const s of settings) {
    const r = parseDraft(s, draft[s.id]);
    if ('problem' in r) {
      problem ??= r.problem;
      invalid.push(s.id);
      continue;
    }
    if (r.value !== base(s)) values[s.id] = r.value;
  }
  return { values, problem, invalid };
}

// The install/update review's Options summary: how many values changed, and how many still need fixing (a
// collapsed section must not hide why Install is off).
export function optionsSummary(changed: number, invalid: number, update: { newCount: number } | null): string {
  const parts: string[] = [];
  if (invalid) parts.push(`${invalid} to fix`);
  if (changed) parts.push(`${changed} changed`);
  if (parts.length) return parts.join(', ');
  return update ? `${update.newCount} new, at their defaults` : 'defaults';
}

// How a value reads: on/off, a choice's label, else the value.
export function settingText(s: Pick<SettingShape, 'type' | 'choices'>, v: Value): string {
  if (s.type === 'boolean') return v === true ? 'on' : 'off';
  if (s.type === 'choice') return (s.choices ?? []).find((c) => c.value === v)?.label ?? String(v);
  if (s.type === 'string' && v === '') return '(empty)';
  return String(v);
}
