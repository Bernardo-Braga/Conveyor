import type { AdSetBudget, BudgetMode, LaunchAd, LaunchAdSet, Placements, Targeting, Template } from '@conveyor/shared';
import type { BatchOp } from './batch.ts';

/** A rule adjustment worth telling the user about. */
export interface PayloadNote {
  scope: 'campaign' | 'adset' | 'ad' | 'creative';
  index?: number;
  message: string;
}

export class PayloadRuleError extends Error {
  constructor(
    message: string,
    readonly op?: string,
  ) {
    super(message);
    this.name = 'PayloadRuleError';
  }
}

const NEEDS_BID = new Set(['LOWEST_COST_WITH_BID_CAP', 'COST_CAP']);
const NEEDS_ROAS = new Set(['LOWEST_COST_WITH_MIN_ROAS']);

/** Positions Meta removed: `video_feeds` in v24, `explore` in v26. */
export const REMOVED_FACEBOOK_POSITIONS = new Set(['video_feeds']);
export const REMOVED_INSTAGRAM_POSITIONS = new Set(['explore']);
/** The other tool writes `reels` for Facebook; the API name is `facebook_reels`. */
const FACEBOOK_POSITION_ALIASES: Record<string, string> = { reels: 'facebook_reels' };

type Budget = { daily_budget_minor: number | null; lifetime_budget_minor: number | null; bid_strategy: string; bid_amount_minor: number | null; roas_average_floor: number | null };

export function budgetFields(b: Budget): Record<string, unknown> {
  const out: Record<string, unknown> = b.lifetime_budget_minor != null ? { lifetime_budget: b.lifetime_budget_minor } : { daily_budget: b.daily_budget_minor };
  out.bid_strategy = b.bid_strategy;
  if (NEEDS_BID.has(b.bid_strategy)) {
    if (b.bid_amount_minor == null) throw new PayloadRuleError(`${b.bid_strategy} needs a bid amount`);
    out.bid_amount = b.bid_amount_minor;
  }
  if (NEEDS_ROAS.has(b.bid_strategy)) {
    if (b.roas_average_floor == null) throw new PayloadRuleError(`${b.bid_strategy} needs a ROAS floor`);
    out.bid_constraints = { roas_average_floor: b.roas_average_floor };
  }
  return out;
}

/**
 * Campaign (PLAN.md section 9.4).
 * CBO: the campaign carries the budget and bid strategy; no sharing field.
 * ABO: no budget, no bid strategy, and always `is_adset_budget_sharing_enabled: false`.
 */
export function campaignFields(t: Template, name: string): Record<string, unknown> {
  const b = t.campaign.budget;
  const base: Record<string, unknown> = {
    name,
    objective: t.campaign.objective,
    buying_type: t.campaign.buying_type,
    special_ad_categories: t.campaign.special_ad_categories,
    status: 'PAUSED',
  };
  if (b.spend_cap_minor != null) base.spend_cap = b.spend_cap_minor;
  if (b.mode === 'CBO') return { ...base, ...budgetFields(b) };
  return { ...base, is_adset_budget_sharing_enabled: false };
}

/** ABO: each ad set sends its own budget and bid strategy. CBO: nothing. */
export function adSetBudgetFields(mode: BudgetMode, budget: AdSetBudget, override: number | null): Record<string, unknown> {
  if (mode === 'CBO') return {};
  const b = override != null ? { ...budget, daily_budget_minor: budget.lifetime_budget_minor != null ? null : override, lifetime_budget_minor: budget.lifetime_budget_minor != null ? override : null } : budget;
  return budgetFields(b);
}

/** A past start becomes "start when launched"; a future one is kept; optionally keep the time of day. */
export function startTimeFields(schedule: { start_time: string | null; end_time: string | null }, now: Date, keepTimeOfDay: boolean, notes: PayloadNote[], index: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (schedule.start_time) {
    const start = new Date(schedule.start_time);
    if (start.getTime() > now.getTime()) out.start_time = Math.floor(start.getTime() / 1000);
    else if (keepTimeOfDay) {
      const next = new Date(now);
      next.setUTCHours(start.getUTCHours(), start.getUTCMinutes(), 0, 0);
      if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
      out.start_time = Math.floor(next.getTime() / 1000);
      notes.push({ scope: 'adset', index, message: `start_time ${schedule.start_time} is in the past; using the next ${start.toISOString().slice(11, 16)} UTC instead.` });
    } else notes.push({ scope: 'adset', index, message: `start_time ${schedule.start_time} is in the past; the ad set starts when activated.` });
  }
  if (schedule.end_time) out.end_time = Math.floor(new Date(schedule.end_time).getTime() / 1000);
  return out;
}

/** Advantage+ placements send no positions. Manual lists drop removed positions and map aliases. */
export function placementFields(p: Placements, notes: PayloadNote[], index: number): Record<string, unknown> {
  if (p.mode !== 'manual' || !p.manual) return {};
  const fb = p.manual.facebook_positions.map((x) => FACEBOOK_POSITION_ALIASES[x] ?? x);
  const fbDropped = fb.filter((x) => REMOVED_FACEBOOK_POSITIONS.has(x));
  const ig = p.manual.instagram_positions;
  const igDropped = ig.filter((x) => REMOVED_INSTAGRAM_POSITIONS.has(x));
  if (fbDropped.length) notes.push({ scope: 'adset', index, message: `Dropped Facebook positions removed by Meta: ${fbDropped.join(', ')}.` });
  if (igDropped.length) notes.push({ scope: 'adset', index, message: `Dropped Instagram positions removed by Meta: ${igDropped.join(', ')}.` });
  const out: Record<string, unknown> = {};
  if (p.manual.publisher_platforms.length) out.publisher_platforms = p.manual.publisher_platforms;
  const fbKept = [...new Set(fb.filter((x) => !REMOVED_FACEBOOK_POSITIONS.has(x)))];
  const igKept = ig.filter((x) => !REMOVED_INSTAGRAM_POSITIONS.has(x));
  if (fbKept.length) out.facebook_positions = fbKept;
  if (igKept.length) out.instagram_positions = igKept;
  if (p.manual.device_platforms.length) out.device_platforms = p.manual.device_platforms;
  return out;
}

export interface TargetingInput {
  base: Targeting;
  countryOverride: string | null;
  ageBand: [number, number] | null;
  interests: { id: string; name: string }[];
}

/**
 * Targeting (PLAN.md sections 9.2 and 9.4). `targeting_automation.advantage_audience` is always
 * explicit. When it is 1: `age_min` must be 18–25, `age_max` is not sent, a narrower band goes as
 * an `age_range` suggestion, and gender is a suggestion (flagged, still sent). Empty flexible_spec
 * groups are removed.
 */
export function targetingFields(input: TargetingInput, notes: PayloadNote[], index: number): Record<string, unknown> {
  const t = input.base;
  const { placements: _p, advantage_audience, flexible_spec, geo_locations, age_min, age_max, genders, ...rest } = t;
  const out: Record<string, unknown> = { ...rest };
  const geo = { ...geo_locations };
  if (input.countryOverride) {
    geo.countries = [input.countryOverride];
    notes.push({ scope: 'adset', index, message: `Country ${input.countryOverride} from the variant overrides the template's countries.` });
  }
  out.geo_locations = geo;
  if (!Object.keys(t.excluded_geo_locations ?? {}).length) delete out.excluded_geo_locations;
  if (!Object.keys(t.exclusions ?? {}).length) delete out.exclusions;
  for (const k of ['locales', 'custom_audiences', 'excluded_custom_audiences'] as const) if (!(t[k] ?? []).length) delete out[k];

  const specs = (flexible_spec ?? []).map((g) => Object.fromEntries(Object.entries(g).filter(([, v]) => !(Array.isArray(v) && v.length === 0)))).filter((g) => Object.keys(g).length);
  if (input.interests.length) specs.push({ interests: input.interests.map((i) => ({ id: i.id, name: i.name })) });
  if (specs.length) out.flexible_spec = specs;

  const adv = advantage_audience ? 1 : 0;
  out.targeting_automation = { advantage_audience: adv };
  const min = input.ageBand?.[0] ?? age_min ?? 18;
  const max = input.ageBand?.[1] ?? age_max ?? 65;
  if (adv === 1) {
    const clampedMin = Math.min(Math.max(min, 18), 25);
    out.age_min = clampedMin;
    if (min > 25) notes.push({ scope: 'adset', index, message: `age_min ${min} is above 25; with Advantage+ audience on it is sent as 25 and ${min}–${max} goes as a suggestion.` });
    if (min !== 18 || max !== 65) out.age_range = [min, max];
    if (genders?.length) notes.push({ scope: 'adset', index, message: `Gender ${genders.join(',')} is only a suggestion while Advantage+ audience is on. A firm limit needs it off in the template.` });
  } else {
    out.age_min = min;
    out.age_max = max;
  }
  if (genders?.length) out.genders = genders;
  Object.assign(out, placementFields(t.placements, notes, index));
  return out;
}

export interface AdSetContext {
  template: Template;
  set: LaunchAdSet;
  campaignRef: string;
  pixelId: string | null;
  now: Date;
  keepTimeOfDay: boolean;
  notes: PayloadNote[];
}

export function adSetFields(c: AdSetContext): Record<string, unknown> {
  const t = c.template;
  const d = t.adset;
  const promoted: Record<string, unknown> = { ...d.promoted_object };
  if (c.pixelId) promoted.pixel_id = c.pixelId;
  const out: Record<string, unknown> = {
    name: c.set.name,
    campaign_id: c.campaignRef,
    status: 'PAUSED',
    billing_event: d.billing_event,
    optimization_goal: d.optimization_goal,
    destination_type: d.destination_type,
    promoted_object: promoted,
    attribution_spec: d.attribution_spec,
    targeting: targetingFields({ base: d.targeting, countryOverride: c.set.countryOverride, ageBand: c.set.ageBand, interests: c.set.interests }, c.notes, c.set.index),
    ...startTimeFields(d.schedule, c.now, c.keepTimeOfDay, c.notes, c.set.index),
    ...adSetBudgetFields(t.campaign.budget.mode, d.budget, c.set.budgetMinor),
  };
  if (d.schedule.dayparting) c.notes.push({ scope: 'adset', index: c.set.index, message: 'Dayparting in the template is not sent; set it in Ads Manager if needed.' });
  return out;
}

export function creativeFields(ad: LaunchAd, pageId: string, instagramUserId: string | null, imageHash: string, urlParams: string, cta: string, enhancements: boolean): Record<string, unknown> {
  const linkData: Record<string, unknown> = { image_hash: imageHash, link: ad.destinationUrl, message: ad.primaryText, name: ad.headline, call_to_action: { type: cta, value: { link: ad.destinationUrl } } };
  if (ad.description) linkData.description = ad.description;
  const spec: Record<string, unknown> = { page_id: pageId, link_data: linkData };
  if (instagramUserId) spec.instagram_user_id = instagramUserId;
  const out: Record<string, unknown> = { name: ad.fileName, object_story_spec: spec, url_tags: urlParams };
  // Keeps Meta's creative enhancements off (advantage_creative_enhancements: false in the template).
  if (!enhancements) out.degrees_of_freedom_spec = { creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_OUT' } } };
  return out;
}

export function adFields(name: string, adSetRef: string, creativeRef: string): Record<string, unknown> {
  return { name, adset_id: adSetRef, creative: { creative_id: creativeRef }, status: 'PAUSED' };
}

/**
 * The last lock before anything is sent (CLAUDE.md hard rule 6). Throws on any payload that
 * breaks the budget-mode, sharing, status, Advantage+ audience or placement rules.
 */
export function assertPayloadRules(ops: BatchOp[], mode: BudgetMode): void {
  for (const op of ops) {
    if (op.method !== 'POST' || !op.body) continue;
    const b = op.body;
    const url = op.relative_url;
    const kind = /\/campaigns$/.test(url) ? 'campaign' : /\/adsets$/.test(url) ? 'adset' : /\/adcreatives$/.test(url) ? 'creative' : /\/ads$/.test(url) ? 'ad' : /\/adimages$/.test(url) ? 'image' : 'other';
    if (kind === 'other' || kind === 'image') continue;
    if (kind !== 'creative' && b.status !== 'PAUSED') throw new PayloadRuleError(`${kind} ${op.name ?? ''} is not PAUSED`, op.name);
    if (b.is_adset_budget_sharing_enabled === true) throw new PayloadRuleError('Ad set budget sharing must never be true', op.name);
    if (kind === 'campaign') {
      if (mode === 'ABO') {
        if (b.is_adset_budget_sharing_enabled !== false) throw new PayloadRuleError('ABO campaign must send is_adset_budget_sharing_enabled: false', op.name);
        if ('daily_budget' in b || 'lifetime_budget' in b || 'bid_strategy' in b) throw new PayloadRuleError('ABO campaign must not carry a budget or bid strategy', op.name);
      } else {
        if (!('daily_budget' in b || 'lifetime_budget' in b)) throw new PayloadRuleError('CBO campaign must carry a budget', op.name);
        if (!('bid_strategy' in b)) throw new PayloadRuleError('CBO campaign must carry a bid strategy', op.name);
        if ('is_adset_budget_sharing_enabled' in b) throw new PayloadRuleError('CBO campaign must not send the sharing field', op.name);
      }
    }
    if (kind === 'adset') {
      const hasBudget = 'daily_budget' in b || 'lifetime_budget' in b;
      if (mode === 'ABO' && !hasBudget) throw new PayloadRuleError(`ABO ad set ${b.name} has no budget`, op.name);
      if (mode === 'ABO' && !('bid_strategy' in b)) throw new PayloadRuleError(`ABO ad set ${b.name} has no bid strategy`, op.name);
      if (mode === 'CBO' && hasBudget) throw new PayloadRuleError(`CBO ad set ${b.name} must not carry a budget`, op.name);
      const tg = b.targeting as Record<string, unknown> | undefined;
      if (!tg) throw new PayloadRuleError(`ad set ${b.name} has no targeting`, op.name);
      const ta = tg.targeting_automation as { advantage_audience?: number } | undefined;
      if (!ta || (ta.advantage_audience !== 0 && ta.advantage_audience !== 1)) throw new PayloadRuleError(`ad set ${b.name}: advantage_audience must be explicit`, op.name);
      if (ta.advantage_audience === 1) {
        const min = tg.age_min as number | undefined;
        if (min == null || min < 18 || min > 25) throw new PayloadRuleError(`ad set ${b.name}: age_min must be 18–25 with Advantage+ audience`, op.name);
        if ('age_max' in tg) throw new PayloadRuleError(`ad set ${b.name}: age_max must not be sent with Advantage+ audience`, op.name);
      }
      const fb = (tg.facebook_positions as string[] | undefined) ?? [];
      const ig = (tg.instagram_positions as string[] | undefined) ?? [];
      if (fb.some((x) => REMOVED_FACEBOOK_POSITIONS.has(x)) || ig.some((x) => REMOVED_INSTAGRAM_POSITIONS.has(x))) throw new PayloadRuleError(`ad set ${b.name} sends a removed placement`, op.name);
      const specs = (tg.flexible_spec as Record<string, unknown>[] | undefined) ?? [];
      if (specs.some((g) => !Object.keys(g).length)) throw new PayloadRuleError(`ad set ${b.name} sends an empty flexible_spec group`, op.name);
    }
  }
}
