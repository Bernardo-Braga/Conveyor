import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { Template, type ListingWriterId } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { importProfiles, productCopy, products } from '../db/schema.ts';
import { dropTokenKeys } from '../http/redact.ts';
import { structuredRunWithFallback } from '../listing/writers/structured.ts';
import type { RunCli } from '../listing/writers/types.ts';
import { looksLikeTemplate, parseTemplate } from './templates.ts';

export type ImportFormat = 'template' | 'graph' | 'unknown';

/** Detection order. */
export function detectFormat(raw: unknown): ImportFormat {
  if (looksLikeTemplate(raw)) return 'template';
  const o = raw as Record<string, unknown> | null;
  if (o && typeof o === 'object') {
    const campaign = (o.campaign ?? o) as Record<string, unknown>;
    const hasGraphCampaign = typeof campaign.objective === 'string' && ('adsets' in o || 'ad_sets' in o || 'adsets' in campaign || 'daily_budget' in campaign || 'lifetime_budget' in campaign);
    if (hasGraphCampaign) return 'graph';
  }
  return 'unknown';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Plain Meta API field names (a campaign with `adsets`, each with `ads`, as the Graph API returns
 * them) become the other tool's shape. Graph budgets are already in minor units.
 */
export function fromGraphExport(raw: unknown): { template: Template; notes: string[] } {
  const root = obj(raw);
  const campaign = 'campaign' in root ? obj(root.campaign) : root;
  const adsets = arr(root.adsets ?? root.ad_sets ?? campaign.adsets).map(obj);
  const first = adsets[0] ?? {};
  const firstAd = obj(arr(first.ads)[0]);
  const creative = obj(firstAd.creative);
  const spec = obj(creative.object_story_spec);
  const link = obj(spec.link_data);
  const notes: string[] = [];
  const campaignBudget = num(campaign.daily_budget) ?? num(campaign.lifetime_budget);
  const mode = campaignBudget != null ? 'CBO' : 'ABO';
  if (!adsets.length) notes.push('No ad sets in the file; one placeholder variant was created.');
  const targeting = obj(first.targeting);
  const geo = obj(targeting.geo_locations);
  const automation = obj(targeting.targeting_automation);
  const interestsOf = (t: Record<string, unknown>) => arr(t.flexible_spec).flatMap((g) => arr(obj(g).interests).map((i) => ({ id: str(obj(i).id), name: str(obj(i).name) }))).filter((i) => i.id);
  const template: unknown = {
    id: `tmpl_${createHash('sha1').update(JSON.stringify(raw)).digest('hex').slice(0, 8)}`,
    name: str(campaign.name, 'Imported campaign'),
    version: 1,
    campaign: {
      objective: str(campaign.objective, 'OUTCOME_SALES'),
      buying_type: str(campaign.buying_type, 'AUCTION'),
      special_ad_categories: arr(campaign.special_ad_categories).map((x) => str(x)),
      name_pattern: '{{date}}_{{template}}',
      budget: { mode, daily_budget_minor: num(campaign.daily_budget), lifetime_budget_minor: num(campaign.lifetime_budget), bid_strategy: str(campaign.bid_strategy ?? first.bid_strategy, 'LOWEST_COST_WITHOUT_CAP'), bid_amount_minor: num(campaign.bid_amount ?? first.bid_amount), roas_average_floor: null, spend_cap_minor: num(campaign.spend_cap) },
      status_default: 'PAUSED',
    },
    adset_count: Math.max(1, adsets.length),
    adset: {
      name_pattern: '{{campaign}} – {{variation}}',
      budget: { daily_budget_minor: num(first.daily_budget), lifetime_budget_minor: num(first.lifetime_budget), bid_strategy: str(first.bid_strategy, 'LOWEST_COST_WITHOUT_CAP'), bid_amount_minor: num(first.bid_amount), roas_average_floor: null },
      billing_event: str(first.billing_event, 'IMPRESSIONS'),
      optimization_goal: str(first.optimization_goal, 'OFFSITE_CONVERSIONS'),
      destination_type: str(first.destination_type, 'WEBSITE'),
      schedule: { start_time: first.start_time ? new Date(typeof first.start_time === 'number' ? first.start_time * 1000 : String(first.start_time)).toISOString() : null, end_time: first.end_time ? new Date(typeof first.end_time === 'number' ? first.end_time * 1000 : String(first.end_time)).toISOString() : null, dayparting: null },
      promoted_object: { pixel_id: str(obj(first.promoted_object).pixel_id) || null, custom_event_type: str(obj(first.promoted_object).custom_event_type) || null },
      attribution_spec: arr(first.attribution_spec).map(obj),
      targeting: {
        geo_locations: { countries: arr(geo.countries).map((c) => str(c)), regions: arr(geo.regions), cities: arr(geo.cities), zips: arr(geo.zips), custom_locations: arr(geo.custom_locations) },
        excluded_geo_locations: obj(targeting.excluded_geo_locations),
        age_min: num(targeting.age_min),
        age_max: num(targeting.age_max),
        genders: arr(targeting.genders).map((g) => Number(g)).filter(Number.isFinite),
        locales: arr(targeting.locales),
        flexible_spec: [{ interests: [], behaviors: [], demographics: [] }],
        exclusions: obj(targeting.exclusions),
        custom_audiences: arr(targeting.custom_audiences),
        excluded_custom_audiences: arr(targeting.excluded_custom_audiences),
        advantage_audience: automation.advantage_audience === 1 || automation.advantage_audience === true,
        placements: targeting.publisher_platforms || targeting.facebook_positions || targeting.instagram_positions
          ? { mode: 'manual', manual: { publisher_platforms: arr(targeting.publisher_platforms).map((x) => str(x)), facebook_positions: arr(targeting.facebook_positions).map((x) => str(x)), instagram_positions: arr(targeting.instagram_positions).map((x) => str(x)), device_platforms: arr(targeting.device_platforms).map((x) => str(x)) } }
          : { mode: 'advantage' },
      },
    },
    ads_per_adset: Math.max(1, arr(first.ads).length || 1),
    ad: {
      name_pattern: '{{creative_filename}}',
      format: 'single',
      creatives_per_ad: 1,
      distribution_mode: 'one_per_ad',
      page_id: str(spec.page_id),
      instagram_user_id: spec.instagram_user_id ? str(spec.instagram_user_id) : null,
      default_cta: str(obj(link.call_to_action).type, 'SHOP_NOW'),
      primary_text: str(link.message),
      headline: str(link.name),
      description: str(link.description),
      destination_url: str(link.link),
      url_params: str(creative.url_tags),
      advantage_creative_enhancements: false,
      status_default: 'PAUSED',
    },
    adset_variants: (adsets.length ? adsets : [{ name: 'US - Broad' }]).map((s) => ({ name: str(s.name, 'Ad set'), country: '', age_band: '', interests: interestsOf(obj(s.targeting)), custom_audiences: [] })),
    x_conveyor: { notes: ['Converted from plain Meta API fields'] },
  };
  if (adsets.length && interestsOf(targeting).length) notes.push('Interests were read from each ad set\'s flexible_spec and kept as they are.');
  return { template: parseTemplate(template), notes };
}

/** A stable fingerprint of a file's shape (its key paths), so a confirmed mapping is reused for files of that shape. */
export function shapeSignature(raw: unknown): string {
  const paths: string[] = [];
  const walk = (v: unknown, prefix: string, depth: number) => {
    if (depth > 4 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      if (v.length) walk(v[0], `${prefix}[]`, depth + 1);
      return;
    }
    for (const k of Object.keys(v as object).sort()) {
      paths.push(`${prefix}.${k}`);
      walk((v as Record<string, unknown>)[k], `${prefix}.${k}`, depth + 1);
    }
  };
  walk(raw, '$', 0);
  return createHash('sha256').update(paths.join('\n')).digest('hex').slice(0, 24);
}

/** A mapping: template field path → source path (dot path with `[]` for the first array item) or a literal value. */
export const Mapping = z.record(z.string(), z.object({ from: z.string().nullable(), value: z.unknown().optional(), /** For `_minor` targets: `major` means the source is in whole currency units and is multiplied by 100. */ unit: z.enum(['major', 'minor']).optional() }));
export type Mapping = z.infer<typeof Mapping>;

export function getPath(root: unknown, dotPath: string): unknown {
  return dotPath
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((cur, seg) => {
      if (cur == null) return undefined;
      const m = seg.match(/^([^[]+)(\[\])?$/);
      const key = m?.[1] ?? seg;
      let next = (cur as Record<string, unknown>)[key];
      if (m?.[2]) next = Array.isArray(next) ? next[0] : undefined;
      return next;
    }, root);
}

function setPath(root: Record<string, unknown>, dotPath: string, value: unknown): void {
  const segs = dotPath.split('.').filter(Boolean);
  let cur: Record<string, unknown> = root;
  segs.slice(0, -1).forEach((s) => {
    if (!cur[s] || typeof cur[s] !== 'object') cur[s] = {};
    cur = cur[s] as Record<string, unknown>;
  });
  cur[segs.at(-1)!] = value;
}

/** Fields a mapping must fill for the template to validate. Everything else has a default. */
export const REQUIRED_TARGETS = ['name', 'campaign.objective', 'campaign.budget.mode', 'adset.optimization_goal', 'adset.billing_event', 'ad.primary_text', 'ad.headline', 'ad.destination_url'] as const;

const SKELETON = (): Record<string, unknown> => ({
  id: '',
  name: '',
  version: 1,
  campaign: { objective: 'OUTCOME_SALES', buying_type: 'AUCTION', special_ad_categories: [], name_pattern: '{{date}}_{{template}}', budget: { mode: 'CBO', daily_budget_minor: null, lifetime_budget_minor: null, bid_strategy: 'LOWEST_COST_WITHOUT_CAP', bid_amount_minor: null, roas_average_floor: null, spend_cap_minor: null }, status_default: 'PAUSED' },
  adset_count: 1,
  adset: { name_pattern: '{{campaign}} – {{variation}}', budget: { daily_budget_minor: null, lifetime_budget_minor: null, bid_strategy: 'LOWEST_COST_WITHOUT_CAP', bid_amount_minor: null, roas_average_floor: null }, billing_event: 'IMPRESSIONS', optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE', schedule: { start_time: null, end_time: null, dayparting: null }, promoted_object: { pixel_id: null, custom_event_type: 'PURCHASE' }, attribution_spec: [], targeting: { geo_locations: { countries: ['US'] }, excluded_geo_locations: {}, age_min: 18, age_max: 65, genders: [], locales: [], flexible_spec: [], exclusions: {}, custom_audiences: [], excluded_custom_audiences: [], advantage_audience: true, placements: { mode: 'advantage' } } },
  ads_per_adset: 1,
  ad: { name_pattern: '{{creative_filename}}', format: 'single', creatives_per_ad: 1, distribution_mode: 'one_per_ad', page_id: '', instagram_user_id: null, default_cta: 'SHOP_NOW', primary_text: '', headline: '', description: '', destination_url: '', url_params: 'utm_source=meta&utm_campaign={{campaign}}', advantage_creative_enhancements: false, status_default: 'PAUSED' },
  adset_variants: [{ name: 'US - Broad', country: '', age_band: '', interests: [], custom_audiences: [] }],
});

/** Builds a template from an unknown file with a mapping. Money given in whole currency units is converted when the target ends in `_minor`. */
export function applyMapping(raw: unknown, mapping: Mapping): { template: Template | null; preview: Record<string, unknown>; problems: string[] } {
  const out = SKELETON();
  out.id = `tmpl_${shapeSignature(raw).slice(0, 8)}_${createHash('sha1').update(JSON.stringify(raw)).digest('hex').slice(0, 6)}`;
  const problems: string[] = [];
  for (const [target, rule] of Object.entries(mapping)) {
    let v: unknown = rule.value !== undefined ? rule.value : rule.from ? getPath(raw, rule.from) : undefined;
    if (v === undefined) {
      if ((REQUIRED_TARGETS as readonly string[]).includes(target)) problems.push(`${target}: nothing found at ${rule.from ?? '(no source)'}`);
      continue;
    }
    if (target.endsWith('_minor') && typeof v === 'number') v = rule.unit === 'major' ? Math.round(v * 100) : Math.round(v);
    if (target === 'adset_variants' && Array.isArray(v)) {
      // Variant names may sit under name, label, title or value in a foreign file.
      v = v.map((x, i) => {
        if (typeof x === 'string') return { name: x, country: '', age_band: '', interests: [], custom_audiences: [] };
        const o = obj(x);
        const name = str(o.name) || str(o.label) || str(o.title) || str(o.value) || `Ad set ${i + 1}`;
        return { country: '', age_band: '', interests: [], custom_audiences: [], ...o, name };
      });
    }
    setPath(out, target, v);
  }
  if (Array.isArray(out.adset_variants)) out.adset_count = Math.max(1, (out.adset_variants as unknown[]).length);
  for (const t of REQUIRED_TARGETS) {
    const v = getPath(out, t);
    if (v === '' || v == null) problems.push(`${t} is empty`);
  }
  const parsed = Template.safeParse(dropTokenKeys(out));
  if (!parsed.success) problems.push(...parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`));
  return { template: parsed.success && !problems.length ? parsed.data : null, preview: out, problems: [...new Set(problems)] };
}

export function getProfile(db: Db, signature: string) {
  return db.select().from(importProfiles).where(eq(importProfiles.signature, signature)).get() ?? null;
}

export function saveProfile(db: Db, signature: string, mapping: Mapping, confirmed: boolean): void {
  db.insert(importProfiles).values({ signature, mapping, confirmed }).onConflictDoUpdate({ target: importProfiles.signature, set: { mapping, confirmed } }).run();
}

const MAPPING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mapping: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { target: { type: 'string' }, from: { type: ['string', 'null'] }, value: { type: ['string', 'number', 'boolean', 'null'] } }, required: ['target', 'from'] },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['mapping', 'notes'],
} as const;

/** Keys of the unknown file, to a depth of four, so the writer sees the shape without the whole file. */
export function describeShape(raw: unknown, maxLines = 200): string {
  const lines: string[] = [];
  const walk = (v: unknown, prefix: string, depth: number) => {
    if (lines.length >= maxLines) return;
    if (Array.isArray(v)) {
      lines.push(`${prefix}[] (${v.length} items)`);
      if (v.length) walk(v[0], `${prefix}[]`, depth + 1);
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (val && typeof val === 'object') walk(val, p, depth + 1);
        else lines.push(`${p}: ${typeof val === 'string' ? JSON.stringify(val.slice(0, 60)) : String(val)}`);
      }
      return;
    }
    lines.push(`${prefix}: ${String(v)}`);
  };
  walk(raw, '', 0);
  return lines.join('\n');
}

/**
 * Step 3 of detection: one writer run proposes a mapping from the unknown file's paths to the
 * template's fields. The user confirms it; later files of that shape cost 0 requests.
 */
export async function proposeMapping(raw: unknown, dir: string, preferred: ListingWriterId, opts: { run?: RunCli } = {}): Promise<{ mapping: Mapping; notes: string[]; writer: ListingWriterId }> {
  const prompt = [
    'You map an unknown ad-campaign export onto a fixed template shape. Reply with JSON only.',
    'Template targets (dot paths) and what they mean:',
    '- name: campaign or template name',
    '- campaign.objective (e.g. OUTCOME_SALES), campaign.buying_type (AUCTION), campaign.budget.mode ("CBO" when the budget sits on the campaign, "ABO" when on ad sets)',
    '- campaign.budget.daily_budget_minor / lifetime_budget_minor: budget in minor units (cents). If the source is in whole currency units, still point at it; a decimal is converted.',
    '- campaign.budget.bid_strategy (LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP, LOWEST_COST_WITH_MIN_ROAS)',
    '- adset.budget.daily_budget_minor, adset.optimization_goal (e.g. OFFSITE_CONVERSIONS), adset.billing_event (IMPRESSIONS), adset.destination_type (WEBSITE)',
    '- adset.schedule.start_time, adset.schedule.end_time (ISO strings)',
    '- adset.promoted_object.pixel_id, adset.promoted_object.custom_event_type (PURCHASE)',
    '- adset.targeting.geo_locations.countries (array of ISO codes), adset.targeting.age_min, adset.targeting.age_max, adset.targeting.genders (array, 1 men 2 women), adset.targeting.advantage_audience (boolean)',
    '- ads_per_adset (integer), ad.primary_text, ad.headline, ad.description, ad.destination_url, ad.url_params, ad.default_cta (SHOP_NOW)',
    '- adset_variants: an array of ad set names or objects with name/country/age_band/interests',
    'Rules: use "from" as a dot path into the source (use [] for the first item of an array, e.g. "adsets[].name"); use "value" with "from": null for a constant; map only what exists; never invent budgets or URLs. Put anything uncertain in notes.',
    '',
    'Source shape:',
    describeShape(raw),
  ].join('\n');
  const { output, writer } = await structuredRunWithFallback(preferred, { dir, prompt, schema: MAPPING_SCHEMA as unknown as Record<string, unknown> }, opts);
  const parsed = z.object({ mapping: z.array(z.object({ target: z.string(), from: z.string().nullable(), value: z.unknown().optional() })), notes: z.array(z.string()) }).parse(output);
  const mapping: Mapping = {};
  for (const m of parsed.mapping) {
    const rule: Mapping[string] = { from: m.from, ...(m.value !== undefined && m.value !== null ? { value: m.value } : {}) };
    if (m.target.endsWith('_minor')) {
      // Decide the unit once, from the sample and the field name, and keep it in the profile.
      const sample = m.from ? getPath(raw, m.from) : m.value;
      const looksMajor = (typeof sample === 'number' && !Number.isInteger(sample)) || /usd|dollar|eur|gbp|price|amount|budget(?!_minor)/i.test(m.from ?? '');
      rule.unit = looksMajor ? 'major' : 'minor';
    }
    mapping[m.target] = rule;
  }
  return { mapping, notes: parsed.notes, writer };
}

/**
 * Copy belongs to a product: the template's example copy is saved on the
 * product whose Shopify handle matches its destination URL, when that product is on the Line.
 * Returns the handle when no product matched, so the UI can offer a one-query pull.
 */
export function linkTemplateCopy(db: Db, t: Template): { linked: number | null; handle: string | null } {
  const handle = t.ad.destination_url.match(/\/products\/([^/?#]+)/)?.[1] ?? null;
  if (!handle) return { linked: null, handle: null };
  const product = db.select().from(products).where(eq(products.shopifyHandle, handle)).get();
  if (!product) return { linked: null, handle };
  const existing = db.select().from(productCopy).where(eq(productCopy.productId, product.id)).all();
  if (!existing.some((c) => c.bodyText === t.ad.primary_text && c.headline === t.ad.headline)) {
    db.insert(productCopy).values({ productId: product.id, bodyText: t.ad.primary_text, headline: t.ad.headline, description: t.ad.description || null, sourceTemplateId: t.id }).run();
  }
  return { linked: product.id, handle };
}
