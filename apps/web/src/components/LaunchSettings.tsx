import { useEffect, useRef, useState } from 'react';
import { type BudgetMode, type LaunchOverrides } from '@conveyor/shared';
import { Badge, Button, Field, inputClass } from './Panel.tsx';
import { fromLocalInput, money, toLocalInput, toMinor } from './TemplateEditor.tsx';

/** What the boxes hold while they are being typed in; empty always means "as in the template". */
interface Form {
  campaignName: string;
  budget: string;
  ageMin: string;
  ageMax: string;
  countries: string;
}

const formOf = (o: LaunchOverrides): Form => ({
  campaignName: o.campaignName ?? '',
  budget: o.budgetMinor == null ? '' : money(o.budgetMinor),
  ageMin: o.ageMin == null ? '' : String(o.ageMin),
  ageMax: o.ageMax == null ? '' : String(o.ageMax),
  countries: o.countries?.join(', ') ?? '',
});

const num = (s: string): number | null => {
  const n = Number.parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : null;
};
const splitCommas = (s: string) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

const GENDER_LABEL = (g: number[] | null) => (g == null ? '' : g.length === 0 ? 'everyone' : g.length === 2 ? 'everyone' : g[0] === 1 ? 'men' : 'women');
const genderValue = (g: number[] | null) => (g == null ? '' : g.length === 1 ? String(g[0]) : 'all');
const timeValue = (t: string | null) => (t == null ? 'template' : t === '' ? 'none' : 'at');

export interface LaunchSettingsProps {
  overrides: LaunchOverrides;
  /** The same fields as the template resolves them, shown as the placeholder in each box. */
  defaults: LaunchOverrides;
  mode: BudgetMode;
  /** True when the template budgets over a lifetime rather than a day. */
  lifetime: boolean;
  busy: boolean;
  /** Called as soon as a box is left or a list is picked; the plan is saved at once. */
  onSave: (next: LaunchOverrides) => void;
}

/**
 * The settings that change with every launch: name, schedule, audience
 * and budget, in one row of boxes. Each one is this launch's alone — an empty box follows the
 * template, and nothing typed here ever reaches the template file or the product's copy of it.
 */
export function LaunchSettings({ overrides, defaults, mode, lifetime, busy, onSave }: LaunchSettingsProps) {
  const [form, setForm] = useState<Form>(() => formOf(overrides));
  // A save comes back through the props; refilling the boxes from it would wipe whatever is
  // being typed in the next one, so our own save is recognised and skipped.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (sent.current === JSON.stringify(overrides)) return;
    sent.current = null;
    setForm(formOf(overrides));
  }, [overrides]);

  const put = (patch: Partial<LaunchOverrides>) => {
    const next = { ...overrides, ...patch };
    sent.current = JSON.stringify(next);
    onSave(next);
  };
  const set = (k: keyof Form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const budgetLabel = `${lifetime ? 'Lifetime' : 'Daily'} budget${mode === 'ABO' ? ' per ad set' : ''} ($)`;

  /**
   * One of the three states a time can be in, so "no time at all" is sayable. The two controls
   * take a column each of their own half of the row: a date picker is wider than a quarter of
   * the panel in every browser, and squeezing it beside the list covered the field next to it.
   * Grid cells with `min-w-0` cannot overlap their neighbours, whatever the picker's own width.
   */
  const timeField = (key: 'startTime' | 'endTime', label: string, hint: string) => {
    const value = overrides[key];
    const at = timeValue(value) === 'at';
    return (
      <div className="md:col-span-2">
        <Field label={label} hint={hint}>
          <div className={`grid gap-2 ${at ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
            <select
              className={`${inputClass} min-w-0`}
              value={timeValue(value)}
              disabled={busy}
              onChange={(e) => put({ [key]: e.target.value === 'template' ? null : e.target.value === 'none' ? '' : (defaults[key] || new Date(Date.now() + 86_400_000).toISOString()) } as Partial<LaunchOverrides>)}
            >
              <option value="template">As in the template</option>
              <option value="none">{key === 'startTime' ? 'When activated' : 'No end'}</option>
              <option value="at">At a set time</option>
            </select>
            {at && (
              <input className={`${inputClass} min-w-0`} type="datetime-local" disabled={busy} value={toLocalInput(value)} onChange={(e) => put({ [key]: fromLocalInput(e.target.value) ?? '' } as Partial<LaunchOverrides>)} />
            )}
          </div>
        </Field>
      </div>
    );
  };

  return (
    <div className="grid gap-4 md:grid-cols-4 [&>*]:min-w-0">
      <div className="md:col-span-2">
        <Field label="Campaign name" hint="Also the first part of every ad set name. Empty uses the template's pattern.">
          <input
            className={inputClass}
            placeholder={defaults.campaignName ?? ''}
            value={form.campaignName}
            disabled={busy}
            onChange={(e) => set('campaignName', e.target.value)}
            onBlur={() => put({ campaignName: form.campaignName.trim() || null })}
          />
        </Field>
      </div>
      <Field label={budgetLabel} hint={mode === 'CBO' ? 'The campaign carries the budget.' : 'Every ad set gets this amount.'}>
        <input
          className={inputClass}
          inputMode="decimal"
          placeholder={defaults.budgetMinor == null ? '' : money(defaults.budgetMinor)}
          value={form.budget}
          disabled={busy}
          onChange={(e) => set('budget', e.target.value)}
          onBlur={() => put({ budgetMinor: toMinor(form.budget) })}
        />
      </Field>
      <Field label="Countries" hint="Two-letter codes, comma separated.">
        <input
          className={inputClass}
          placeholder={defaults.countries?.join(', ') ?? ''}
          value={form.countries}
          disabled={busy}
          onChange={(e) => set('countries', e.target.value)}
          onBlur={() => put({ countries: form.countries.trim() ? splitCommas(form.countries) : null })}
        />
      </Field>

      {timeField('startTime', 'Start', 'A time in the past starts the ad sets when you activate them.')}
      {timeField('endTime', 'End', 'Required with a lifetime budget.')}
      <Field label="Gender">
        <select
          className={inputClass}
          value={genderValue(overrides.genders)}
          disabled={busy}
          onChange={(e) => put({ genders: e.target.value === '' ? null : e.target.value === 'all' ? [] : [Number(e.target.value) as 1 | 2] })}
        >
          <option value="">As in the template ({GENDER_LABEL(defaults.genders) || 'everyone'})</option>
          <option value="all">Everyone</option>
          <option value="1">Men</option>
          <option value="2">Women</option>
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Age from">
          <input className={inputClass} inputMode="numeric" placeholder={String(defaults.ageMin ?? '')} value={form.ageMin} disabled={busy} onChange={(e) => set('ageMin', e.target.value)} onBlur={() => put({ ageMin: num(form.ageMin) })} />
        </Field>
        <Field label="to">
          <input className={inputClass} inputMode="numeric" placeholder={String(defaults.ageMax ?? '')} value={form.ageMax} disabled={busy} onChange={(e) => set('ageMax', e.target.value)} onBlur={() => put({ ageMax: num(form.ageMax) })} />
        </Field>
      </div>

      <div className="md:col-span-2">
        <Field label="Audience" hint="With Advantage+ audience on, gender and age are suggestions and Meta widens them.">
          <select className={inputClass} value={overrides.advantageAudience === null ? '' : String(overrides.advantageAudience)} disabled={busy} onChange={(e) => put({ advantageAudience: e.target.value === '' ? null : e.target.value === 'true' })}>
            <option value="">As in the template (Advantage+ audience {defaults.advantageAudience ? 'on' : 'off'})</option>
            <option value="true">Advantage+ audience on</option>
            <option value="false">Off: target the gender and ages above</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

/** The one line that says how this launch differs from its template. */
export function LaunchSettingsSummary({ changed }: { changed: string[] }) {
  return changed.length ? <Badge tone="cobalt">This launch sets its own {changed.join(', ')}</Badge> : <span className="text-xs text-ink-3">Every setting as in the template</span>;
}

export function ClearLaunchSettings({ disabled, onClear }: { disabled: boolean; onClear: () => void }) {
  return (
    <Button kind="quiet" disabled={disabled} onClick={onClear}>
      Back to the template's settings
    </Button>
  );
}
