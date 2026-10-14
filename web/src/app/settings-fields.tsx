import { useState } from 'react';
import type { InstanceSummary, SettingDto, SettingValue } from '../../../src/contracts/api';
import { Dialog } from './components';
import { allowedWords, changedValues, draftOf, parseDraft, settingText, toDraft, type SettingDraft } from './setting-draft';

// Decision 180: one form field per setting (number input with its limits, a checkbox, a text field or a select),
// its help below and a way back to the default. Used by the install review's Options and the app page's Change….
export function SettingFields({ settings, draft, onChange }: { settings: SettingDto[]; draft: SettingDraft; onChange: (d: SettingDraft) => void }) {
  return (
    <div className="setting-fields">
      {settings.map((s) => {
        const d = draft[s.id];
        const parsed = parseDraft(s, d);
        const isDefault = 'value' in parsed && parsed.value === s.default;
        const set = (v: string | boolean) => onChange({ ...draft, [s.id]: v });
        const helpId = `setting-help-${s.id}`;
        const input =
          s.type === 'boolean' ? (
            <input type="checkbox" checked={d === true} onChange={(e) => set(e.target.checked)} aria-label={s.label} aria-describedby={helpId} />
          ) : s.type === 'choice' ? (
            <select value={String(d ?? s.default)} onChange={(e) => set(e.target.value)} aria-label={s.label} aria-describedby={helpId}>
              {(s.choices ?? []).map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : s.type === 'integer' || s.type === 'number' ? (
            <input type="number" inputMode={s.type === 'integer' ? 'numeric' : 'decimal'} value={String(d ?? '')} min={s.min ?? undefined} max={s.max ?? undefined} step={s.type === 'integer' ? 1 : 'any'} onChange={(e) => set(e.target.value)} aria-label={s.label} aria-describedby={helpId} aria-invalid={'problem' in parsed} />
          ) : (
            <input type="text" value={String(d ?? '')} maxLength={s.maxLength ?? 256} onChange={(e) => set(e.target.value)} aria-label={s.label} aria-describedby={helpId} aria-invalid={'problem' in parsed} spellCheck={false} />
          );
        return (
          <div key={s.id} className="setting-field">
            <div className={s.type === 'boolean' ? 'row setting-row' : 'setting-row'}>
              {s.type === 'boolean' ? (
                <label className="row small setting-check">
                  {input} <span>{s.label}</span>
                </label>
              ) : (
                <label className="small">
                  <span>{s.label}</span>
                  {input}
                </label>
              )}
            </div>
            <p id={helpId} className="muted small setting-help">
              {s.help ? `${s.help} ` : ''}
              {'problem' in parsed ? <span className="error-text">Use {allowedWords(s)}.</span> : s.type === 'integer' || s.type === 'number' ? <span>{allowedWords(s).replace(/^a/, 'A')}.</span> : null}{' '}
              {isDefault ? (
                <span>Default.</span>
              ) : (
                <button type="button" className="btn small ghost" onClick={() => set(toDraft(s, s.default))} aria-label={`Reset ${s.label} to the default`}>
                  Reset to default ({settingText(s, s.default)})
                </button>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// The app page's Settings → Change…: every setting at its current value; Review makes a configure plan.
export function SettingsDialog({ inst, title, onClose, onReview }: { inst: InstanceSummary; title: string; onClose: () => void; onReview: (values: Record<string, SettingValue>) => void }) {
  const settings = inst.settings ?? [];
  const [draft, setDraft] = useState<SettingDraft>(() => draftOf(settings, (s) => s.value));
  const { values, problem } = changedValues(settings, draft, (s) => s.value);
  const changed = Object.keys(values).length;
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem && changed) onReview(values);
        }}
      >
        <p className="muted small">Harbor shows you the plan first; the app is recreated with the new values (data and addresses stay).</p>
        <SettingFields settings={settings} draft={draft} onChange={setDraft} />
        {problem && (
          <p className="error small" role="alert">
            {problem}
          </p>
        )}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={Boolean(problem) || !changed} title={problem ?? (!changed ? 'Change a value first' : undefined)}>
            Review
          </button>
        </div>
      </form>
    </Dialog>
  );
}
