import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TemplateView } from '@conveyor/shared';
import { Badge, Button, Field, Panel, inputClass } from '../components/Panel.tsx';
import { ApiError, launch, type TemplateList } from '../lib/api.ts';
import { formatDateTime, formatMoney } from '../lib/format.ts';

type Json = Record<string, unknown>;
const get = (o: unknown, p: string[]): unknown => p.reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Json)[k] : undefined), o);
const set = (o: Json, p: string[], v: unknown): Json => {
  const [head, ...rest] = p;
  if (!head) return o;
  const child = (o[head] && typeof o[head] === 'object' ? { ...(o[head] as Json) } : {}) as Json;
  return { ...o, [head]: rest.length ? set(child, rest, v) : v };
};
const money = (v: unknown) => (typeof v === 'number' ? (v / 100).toFixed(2) : '');
const minor = (s: string) => (s.trim() === '' ? null : Math.round(Number.parseFloat(s) * 100));

/**
 * The templates folder, editable. Each template is a JSON file in the other tool's format under
 * the data directory; this tab edits the fields that matter and writes the file back. Anything
 * not shown is kept as is (the format passes through).
 */
export function TemplatesView() {
  const [list, setList] = useState<TemplateList | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [doc, setDoc] = useState<Json | null>(null);
  const [view, setView] = useState<TemplateView | null>(null);
  const [tab, setTab] = useState<'campaign' | 'adsets' | 'ads' | 'variants' | 'json'>('campaign');
  const [raw, setRaw] = useState('');
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const l = await launch.templates().catch(() => null);
    if (!l) return;
    setList(l);
    setSelected((cur) => cur ?? l.templates.find((t) => t.isDefault)?.id ?? l.templates[0]?.id ?? null);
    const notes = [...l.sync.added.map((f) => `added ${f}`), ...l.sync.updated.map((f) => `updated ${f}`), ...l.sync.missing.map((f) => `missing ${f}`), ...l.sync.skipped.map((s) => `skipped ${s.file}: ${s.reason}`)];
    if (notes.length) setMsg(`Folder sync: ${notes.join('; ')}`);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (selected == null) return;
    launch.template(selected).then(({ view: v, json }) => {
      setView(v);
      setDoc(json);
      setRaw(JSON.stringify(json, null, 2));
      setDirty(false);
    }).catch(() => undefined);
  }, [selected]);

  const edit = (path: string[], value: unknown) => {
    if (!doc) return;
    const next = set(doc, path, value);
    setDoc(next);
    setRaw(JSON.stringify(next, null, 2));
    setDirty(true);
  };
  const act = async (fn: () => Promise<unknown>, note?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (note) setMsg(note);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      if (!doc || selected == null) return;
      let json = doc;
      if (tab === 'json') json = JSON.parse(raw) as Json;
      const r = await launch.saveTemplate(selected, json);
      setDoc(r.json);
      setRaw(JSON.stringify(r.json, null, 2));
      setView(r.view);
      setDirty(false);
      await load();
    }, 'Saved to the file.');

  const importFile = (file: File) =>
    act(async () => {
      const t = await launch.importTemplate(JSON.parse(await file.text()));
      await load();
      setSelected(t.id);
    }, 'Added to the folder.');

  const mode = get(doc, ['campaign', 'budget', 'mode']) as string | undefined;
  const variants = useMemo(() => (Array.isArray(get(doc, ['adset_variants'])) ? (get(doc, ['adset_variants']) as Json[]) : []), [doc]);
  const targeting = (get(doc, ['adset', 'targeting']) as Json | undefined) ?? {};

  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
      <Panel
        title="Templates"
        action={
          <label className="text-xs text-cobalt cursor-pointer">
            Add file
            <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
          </label>
        }
      >
        {list && (
          <p className="text-xs text-ink-3 mb-3 break-all">
            Folder: <code>{list.folder.dir}</code>. Drop the other tool's exports here; they appear on the next visit.
          </p>
        )}
        <ul className="divide-y divide-line -mx-5">
          {list?.templates.map((t) => (
            <li key={t.id}>
              <button className={`w-full text-left px-5 py-2.5 hover:bg-panel-2 ${selected === t.id ? 'bg-cobalt-soft/40' : ''}`} onClick={() => setSelected(t.id)}>
                <p className="text-sm font-medium flex items-center gap-2">
                  <span className="truncate">{t.name}</span>
                  {t.isDefault && <Badge tone="cobalt">Default</Badge>}
                  {t.fileMissing && <Badge tone="amber">File missing</Badge>}
                </p>
                <p className="text-xs text-ink-3">
                  v{t.version} · {t.mode} · {t.adSetCount} × {t.adsPerAdSet} · {t.mode === 'CBO' ? `${formatMoney(t.campaignBudgetMinor ?? 0)}/day campaign` : `${formatMoney(t.adSetBudgetMinor ?? 0)}/day per ad set`}
                </p>
                <p className="text-xs text-ink-3 truncate">{t.fileName ?? 'stored only'}</p>
              </button>
            </li>
          ))}
          {list && list.templates.length === 0 && <li className="px-5 py-3 text-sm text-ink-3">No templates in the folder yet.</li>}
        </ul>
      </Panel>

      {doc && view && (
        <Panel
          title={view.name}
          action={
            <span className="flex items-center gap-2">
              {dirty && <Badge tone="amber">Unsaved</Badge>}
              <Button kind="quiet" disabled={busy} onClick={() => act(() => launch.duplicateTemplate(view.id).then(async (t) => { await load(); setSelected(t.id); }), 'Duplicated as a new file.')}>
                Duplicate
              </Button>
              {!view.isDefault && (
                <Button kind="quiet" disabled={busy} onClick={() => act(() => launch.setDefaultTemplate(view.id).then(load), 'Set as the default template.')}>
                  Make default
                </Button>
              )}
              <a className="px-3 py-1.5 text-sm rounded-md border border-line" href={launch.exportUrl(view.id)} download>
                Export for my other tool
              </a>
              <a className="px-3 py-1.5 text-sm rounded-md border border-line" href={launch.exportUrl(view.id, true)} download>
                Backup
              </a>
              <Button kind="quiet" disabled={busy} onClick={() => act(() => launch.deleteTemplate(view.id).then(async () => { setSelected(null); setDoc(null); await load(); }), 'Moved to templates/trash.')}>
                Remove
              </Button>
              <Button kind="primary" disabled={busy || !dirty} onClick={save}>
                Save to file
              </Button>
            </span>
          }
        >
          <p className="text-xs text-ink-3 mb-3">
            {view.fileName ? `File ${view.fileName}` : 'Not linked to a file yet; saving creates one'} · updated {formatDateTime(view.updatedAt)} · id {view.templateId}. Fields not shown here are kept exactly as exported.
          </p>
          <nav className="flex gap-1 mb-4">
            {(['campaign', 'adsets', 'ads', 'variants', 'json'] as const).map((k) => (
              <button key={k} className={`px-3 py-1 text-sm rounded-md ${tab === k ? 'bg-cobalt-soft text-cobalt font-medium' : 'text-ink-2 hover:bg-panel-2'}`} onClick={() => setTab(k)}>
                {k === 'adsets' ? 'Ad sets' : k === 'json' ? 'Raw JSON' : k[0]!.toUpperCase() + k.slice(1)}
              </button>
            ))}
          </nav>

          {tab === 'campaign' && (
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Name">
                <input className={inputClass} value={String(get(doc, ['name']) ?? '')} onChange={(e) => edit(['name'], e.target.value)} />
              </Field>
              <Field label="Objective">
                <input className={inputClass} value={String(get(doc, ['campaign', 'objective']) ?? '')} onChange={(e) => edit(['campaign', 'objective'], e.target.value)} />
              </Field>
              <Field label="Buying type">
                <input className={inputClass} value={String(get(doc, ['campaign', 'buying_type']) ?? '')} onChange={(e) => edit(['campaign', 'buying_type'], e.target.value)} />
              </Field>
              <Field label="Budget mode" hint={mode === 'ABO' ? 'Each ad set gets its own budget; the campaign always sends sharing off' : 'The campaign carries the budget; ad sets get none'}>
                <select className={inputClass} value={mode ?? 'CBO'} onChange={(e) => edit(['campaign', 'budget', 'mode'], e.target.value)}>
                  <option value="CBO">CBO</option>
                  <option value="ABO">ABO</option>
                </select>
              </Field>
              <Field label="Campaign daily budget ($)" hint={mode === 'ABO' ? 'Not sent under ABO' : ''}>
                <input className={inputClass} inputMode="decimal" value={money(get(doc, ['campaign', 'budget', 'daily_budget_minor']))} onChange={(e) => edit(['campaign', 'budget', 'daily_budget_minor'], minor(e.target.value))} />
              </Field>
              <Field label="Campaign lifetime budget ($)">
                <input className={inputClass} inputMode="decimal" value={money(get(doc, ['campaign', 'budget', 'lifetime_budget_minor']))} onChange={(e) => edit(['campaign', 'budget', 'lifetime_budget_minor'], minor(e.target.value))} />
              </Field>
              <Field label="Bid strategy">
                <select className={inputClass} value={String(get(doc, ['campaign', 'budget', 'bid_strategy']) ?? '')} onChange={(e) => edit(['campaign', 'budget', 'bid_strategy'], e.target.value)}>
                  {['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS'].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Bid amount ($)">
                <input className={inputClass} inputMode="decimal" value={money(get(doc, ['campaign', 'budget', 'bid_amount_minor']))} onChange={(e) => edit(['campaign', 'budget', 'bid_amount_minor'], minor(e.target.value))} />
              </Field>
              <Field label="Spend cap ($)">
                <input className={inputClass} inputMode="decimal" value={money(get(doc, ['campaign', 'budget', 'spend_cap_minor']))} onChange={(e) => edit(['campaign', 'budget', 'spend_cap_minor'], minor(e.target.value))} />
              </Field>
              <Field label="Campaign name pattern" hint="{{date}}, {{template}}">
                <input className={inputClass} value={String(get(doc, ['campaign', 'name_pattern']) ?? '')} onChange={(e) => edit(['campaign', 'name_pattern'], e.target.value)} />
              </Field>
            </div>
          )}

          {tab === 'adsets' && (
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Ad set count">
                <input className={inputClass} inputMode="numeric" value={String(get(doc, ['adset_count']) ?? '')} onChange={(e) => edit(['adset_count'], Number(e.target.value) || 1)} />
              </Field>
              <Field label="Ad set daily budget ($)" hint={mode === 'CBO' ? 'Not sent under CBO' : 'Sent on every ad set'}>
                <input className={inputClass} inputMode="decimal" value={money(get(doc, ['adset', 'budget', 'daily_budget_minor']))} onChange={(e) => edit(['adset', 'budget', 'daily_budget_minor'], minor(e.target.value))} />
              </Field>
              <Field label="Ad set bid strategy">
                <select className={inputClass} value={String(get(doc, ['adset', 'budget', 'bid_strategy']) ?? '')} onChange={(e) => edit(['adset', 'budget', 'bid_strategy'], e.target.value)}>
                  {['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS'].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Optimization goal">
                <input className={inputClass} value={String(get(doc, ['adset', 'optimization_goal']) ?? '')} onChange={(e) => edit(['adset', 'optimization_goal'], e.target.value)} />
              </Field>
              <Field label="Billing event">
                <input className={inputClass} value={String(get(doc, ['adset', 'billing_event']) ?? '')} onChange={(e) => edit(['adset', 'billing_event'], e.target.value)} />
              </Field>
              <Field label="Conversion event">
                <input className={inputClass} value={String(get(doc, ['adset', 'promoted_object', 'custom_event_type']) ?? '')} onChange={(e) => edit(['adset', 'promoted_object', 'custom_event_type'], e.target.value)} />
              </Field>
              <Field label="Start time (UTC ISO)" hint="A past time means start when activated">
                <input className={inputClass} value={String(get(doc, ['adset', 'schedule', 'start_time']) ?? '')} onChange={(e) => edit(['adset', 'schedule', 'start_time'], e.target.value || null)} />
              </Field>
              <Field label="End time (UTC ISO)">
                <input className={inputClass} value={String(get(doc, ['adset', 'schedule', 'end_time']) ?? '')} onChange={(e) => edit(['adset', 'schedule', 'end_time'], e.target.value || null)} />
              </Field>
              <Field label="Ad set name pattern" hint="{{campaign}}, {{variation}}">
                <input className={inputClass} value={String(get(doc, ['adset', 'name_pattern']) ?? '')} onChange={(e) => edit(['adset', 'name_pattern'], e.target.value)} />
              </Field>
              <Field label="Countries" hint="Comma separated">
                <input className={inputClass} value={((get(targeting, ['geo_locations', 'countries']) as string[] | undefined) ?? []).join(', ')} onChange={(e) => edit(['adset', 'targeting', 'geo_locations', 'countries'], e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))} />
              </Field>
              <Field label="Age min">
                <input className={inputClass} inputMode="numeric" value={String(get(targeting, ['age_min']) ?? '')} onChange={(e) => edit(['adset', 'targeting', 'age_min'], Number(e.target.value) || null)} />
              </Field>
              <Field label="Age max">
                <input className={inputClass} inputMode="numeric" value={String(get(targeting, ['age_max']) ?? '')} onChange={(e) => edit(['adset', 'targeting', 'age_max'], Number(e.target.value) || null)} />
              </Field>
              <Field label="Genders" hint="Empty = all, 1 = men, 2 = women">
                <input className={inputClass} value={((get(targeting, ['genders']) as number[] | undefined) ?? []).join(', ')} onChange={(e) => edit(['adset', 'targeting', 'genders'], e.target.value.split(',').map((x) => Number(x.trim())).filter((n) => n === 1 || n === 2))} />
              </Field>
              <label className="flex items-end gap-2 text-sm pb-2">
                <input type="checkbox" checked={!!get(targeting, ['advantage_audience'])} onChange={(e) => edit(['adset', 'targeting', 'advantage_audience'], e.target.checked)} />
                Advantage+ audience (age min 18–25, gender a suggestion)
              </label>
              <Field label="Placements">
                <select className={inputClass} value={String(get(targeting, ['placements', 'mode']) ?? 'advantage')} onChange={(e) => edit(['adset', 'targeting', 'placements', 'mode'], e.target.value)}>
                  <option value="advantage">Advantage+ placements</option>
                  <option value="manual">Manual (positions from the file)</option>
                </select>
              </Field>
            </div>
          )}

          {tab === 'ads' && (
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Ads per ad set">
                <input className={inputClass} inputMode="numeric" value={String(get(doc, ['ads_per_adset']) ?? '')} onChange={(e) => edit(['ads_per_adset'], Number(e.target.value) || 1)} />
              </Field>
              <Field label="Call to action">
                <input className={inputClass} value={String(get(doc, ['ad', 'default_cta']) ?? '')} onChange={(e) => edit(['ad', 'default_cta'], e.target.value)} />
              </Field>
              <Field label="Primary text" hint="Example copy; a product's saved copy takes precedence at launch">
                <textarea className={`${inputClass} min-h-24`} value={String(get(doc, ['ad', 'primary_text']) ?? '')} onChange={(e) => edit(['ad', 'primary_text'], e.target.value)} />
              </Field>
              <div className="space-y-4">
                <Field label="Headline">
                  <input className={inputClass} value={String(get(doc, ['ad', 'headline']) ?? '')} onChange={(e) => edit(['ad', 'headline'], e.target.value)} />
                </Field>
                <Field label="Description">
                  <input className={inputClass} value={String(get(doc, ['ad', 'description']) ?? '')} onChange={(e) => edit(['ad', 'description'], e.target.value)} />
                </Field>
              </div>
              <Field label="Destination URL" hint="The product's Shopify URL replaces this at launch">
                <input className={inputClass} value={String(get(doc, ['ad', 'destination_url']) ?? '')} onChange={(e) => edit(['ad', 'destination_url'], e.target.value)} />
              </Field>
              <Field label="URL parameters">
                <input className={inputClass} value={String(get(doc, ['ad', 'url_params']) ?? '')} onChange={(e) => edit(['ad', 'url_params'], e.target.value)} />
              </Field>
              <Field label="Ad name pattern" hint="{{creative_filename}}">
                <input className={inputClass} value={String(get(doc, ['ad', 'name_pattern']) ?? '')} onChange={(e) => edit(['ad', 'name_pattern'], e.target.value)} />
              </Field>
              <label className="flex items-end gap-2 text-sm pb-2">
                <input type="checkbox" checked={!!get(doc, ['ad', 'advantage_creative_enhancements'])} onChange={(e) => edit(['ad', 'advantage_creative_enhancements'], e.target.checked)} />
                Advantage+ creative enhancements (off keeps Meta from altering images)
              </label>
            </div>
          )}

          {tab === 'variants' && (
            <div className="space-y-2">
              <p className="text-xs text-ink-3">One interest per name: “US - Formal Wear” looks up Formal wear, “US - Broad” means none, “US - Interest 1” is a placeholder until renamed. Interests listed here are used as they are.</p>
              {variants.map((v, i) => (
                <div key={i} className="grid gap-2 md:grid-cols-[2fr_1fr_1fr_2fr_auto] items-end border border-line rounded-md p-2 bg-panel-2">
                  <Field label="Name">
                    <input className={inputClass} value={String(v.name ?? '')} onChange={(e) => edit(['adset_variants'], variants.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  </Field>
                  <Field label="Country">
                    <input className={inputClass} value={String(v.country ?? '')} onChange={(e) => edit(['adset_variants'], variants.map((x, j) => (j === i ? { ...x, country: e.target.value.toUpperCase() } : x)))} />
                  </Field>
                  <Field label="Age band" hint="min-max">
                    <input className={inputClass} value={String(v.age_band ?? '')} onChange={(e) => edit(['adset_variants'], variants.map((x, j) => (j === i ? { ...x, age_band: e.target.value } : x)))} />
                  </Field>
                  <Field label="Interests" hint="id:name, comma separated">
                    <input
                      className={inputClass}
                      value={((v.interests as { id: string; name: string }[] | undefined) ?? []).map((x) => `${x.id}:${x.name}`).join(', ')}
                      onChange={(e) =>
                        edit(
                          ['adset_variants'],
                          variants.map((x, j) =>
                            j === i
                              ? { ...x, interests: e.target.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const [id, ...rest] = s.split(':'); return { id: id!.trim(), name: rest.join(':').trim() || id!.trim() }; }) }
                              : x,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Button kind="quiet" onClick={() => edit(['adset_variants'], variants.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </div>
              ))}
              <Button onClick={() => edit(['adset_variants'], [...variants, { name: `US - Interest ${variants.length + 1}`, country: '', age_band: '', interests: [], custom_audiences: [] }])}>Add variant</Button>
            </div>
          )}

          {tab === 'json' && (
            <div>
              <textarea className={`${inputClass} font-mono text-xs min-h-[32rem]`} value={raw} onChange={(e) => { setRaw(e.target.value); setDirty(true); }} spellCheck={false} />
              <p className="text-xs text-ink-3 mt-1">Saving from here validates the whole document first; the id is kept.</p>
            </div>
          )}
          {msg && <p className="text-xs text-ink-3 mt-3">{msg}</p>}
        </Panel>
      )}
      {!doc && msg && <p className="text-xs text-ink-3">{msg}</p>}
    </div>
  );
}
