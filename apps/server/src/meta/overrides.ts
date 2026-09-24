import { NO_OVERRIDES, type LaunchOverrides, type Template } from '@conveyor/shared';
import { fillPattern, todayTag } from './templates.ts';

/**
 * The launch settings. A template describes a way of running ads; the
 * handful of things that change every time — the campaign's name, when it starts, who it is
 * for and what it spends — are kept with the product and laid over the template here, so the
 * template file and the product's copy of it are left alone.
 *
 * `null` in a field means "as the template has it". For the two times, `''` means no time is
 * sent at all, so the ad sets run from the moment they are activated.
 */
export function applyOverrides(t: Template, o: LaunchOverrides): Template {
  const mode = t.campaign.budget.mode;
  const budget = o.budgetMinor;
  // A template that budgets over a lifetime keeps doing so; only the amount changes.
  const withAmount = <B extends { daily_budget_minor: number | null; lifetime_budget_minor: number | null }>(b: B, amount: number): B =>
    b.lifetime_budget_minor != null ? { ...b, lifetime_budget_minor: amount } : { ...b, daily_budget_minor: amount };

  const schedule = {
    ...t.adset.schedule,
    ...(o.startTime !== null ? { start_time: o.startTime || null } : {}),
    ...(o.endTime !== null ? { end_time: o.endTime || null } : {}),
  };
  const targeting = {
    ...t.adset.targeting,
    ...(o.countries ? { geo_locations: { ...t.adset.targeting.geo_locations, countries: o.countries } } : {}),
    ...(o.genders ? { genders: o.genders } : {}),
    ...(o.ageMin != null ? { age_min: o.ageMin } : {}),
    ...(o.ageMax != null ? { age_max: o.ageMax } : {}),
    ...(o.advantageAudience !== null ? { advantage_audience: o.advantageAudience } : {}),
  };
  // One budget for the launch means one budget for every ad set: a per-ad-set amount saved with
  // a board would otherwise quietly win over what was just typed.
  const extras =
    mode === 'ABO' && budget != null && t.x_conveyor?.variants
      ? { ...t.x_conveyor, variants: Object.fromEntries(Object.entries(t.x_conveyor.variants).map(([k, { budget: _perAdSet, ...rest }]) => [k, rest])) }
      : t.x_conveyor;

  return {
    ...t,
    campaign: {
      ...t.campaign,
      ...(o.campaignName ? { name_pattern: o.campaignName } : {}),
      budget: mode === 'CBO' && budget != null ? withAmount(t.campaign.budget, budget) : t.campaign.budget,
    },
    adset: {
      ...t.adset,
      budget: mode === 'ABO' && budget != null ? withAmount(t.adset.budget, budget) : t.adset.budget,
      schedule,
      targeting,
    },
    ...(extras ? { x_conveyor: extras } : {}),
  };
}

/**
 * The same fields as the template itself resolves them: what the Launch tab shows beside each
 * empty box, so the user can see what they are about to change before they change it.
 */
export function overrideDefaults(t: Template, now = new Date()): LaunchOverrides {
  const budget = t.campaign.budget.mode === 'CBO' ? t.campaign.budget : t.adset.budget;
  return {
    ...NO_OVERRIDES,
    campaignName: fillPattern(t.campaign.name_pattern, { date: todayTag(now), template: t.name, campaign: '' }),
    startTime: t.adset.schedule.start_time ?? '',
    endTime: t.adset.schedule.end_time ?? '',
    genders: t.adset.targeting.genders.filter((g): g is 1 | 2 => g === 1 || g === 2),
    ageMin: t.adset.targeting.age_min ?? 18,
    ageMax: t.adset.targeting.age_max ?? 65,
    countries: t.adset.targeting.geo_locations.countries,
    advantageAudience: t.adset.targeting.advantage_audience,
    budgetMinor: budget.lifetime_budget_minor ?? budget.daily_budget_minor,
  };
}
