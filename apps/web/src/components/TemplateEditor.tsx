import { useMemo, useState } from 'react';
import { Badge, Button, Field, inputClass } from './Panel.tsx';

export type Json = Record<string, unknown>;
type Path = string[];

export const getAt = (o: unknown, p: Path): unknown => p.reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Json)[k] : undefined), o);
export const setAt = (o: Json, p: Path, v: unknown): Json => {
  const [head, ...rest] = p;
  if (!head) return o;
  const child = (o[head] && typeof o[head] === 'object' ? { ...(o[head] as Json) } : {}) as Json;
  return { ...o, [head]: rest.length ? setAt(child, rest, v) : v };
};

export const money = (v: unknown) => (typeof v === 'number' ? (v / 100).toFixed(2) : '');
export const toMinor = (s: string) => (s.trim() === '' ? null : Math.round(Number.parseFloat(s) * 100));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const commas = (v: unknown) => list(v).join(', ');
const splitCommas = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

const OBJECTIVES = ['OUTCOME_SALES', 'OUTCOME_LEADS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_AWARENESS', 'OUTCOME_APP_PROMOTION'];
const BID_STRATEGIES = [
  { value: 'LOWEST_COST_WITHOUT_CAP', label: 'Highest volume (no cap)', capped: false },
  { value: 'LOWEST_COST_WITH_BID_CAP', label: 'Bid cap', capped: true },
  { value: 'COST_CAP', label: 'Cost per result goal', capped: true },
  { value: 'LOWEST_COST_WITH_MIN_ROAS', label: 'ROAS goal', capped: true },
];
const BILLING_EVENTS = ['IMPRESSIONS', 'LINK_CLICKS', 'THRUPLAY', 'POST_ENGAGEMENT'];
const GOALS = ['OFFSITE_CONVERSIONS', 'VALUE', 'LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'LEAD_GENERATION', 'IMPRESSIONS', 'REACH', 'THRUPLAY', 'POST_ENGAGEMENT'];
const DESTINATIONS = ['WEBSITE', 'APP', 'MESSENGER', 'WHATSAPP', 'ON_AD', 'ON_POST'];
const EVENTS = ['PURCHASE', 'ADD_TO_CART', 'LEAD', 'COMPLETE_REGISTRATION', 'INITIATE_CHECKOUT', 'VIEW_CONTENT'];
const CTAS = ['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'BUY_NOW', 'GET_OFFER', 'ORDER_NOW', 'SUBSCRIBE', 'CONTACT_US'];
const SPECIAL_CATEGORIES = ['HOUSING', 'EMPLOYMENT', 'CREDIT', 'ISSUES_ELECTIONS_POLITICS', 'FINANCIAL_PRODUCTS_SERVICES', 'ONLINE_GAMBLING_AND_GAMING'];
const PLACEMENTS: { key: string; label: string; choices: string[] }[] = [
  { key: 'publisher_platforms', label: 'Platforms', choices: ['facebook', 'instagram', 'audience_network', 'messenger', 'threads'] },
  { key: 'facebook_positions', label: 'Facebook positions', choices: ['feed', 'right_hand_column', 'marketplace', 'story', 'facebook_reels', 'search', 'profile_feed'] },
  { key: 'instagram_positions', label: 'Instagram positions', choices: ['stream', 'story', 'reels', 'explore_home', 'profile_feed'] },
  { key: 'device_platforms', label: 'Devices', choices: ['mobile', 'desktop'] },
];
const FILL_RULES: { value: string; label: string }[] = [
  { value: 'one_per_ad', label: 'Same creatives in every ad set' },
  { value: 'rotate', label: 'Rotate across all ad slots' },
  { value: 'one_per_adset', label: 'One creative per ad set' },
  { value: 'by_format', label: 'By format (9:16 to Reels and Stories)' },
  { value: 'manual', label: 'Manual (leave the slots empty)' },
];

function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <nav className="flex gap-1 mb-4 flex-wrap">
      {options.map((o) => (
        <button key={o.value} className={`px-3 py-1 text-sm rounded-md ${value === o.value ? 'bg-cobalt-soft text-cobalt font-medium' : 'text-ink-2 hover:bg-panel-2'}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </nav>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3 mt-6 mb-3 first:mt-0">{children}</h3>;
}

function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-2 text-sm ${disabled ? 'text-ink-3' : 'text-ink'}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** The shape a launch produces, from the counts alone: the one place to check before sending. */
export function StructureSummary({ doc }: { doc: Json }) {
  const adSets = Number(getAt(doc, ['adset_count']) ?? 1);
  const perSet = Number(getAt(doc, ['ads_per_adset']) ?? 1);
  const perAd = Number(getAt(doc, ['ad', 'creatives_per_ad']) ?? 1);
  const mode = String(getAt(doc, ['campaign', 'budget', 'mode']) ?? 'CBO');
  const variants = Array.isArray(getAt(doc, ['adset_variants'])) ? (getAt(doc, ['adset_variants']) as Json[]) : [];
  const label = (i: number) => {
    const v = variants[i];
    if (!v) return `Ad set ${i + 1}`;
    const extras = [...((v.interests as { name: string }[] | undefined) ?? []).map((x) => x.name), String(v.country ?? ''), String(v.age_band ?? '')].filter(Boolean);
    return `${String(v.name ?? `Ad set ${i + 1}`)}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
  };
  return (
    <div className="rounded-md border border-line bg-panel-2 px-4 py-3">
      <p className="text-sm font-medium">
        1 campaign → {adSets} ad set{adSets === 1 ? '' : 's'} → {perSet} ad{perSet === 1 ? '' : 's'} each → {perAd} creative{perAd === 1 ? '' : 's'} per ad
      </p>
      <p className="text-xs text-ink-3 tabular-nums mt-0.5">
        {adSets * perSet} ads · {adSets * perSet * perAd} creative slots · {String(getAt(doc, ['ad', 'format']) ?? 'single')} · {mode}
      </p>
      <ul className="mt-2 text-xs text-ink-2 font-mono space-y-0.5">
        <li>▸ {String(getAt(doc, ['campaign', 'name_pattern']) ?? 'campaign')}</li>
        {Array.from({ length: Math.min(adSets, 8) }).map((_, i) => (
          <li key={i} className="pl-3">
            ├ {label(i)} <span className="text-ink-3">({perSet} ads)</span>
          </li>
        ))}
        {adSets > 8 && <li className="pl-3">└ … {adSets - 8} more ad sets</li>}
      </ul>
    </div>
  );
}

export interface TemplateEditorProps {
  doc: Json;
  onChange: (next: Json) => void;
  /** Shown above the tabs; the Launch view uses it for "this product only" wording. */
  note?: React.ReactNode;
  /** Hides the raw JSON tab where a product's copy is edited rather than the file. */
  showJson?: boolean;
}

/**
 * Every lever of the template, in the other tool's layout: a structure summary, then Campaign,
 * Ad set, Ad and per-ad-set rows. Fields not shown here pass through untouched.
 */
export function TemplateEditor({ doc, onChange, note, showJson = true }: TemplateEditorProps) {
  const [tab, setTab] = useState<'campaign' | 'adset' | 'ad' | 'variants' | 'json'>('campaign');
  const [raw, setRaw] = useState(() => JSON.stringify(doc, null, 2));
  const [rawError, setRawError] = useState<string | null>(null);
  const edit = (path: Path, value: unknown) => {
    const next = setAt(doc, path, value);
    onChange(next);
    setRaw(JSON.stringify(next, null, 2));
  };

  const mode = String(getAt(doc, ['campaign', 'budget', 'mode']) ?? 'CBO');
  const isCBO = mode === 'CBO';
  const targeting = (getAt(doc, ['adset', 'targeting']) as Json | undefined) ?? {};
  const placements = (getAt(targeting, ['placements']) as Json | undefined) ?? {};
  const manualPlacements = String(getAt(placements, ['mode']) ?? 'advantage') === 'manual';
  const broad = !!getAt(targeting, ['advantage_audience']);
  const variants = useMemo(() => (Array.isArray(getAt(doc, ['adset_variants'])) ? (getAt(doc, ['adset_variants']) as Json[]) : []), [doc]);
  const capped = (strategy: unknown) => BID_STRATEGIES.find((s) => s.value === strategy)?.capped ?? false;
  const flexible = (getAt(targeting, ['flexible_spec']) as Json[] | undefined) ?? [];
  const setFlexible = (key: 'interests' | 'behaviors', values: string[]) => {
    const first = { ...(flexible[0] ?? {}), [key]: values };
    edit(['adset', 'targeting', 'flexible_spec'], [first, ...flexible.slice(1)]);
  };

  const tabs = [
    { value: 'campaign' as const, label: 'Campaign' },
    { value: 'adset' as const, label: 'Ad set' },
    { value: 'ad' as const, label: 'Ad' },
    { value: 'variants' as const, label: `Ad sets (${variants.length || Number(getAt(doc, ['adset_count']) ?? 1)})` },
    ...(showJson ? [{ value: 'json' as const, label: 'Raw JSON' }] : []),
  ];

  return (
    <div>
      {note}
      <div className="mb-4">
        <StructureSummary doc={doc} />
      </div>
      <Tabs value={tab} onChange={setTab} options={tabs} />

      {tab === 'campaign' && (
        <div>
          <SectionTitle>Objective and buying</SectionTitle>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Template name">
              <input className={inputClass} value={String(getAt(doc, ['name']) ?? '')} onChange={(e) => edit(['name'], e.target.value)} />
            </Field>
            <Field label="Objective">
              <select className={inputClass} value={String(getAt(doc, ['campaign', 'objective']) ?? '')} onChange={(e) => edit(['campaign', 'objective'], e.target.value)}>
                {[...new Set([...OBJECTIVES, String(getAt(doc, ['campaign', 'objective']) ?? '')])].filter(Boolean).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </Field>
            <Field label="Buying type">
              <select className={inputClass} value={String(getAt(doc, ['campaign', 'buying_type']) ?? 'AUCTION')} onChange={(e) => edit(['campaign', 'buying_type'], e.target.value)}>
                <option value="AUCTION">Auction</option>
                <option value="RESERVED">Reserved (reach and frequency)</option>
              </select>
            </Field>
            <Field label="Campaign name pattern" hint="Tokens: {{date}}, {{template}}">
              <input className={inputClass} value={String(getAt(doc, ['campaign', 'name_pattern']) ?? '')} onChange={(e) => edit(['campaign', 'name_pattern'], e.target.value)} />
            </Field>
            <Field label="Special ad categories" hint={`Comma separated. ${SPECIAL_CATEGORIES.slice(0, 3).join(', ')}…`}>
              <input className={inputClass} value={commas(getAt(doc, ['campaign', 'special_ad_categories']))} onChange={(e) => edit(['campaign', 'special_ad_categories'], splitCommas(e.target.value.toUpperCase()))} />
            </Field>
            <Field label="Status on creation" hint="Conveyor always creates paused; activation is its own button">
              <input className={inputClass} value="PAUSED" disabled readOnly />
            </Field>
          </div>

          <SectionTitle>Budget model</SectionTitle>
          <div className="flex items-center gap-2 mb-3">
            {(['CBO', 'ABO'] as const).map((m) => (
              <Button key={m} kind={mode === m ? 'primary' : 'secondary'} onClick={() => edit(['campaign', 'budget', 'mode'], m)}>
                {m === 'CBO' ? 'CBO — campaign budget' : 'ABO — ad set budgets'}
              </Button>
            ))}
            <span className="text-xs text-ink-3">{isCBO ? 'The campaign carries the budget and bid strategy; ad sets send none.' : 'Each ad set carries its own budget; the campaign sends none and sharing off.'}</span>
          </div>
          <div className={`grid gap-4 md:grid-cols-3 ${isCBO ? '' : 'opacity-50'}`}>
            <Field label="Daily budget ($)">
              <input className={inputClass} inputMode="decimal" disabled={!isCBO} value={money(getAt(doc, ['campaign', 'budget', 'daily_budget_minor']))} onChange={(e) => edit(['campaign', 'budget', 'daily_budget_minor'], toMinor(e.target.value))} />
            </Field>
            <Field label="Lifetime budget ($)" hint="Needs an end time on the schedule">
              <input className={inputClass} inputMode="decimal" disabled={!isCBO} value={money(getAt(doc, ['campaign', 'budget', 'lifetime_budget_minor']))} onChange={(e) => edit(['campaign', 'budget', 'lifetime_budget_minor'], toMinor(e.target.value))} />
            </Field>
            <Field label="Bid strategy">
              <select className={inputClass} disabled={!isCBO} value={String(getAt(doc, ['campaign', 'budget', 'bid_strategy']) ?? '')} onChange={(e) => edit(['campaign', 'budget', 'bid_strategy'], e.target.value)}>
                {BID_STRATEGIES.map((b) => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
            </Field>
            {String(getAt(doc, ['campaign', 'budget', 'bid_strategy'])) === 'LOWEST_COST_WITH_MIN_ROAS' ? (
              <Field label="ROAS floor">
                <input className={inputClass} inputMode="decimal" disabled={!isCBO} value={String(getAt(doc, ['campaign', 'budget', 'roas_average_floor']) ?? '')} onChange={(e) => edit(['campaign', 'budget', 'roas_average_floor'], e.target.value === '' ? null : Number(e.target.value))} />
              </Field>
            ) : (
              <Field label="Bid or cost cap ($)" hint={capped(getAt(doc, ['campaign', 'budget', 'bid_strategy'])) ? 'Sent only for capped strategies' : 'Not sent for this strategy'}>
                <input className={inputClass} inputMode="decimal" disabled={!isCBO || !capped(getAt(doc, ['campaign', 'budget', 'bid_strategy']))} value={money(getAt(doc, ['campaign', 'budget', 'bid_amount_minor']))} onChange={(e) => edit(['campaign', 'budget', 'bid_amount_minor'], toMinor(e.target.value))} />
              </Field>
            )}
            <Field label="Spend cap ($)" hint="Optional, either mode">
              <input className={inputClass} inputMode="decimal" value={money(getAt(doc, ['campaign', 'budget', 'spend_cap_minor']))} onChange={(e) => edit(['campaign', 'budget', 'spend_cap_minor'], toMinor(e.target.value))} />
            </Field>
          </div>

          <SectionTitle>Counts</SectionTitle>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Number of ad sets" hint={variants.length ? 'Driven by the rows on the Ad sets tab' : 'The ad set settings are cloned this many times'}>
              <input className={inputClass} inputMode="numeric" disabled={variants.length > 0} value={String(getAt(doc, ['adset_count']) ?? 1)} onChange={(e) => edit(['adset_count'], Math.max(1, Number(e.target.value) || 1))} />
            </Field>
            <Field label="Ads per ad set">
              <input className={inputClass} inputMode="numeric" value={String(getAt(doc, ['ads_per_adset']) ?? 1)} onChange={(e) => edit(['ads_per_adset'], Math.max(1, Number(e.target.value) || 1))} />
            </Field>
            <Field label="How creatives fill the ads" hint="Kept under x_conveyor; the export for your other tool drops it">
              <select className={inputClass} value={String(getAt(doc, ['x_conveyor', 'fillRule']) ?? '')} onChange={(e) => edit(['x_conveyor', 'fillRule'], e.target.value || undefined)}>
                <option value="">Use the setting under Settings</option>
                {FILL_RULES.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      )}

      {tab === 'adset' && (
        <div>
          <SectionTitle>Delivery</SectionTitle>
          <div className="grid gap-4 md:grid-cols-4">
            <Field label="Ad set name pattern" hint="Tokens: {{campaign}}, {{variation}}">
              <input className={inputClass} value={String(getAt(doc, ['adset', 'name_pattern']) ?? '')} onChange={(e) => edit(['adset', 'name_pattern'], e.target.value)} />
            </Field>
            <Field label="Billing event">
              <select className={inputClass} value={String(getAt(doc, ['adset', 'billing_event']) ?? '')} onChange={(e) => edit(['adset', 'billing_event'], e.target.value)}>
                {BILLING_EVENTS.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </Field>
            <Field label="Optimisation goal">
              <select className={inputClass} value={String(getAt(doc, ['adset', 'optimization_goal']) ?? '')} onChange={(e) => edit(['adset', 'optimization_goal'], e.target.value)}>
                {GOALS.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </Field>
            <Field label="Destination type">
              <select className={inputClass} value={String(getAt(doc, ['adset', 'destination_type']) ?? 'WEBSITE')} onChange={(e) => edit(['adset', 'destination_type'], e.target.value)}>
                {DESTINATIONS.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </Field>
          </div>

          <SectionTitle>Budget and bidding{isCBO ? ' (campaign budget is on, so these are not sent)' : ''}</SectionTitle>
          <div className={`grid gap-4 md:grid-cols-4 ${isCBO ? 'opacity-50' : ''}`}>
            <Field label="Daily budget ($)">
              <input className={inputClass} inputMode="decimal" disabled={isCBO} value={money(getAt(doc, ['adset', 'budget', 'daily_budget_minor']))} onChange={(e) => edit(['adset', 'budget', 'daily_budget_minor'], toMinor(e.target.value))} />
            </Field>
            <Field label="Lifetime budget ($)" hint="Needs an end time">
              <input className={inputClass} inputMode="decimal" disabled={isCBO} value={money(getAt(doc, ['adset', 'budget', 'lifetime_budget_minor']))} onChange={(e) => edit(['adset', 'budget', 'lifetime_budget_minor'], toMinor(e.target.value))} />
            </Field>
            <Field label="Bid strategy">
              <select className={inputClass} disabled={isCBO} value={String(getAt(doc, ['adset', 'budget', 'bid_strategy']) ?? '')} onChange={(e) => edit(['adset', 'budget', 'bid_strategy'], e.target.value)}>
                {BID_STRATEGIES.map((b) => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
            </Field>
            {String(getAt(doc, ['adset', 'budget', 'bid_strategy'])) === 'LOWEST_COST_WITH_MIN_ROAS' ? (
              <Field label="ROAS floor">
                <input className={inputClass} inputMode="decimal" disabled={isCBO} value={String(getAt(doc, ['adset', 'budget', 'roas_average_floor']) ?? '')} onChange={(e) => edit(['adset', 'budget', 'roas_average_floor'], e.target.value === '' ? null : Number(e.target.value))} />
              </Field>
            ) : (
              <Field label="Bid or cost cap ($)">
                <input className={inputClass} inputMode="decimal" disabled={isCBO || !capped(getAt(doc, ['adset', 'budget', 'bid_strategy']))} value={money(getAt(doc, ['adset', 'budget', 'bid_amount_minor']))} onChange={(e) => edit(['adset', 'budget', 'bid_amount_minor'], toMinor(e.target.value))} />
              </Field>
            )}
          </div>

          <SectionTitle>Schedule</SectionTitle>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Start time" hint="A time in the past means the ad set starts when you activate it">
              <input className={inputClass} type="datetime-local" value={toLocalInput(getAt(doc, ['adset', 'schedule', 'start_time']))} onChange={(e) => edit(['adset', 'schedule', 'start_time'], fromLocalInput(e.target.value))} />
            </Field>
            <Field label="End time" hint="Required with a lifetime budget">
              <input className={inputClass} type="datetime-local" value={toLocalInput(getAt(doc, ['adset', 'schedule', 'end_time']))} onChange={(e) => edit(['adset', 'schedule', 'end_time'], fromLocalInput(e.target.value))} />
            </Field>
          </div>

          <SectionTitle>Conversion and attribution</SectionTitle>
          <div className="grid gap-4 md:grid-cols-4">
            <Field label="Pixel ID" hint="Empty uses the pixel under Settings, Accounts">
              <input className={inputClass} value={String(getAt(doc, ['adset', 'promoted_object', 'pixel_id']) ?? '')} onChange={(e) => edit(['adset', 'promoted_object', 'pixel_id'], e.target.value || null)} />
            </Field>
            <Field label="Conversion event">
              <select className={inputClass} value={String(getAt(doc, ['adset', 'promoted_object', 'custom_event_type']) ?? '')} onChange={(e) => edit(['adset', 'promoted_object', 'custom_event_type'], e.target.value || null)}>
                <option value="">Not sent</option>
                {EVENTS.map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </select>
            </Field>
            {(['CLICK_THROUGH', 'VIEW_THROUGH'] as const).map((kind) => {
              const spec = (getAt(doc, ['adset', 'attribution_spec']) as { event_type: string; window_days: number }[] | undefined) ?? [];
              const found = spec.find((a) => a.event_type === kind);
              return (
                <Field key={kind} label={`${kind === 'CLICK_THROUGH' ? 'Click-through' : 'View-through'} window (days)`}>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={found ? String(found.window_days) : ''}
                    onChange={(e) => {
                      const days = Number(e.target.value);
                      const rest = spec.filter((a) => a.event_type !== kind);
                      edit(['adset', 'attribution_spec'], e.target.value === '' || !days ? rest : [...rest, { event_type: kind, window_days: days }]);
                    }}
                  />
                </Field>
              );
            })}
          </div>

          <SectionTitle>Geography and demographics</SectionTitle>
          <div className="grid gap-4 md:grid-cols-4">
            <Field label="Countries" hint="Two-letter codes, comma separated">
              <input className={inputClass} value={commas(getAt(targeting, ['geo_locations', 'countries']))} onChange={(e) => edit(['adset', 'targeting', 'geo_locations', 'countries'], splitCommas(e.target.value.toUpperCase()))} />
            </Field>
            <Field label="Excluded countries">
              <input className={inputClass} value={commas(getAt(targeting, ['excluded_geo_locations', 'countries']))} onChange={(e) => edit(['adset', 'targeting', 'excluded_geo_locations', 'countries'], splitCommas(e.target.value.toUpperCase()))} />
            </Field>
            <Field label="Age min" hint={broad ? 'Advantage+ audience needs 18 to 25' : ''}>
              <input className={inputClass} inputMode="numeric" value={String(getAt(targeting, ['age_min']) ?? '')} onChange={(e) => edit(['adset', 'targeting', 'age_min'], Number(e.target.value) || null)} />
            </Field>
            <Field label="Age max" hint={broad ? 'Not sent while Advantage+ audience is on' : ''}>
              <input className={inputClass} inputMode="numeric" value={String(getAt(targeting, ['age_max']) ?? '')} onChange={(e) => edit(['adset', 'targeting', 'age_max'], Number(e.target.value) || null)} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-6 mt-3">
            <div className="flex items-center gap-4">
              <span className="text-xs font-medium text-ink-2">Genders</span>
              {([[1, 'Men'], [2, 'Women']] as const).map(([value, label]) => (
                <Check
                  key={value}
                  label={label}
                  checked={list(getAt(targeting, ['genders'])).includes(String(value))}
                  onChange={(on) => {
                    const cur = ((getAt(targeting, ['genders']) as number[] | undefined) ?? []).filter((g) => g !== value);
                    edit(['adset', 'targeting', 'genders'], on ? [...cur, value].sort() : cur);
                  }}
                />
              ))}
              <span className="text-xs text-ink-3">{broad ? 'A suggestion only while Advantage+ audience is on' : 'Empty means everyone'}</span>
            </div>
            <Field label="Languages (locale IDs)">
              <input className={inputClass} value={commas(getAt(targeting, ['locales']))} onChange={(e) => edit(['adset', 'targeting', 'locales'], splitCommas(e.target.value).map(Number).filter((n) => !Number.isNaN(n)))} />
            </Field>
          </div>

          <SectionTitle>Audience</SectionTitle>
          <Check label="Advantage+ audience (Meta finds the audience)" checked={broad} onChange={(v) => edit(['adset', 'targeting', 'advantage_audience'], v)} />
          <p className="text-xs text-ink-3 mt-1 mb-3">
            An ad set that includes an interest or custom audience is always sent with this off, whatever is set here: the two cannot be combined. Interests per ad set live on the Ad sets tab.
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Interest IDs (include)" hint="Numeric IDs, comma separated">
              <input className={inputClass} disabled={broad} value={commas(getAt(flexible[0] ?? {}, ['interests']))} onChange={(e) => setFlexible('interests', splitCommas(e.target.value))} />
            </Field>
            <Field label="Behaviour IDs (include)">
              <input className={inputClass} disabled={broad} value={commas(getAt(flexible[0] ?? {}, ['behaviors']))} onChange={(e) => setFlexible('behaviors', splitCommas(e.target.value))} />
            </Field>
            <Field label="Excluded interest IDs">
              <input className={inputClass} value={commas(getAt(targeting, ['exclusions', 'interests']))} onChange={(e) => edit(['adset', 'targeting', 'exclusions', 'interests'], splitCommas(e.target.value))} />
            </Field>
            <Field label="Custom audience IDs (include)" hint={broad ? 'Not sent while Advantage+ audience is on' : ''}>
              <input className={inputClass} disabled={broad} value={((getAt(targeting, ['custom_audiences']) as { id?: string }[] | undefined) ?? []).map((a) => String(a?.id ?? a)).join(', ')} onChange={(e) => edit(['adset', 'targeting', 'custom_audiences'], splitCommas(e.target.value).map((id) => ({ id })))} />
            </Field>
            <Field label="Excluded custom audience IDs">
              <input className={inputClass} value={((getAt(targeting, ['excluded_custom_audiences']) as { id?: string }[] | undefined) ?? []).map((a) => String(a?.id ?? a)).join(', ')} onChange={(e) => edit(['adset', 'targeting', 'excluded_custom_audiences'], splitCommas(e.target.value).map((id) => ({ id })))} />
            </Field>
          </div>

          <SectionTitle>Placements</SectionTitle>
          <div className="flex items-center gap-2 mb-3">
            {([['advantage', 'Advantage+ placements'], ['manual', 'Manual placements']] as const).map(([value, label]) => (
              <Button key={value} kind={String(getAt(placements, ['mode']) ?? 'advantage') === value ? 'primary' : 'secondary'} onClick={() => edit(['adset', 'targeting', 'placements', 'mode'], value)}>
                {label}
              </Button>
            ))}
          </div>
          {manualPlacements ? (
            <div className="grid gap-4 md:grid-cols-4">
              {PLACEMENTS.map((group) => (
                <div key={group.key}>
                  <p className="text-xs font-medium text-ink-2 mb-1">{group.label}</p>
                  {group.choices.map((choice) => (
                    <Check
                      key={choice}
                      label={choice}
                      checked={list(getAt(placements, ['manual', group.key])).includes(choice)}
                      onChange={(on) => {
                        const cur = list(getAt(placements, ['manual', group.key])).filter((x) => x !== choice);
                        edit(['adset', 'targeting', 'placements', 'manual', group.key], on ? [...cur, choice] : cur);
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-ink-3">Meta chooses the placements and no positions are sent. Manual lists always drop video feeds and explore, which Meta rejects.</p>
          )}
        </div>
      )}

      {tab === 'ad' && (
        <div>
          <SectionTitle>Format</SectionTitle>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Ad format" hint="Conveyor sends single image ads; other formats are noted at launch">
              <select className={inputClass} value={String(getAt(doc, ['ad', 'format']) ?? 'single')} onChange={(e) => edit(['ad', 'format'], e.target.value)}>
                <option value="single">Single image</option>
                <option value="carousel">Carousel</option>
                <option value="dynamic_creative">Dynamic creative</option>
              </select>
            </Field>
            <Field label="Creatives per ad">
              <input className={inputClass} inputMode="numeric" value={String(getAt(doc, ['ad', 'creatives_per_ad']) ?? 1)} onChange={(e) => edit(['ad', 'creatives_per_ad'], Math.max(1, Number(e.target.value) || 1))} />
            </Field>
            <Field label="Ad name pattern" hint="Tokens: {{creative_filename}}, {{campaign}}, {{variation}}">
              <input className={inputClass} value={String(getAt(doc, ['ad', 'name_pattern']) ?? '')} onChange={(e) => edit(['ad', 'name_pattern'], e.target.value)} />
            </Field>
          </div>

          <SectionTitle>Identity</SectionTitle>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Page ID" hint="Empty uses the Page under Settings, Accounts">
              <input className={inputClass} value={String(getAt(doc, ['ad', 'page_id']) ?? '')} onChange={(e) => edit(['ad', 'page_id'], e.target.value || null)} />
            </Field>
            <Field label="Instagram user ID" hint="Optional; enables Instagram placements">
              <input className={inputClass} value={String(getAt(doc, ['ad', 'instagram_user_id']) ?? '')} onChange={(e) => edit(['ad', 'instagram_user_id'], e.target.value || null)} />
            </Field>
          </div>

          <SectionTitle>Copy</SectionTitle>
          <p className="text-xs text-ink-3 mb-3">The product's own copy, written with its listing, takes precedence at launch. These are the fallback and the example.</p>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Primary text">
              <textarea className={`${inputClass} min-h-24`} value={String(getAt(doc, ['ad', 'primary_text']) ?? '')} onChange={(e) => edit(['ad', 'primary_text'], e.target.value)} />
            </Field>
            <div className="space-y-4">
              <Field label="Headline">
                <input className={inputClass} value={String(getAt(doc, ['ad', 'headline']) ?? '')} onChange={(e) => edit(['ad', 'headline'], e.target.value)} />
              </Field>
              <Field label="Description">
                <input className={inputClass} value={String(getAt(doc, ['ad', 'description']) ?? '')} onChange={(e) => edit(['ad', 'description'], e.target.value)} />
              </Field>
            </div>
            <Field label="Call to action">
              <select className={inputClass} value={String(getAt(doc, ['ad', 'default_cta']) ?? 'SHOP_NOW')} onChange={(e) => edit(['ad', 'default_cta'], e.target.value)}>
                {[...new Set([...CTAS, String(getAt(doc, ['ad', 'default_cta']) ?? '')])].filter(Boolean).map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </select>
            </Field>
            <Field label="Destination URL" hint="The product's Shopify URL replaces this at launch">
              <input className={inputClass} value={String(getAt(doc, ['ad', 'destination_url']) ?? '')} onChange={(e) => edit(['ad', 'destination_url'], e.target.value)} />
            </Field>
            <Field label="URL parameters" hint="Tokens are URL-encoded before sending">
              <input className={inputClass} value={String(getAt(doc, ['ad', 'url_params']) ?? '')} onChange={(e) => edit(['ad', 'url_params'], e.target.value)} />
            </Field>
          </div>
          <div className="mt-4">
            <Check label="Advantage+ creative enhancements" checked={!!getAt(doc, ['ad', 'advantage_creative_enhancements'])} onChange={(v) => edit(['ad', 'advantage_creative_enhancements'], v)} />
            <p className="text-xs text-ink-3 mt-1">Set feature by feature when sent; the removed standard_enhancements bundle is never used. Off opts every feature out, which keeps Meta from altering the images.</p>
          </div>
        </div>
      )}

      {tab === 'variants' && (
        <div className="space-y-2">
          <p className="text-xs text-ink-3">
            One row per ad set. One interest per name: “US - Formal Wear” looks up Formal wear, “US - Broad” means none, “US - Interest 1” is a placeholder until renamed. Interests written here are used as they are.
          </p>
          {variants.map((v, i) => (
            <div key={i} className="grid gap-2 md:grid-cols-[2fr_1fr_1fr_2fr_auto] items-end border border-line rounded-md p-2 bg-panel-2">
              <Field label={`Ad set ${i + 1} name`}>
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
                          ? { ...x, interests: splitCommas(e.target.value).map((s) => { const [id, ...rest] = s.split(':'); return { id: id!.trim(), name: rest.join(':').trim() || id!.trim() }; }) }
                          : x,
                      ),
                    )
                  }
                />
              </Field>
              <Button
                kind="quiet"
                onClick={() => {
                  const next = variants.filter((_, j) => j !== i);
                  onChange(setAt(setAt(doc, ['adset_variants'], next), ['adset_count'], Math.max(1, next.length || Number(getAt(doc, ['adset_count']) ?? 1))));
                }}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            onClick={() => {
              const next = [...variants, { name: `US - Interest ${variants.length + 1}`, country: '', age_band: '', interests: [], custom_audiences: [] }];
              onChange(setAt(setAt(doc, ['adset_variants'], next), ['adset_count'], next.length));
            }}
          >
            Add ad set
          </Button>
        </div>
      )}

      {tab === 'json' && (
        <div>
          <textarea
            className={`${inputClass} font-mono text-xs min-h-[32rem]`}
            value={raw}
            spellCheck={false}
            onChange={(e) => {
              setRaw(e.target.value);
              try {
                onChange(JSON.parse(e.target.value) as Json);
                setRawError(null);
              } catch (err) {
                setRawError(err instanceof Error ? err.message : 'Not valid JSON');
              }
            }}
          />
          {rawError ? <p className="text-xs text-red mt-1">{rawError}</p> : <p className="text-xs text-ink-3 mt-1">Every field, including the ones the forms do not show. Saving validates the whole document.</p>}
        </div>
      )}
    </div>
  );
}

export function toLocalInput(iso: unknown): string {
  if (typeof iso !== 'string' || !iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

/** The "unsaved" flag both tabs show next to the save button. */
export function DirtyBadge({ dirty }: { dirty: boolean }) {
  return dirty ? <Badge tone="amber">Unsaved</Badge> : null;
}
