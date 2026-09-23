import { z } from 'zod';
import { Aspect, CreativeView } from './creatives.ts';

/** Money in minor units, as the other tool exports it. */
const Minor = z.number().int().nullable();

export const BudgetMode = z.enum(['CBO', 'ABO']);
export type BudgetMode = z.infer<typeof BudgetMode>;

export const CampaignBudget = z
  .object({
    mode: BudgetMode,
    daily_budget_minor: Minor,
    lifetime_budget_minor: Minor,
    bid_strategy: z.string(),
    bid_amount_minor: Minor,
    roas_average_floor: z.number().nullable(),
    spend_cap_minor: Minor,
  })
  .passthrough();

export const AdSetBudget = z
  .object({
    daily_budget_minor: Minor,
    lifetime_budget_minor: Minor,
    bid_strategy: z.string(),
    bid_amount_minor: Minor,
    roas_average_floor: z.number().nullable(),
  })
  .passthrough();
export type AdSetBudget = z.infer<typeof AdSetBudget>;

export const InterestRef = z.object({ id: z.string(), name: z.string() }).passthrough();
export type InterestRef = z.infer<typeof InterestRef>;

export const Placements = z
  .object({
    mode: z.enum(['advantage', 'manual']),
    manual: z
      .object({
        publisher_platforms: z.array(z.string()).default([]),
        facebook_positions: z.array(z.string()).default([]),
        instagram_positions: z.array(z.string()).default([]),
        device_platforms: z.array(z.string()).default([]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type Placements = z.infer<typeof Placements>;

export const Targeting = z
  .object({
    geo_locations: z.object({ countries: z.array(z.string()).default([]) }).passthrough(),
    excluded_geo_locations: z.record(z.string(), z.unknown()).default({}),
    age_min: z.number().int().nullable().default(null),
    age_max: z.number().int().nullable().default(null),
    genders: z.array(z.number().int()).default([]),
    locales: z.array(z.union([z.number(), z.string()])).default([]),
    flexible_spec: z.array(z.record(z.string(), z.unknown())).default([]),
    exclusions: z.record(z.string(), z.unknown()).default({}),
    custom_audiences: z.array(z.unknown()).default([]),
    excluded_custom_audiences: z.array(z.unknown()).default([]),
    advantage_audience: z.boolean().default(false),
    placements: Placements,
  })
  .passthrough();
export type Targeting = z.infer<typeof Targeting>;

export const AdSetDefaults = z
  .object({
    name_pattern: z.string(),
    budget: AdSetBudget,
    billing_event: z.string(),
    optimization_goal: z.string(),
    destination_type: z.string(),
    schedule: z.object({ start_time: z.string().nullable(), end_time: z.string().nullable(), dayparting: z.unknown().nullable() }).passthrough(),
    promoted_object: z.object({ pixel_id: z.string().nullable().optional(), custom_event_type: z.string().nullable().optional() }).passthrough(),
    attribution_spec: z.array(z.object({ event_type: z.string(), window_days: z.number().int() }).passthrough()).default([]),
    targeting: Targeting,
  })
  .passthrough();

export const AdDefaults = z
  .object({
    name_pattern: z.string(),
    format: z.string(),
    creatives_per_ad: z.number().int(),
    distribution_mode: z.string(),
    page_id: z.string().nullable(),
    instagram_user_id: z.string().nullable(),
    default_cta: z.string(),
    primary_text: z.string(),
    headline: z.string(),
    description: z.string(),
    destination_url: z.string(),
    url_params: z.string(),
    advantage_creative_enhancements: z.boolean().default(false),
    status_default: z.string(),
  })
  .passthrough();

export const Variant = z
  .object({
    name: z.string(),
    country: z.string().default(''),
    age_band: z.string().default(''),
    interests: z.array(InterestRef).default([]),
    custom_audiences: z.array(z.unknown()).default([]),
  })
  .passthrough();
export type Variant = z.infer<typeof Variant>;

export const FillRule = z.enum(['one_per_ad', 'rotate', 'one_per_adset', 'by_format', 'manual']);
export type FillRule = z.infer<typeof FillRule>;

/** Conveyor-only data, kept under `x_conveyor` and dropped by "Export for my other tool". */
export const ConveyorExtras = z
  .object({
    variants: z.record(z.string(), z.object({ budget: AdSetBudget.optional(), placements: Placements.optional(), formats: z.array(Aspect).optional() }).passthrough()).optional(),
    fillRule: FillRule.optional(),
    productLinks: z.object({ handle: z.string().optional(), productId: z.number().int().optional() }).optional(),
    notes: z.array(z.string()).optional(),
  })
  .passthrough();

/** The other tool's template, exactly as exported (PLAN.md section 9.1). Unknown fields pass through. */
export const Template = z
  .object({
    id: z.string(),
    name: z.string().transform((n) => n.trim()),
    version: z.number().int(),
    campaign: z
      .object({
        objective: z.string(),
        buying_type: z.string(),
        special_ad_categories: z.array(z.string()),
        name_pattern: z.string(),
        budget: CampaignBudget,
        status_default: z.string(),
      })
      .passthrough(),
    adset_count: z.number().int().min(1),
    adset: AdSetDefaults,
    ads_per_adset: z.number().int().min(1),
    ad: AdDefaults,
    adset_variants: z.array(Variant),
    x_conveyor: ConveyorExtras.optional(),
  })
  .passthrough();
export type Template = z.infer<typeof Template>;

export const TemplateView = z.object({
  id: z.number().int(),
  templateId: z.string(),
  name: z.string(),
  version: z.number().int(),
  mode: BudgetMode,
  adSetCount: z.number().int(),
  adsPerAdSet: z.number().int(),
  variantNames: z.array(z.string()),
  source: z.string(),
  isDefault: z.boolean(),
  /** The JSON file in the templates folder this template mirrors. */
  fileName: z.string().nullable(),
  filePath: z.string().nullable(),
  /** The file was removed from the folder; the stored copy is still usable. */
  fileMissing: z.boolean(),
  campaignBudgetMinor: z.number().int().nullable(),
  adSetBudgetMinor: z.number().int().nullable(),
  objective: z.string(),
  updatedAt: z.string(),
});

/** Saving from the Templates tab: the whole template JSON, validated, written back to its file. */
export const TemplateSave = z.object({ json: z.record(z.string(), z.unknown()) });
export const TemplateDuplicate = z.object({ name: z.string().trim().min(1).max(80).optional() });
export const TemplateFolder = z.object({ dir: z.string(), files: z.number().int() });
export type TemplateView = z.infer<typeof TemplateView>;

/** What an ad set name says about its interest (PLAN.md section 9.3). */
export const InterestKind = z.enum(['none', 'broad', 'placeholder', 'lookup', 'file', 'picked', 'unmatched']);
export type InterestKind = z.infer<typeof InterestKind>;

export const LaunchAd = z.object({
  creativeId: z.number().int(),
  fileName: z.string(),
  primaryText: z.string(),
  headline: z.string(),
  description: z.string(),
  destinationUrl: z.string(),
});
export type LaunchAd = z.infer<typeof LaunchAd>;

export const LaunchAdSet = z.object({
  index: z.number().int(),
  name: z.string(),
  /** ABO only; null under CBO. */
  budgetMinor: z.number().int().nullable(),
  interestKind: InterestKind,
  interestLabel: z.string().nullable(),
  interests: z.array(InterestRef),
  suggestions: z.array(InterestRef),
  countryOverride: z.string().nullable(),
  ageBand: z.tuple([z.number().int(), z.number().int()]).nullable(),
  ads: z.array(LaunchAd),
});
export type LaunchAdSet = z.infer<typeof LaunchAdSet>;

export const LaunchStructure = z.object({ campaignName: z.string(), adSets: z.array(LaunchAdSet) });
export type LaunchStructure = z.infer<typeof LaunchStructure>;

export const PreflightCheck = z.object({
  id: z.string(),
  level: z.enum(['block', 'warn', 'info']),
  message: z.string(),
  /** Warnings the user may acknowledge to launch anyway. */
  acknowledgeable: z.boolean().default(false),
});
export type PreflightCheck = z.infer<typeof PreflightCheck>;

export const LaunchPreview = z.object({
  productId: z.number().int(),
  templateId: z.number().int(),
  mode: BudgetMode,
  structure: LaunchStructure,
  operations: z.number().int(),
  imageUploads: z.number().int(),
  /** Requests the launch will make: 1 upload batch if any image is new, plus 1 object batch per 50 operations, plus a snapshot if stale. */
  requests: z.number().int(),
  checks: z.array(PreflightCheck),
  /** When the product was last read back from Shopify, and whether that read is still fresh (under 10 minutes). */
  snapshotAt: z.string().nullable(),
  snapshotFresh: z.boolean(),
  canLaunch: z.boolean(),
  notes: z.array(z.string()),
});
export type LaunchPreview = z.infer<typeof LaunchPreview>;

/**
 * The few settings that change with every launch (PLAN.md section 9.5a): the campaign's name,
 * when it starts and ends, who it targets and what it spends. They are kept with the product's
 * launch plan rather than in the template, and are laid over the template when the launch is
 * built, so the same template can run a hundred products without ever being edited.
 *
 * `null` always means "as the template has it". For the two times, `''` means the opposite of
 * a time: no start or end is sent, so the ad sets run from the moment they are activated.
 */
const IsoOrBlank = z
  .string()
  .refine((v) => v === '' || !Number.isNaN(Date.parse(v)), 'Use an ISO time, or "" for no time at all')
  .nullable()
  .default(null);

export const LaunchOverrides = z
  .object({
    /** The campaign name itself, not a pattern: what the user typed over the filled-in name. */
    campaignName: z.string().trim().max(400).nullable().default(null),
    startTime: IsoOrBlank,
    endTime: IsoOrBlank,
    /** `[]` everyone, `[1]` men, `[2]` women. */
    genders: z.array(z.union([z.literal(1), z.literal(2)])).max(2).nullable().default(null),
    ageMin: z.number().int().min(13).max(65).nullable().default(null),
    ageMax: z.number().int().min(13).max(65).nullable().default(null),
    countries: z.array(z.string().trim().length(2).toUpperCase()).max(25).nullable().default(null),
    /** Off turns the gender and age above into firm limits rather than suggestions. */
    advantageAudience: z.boolean().nullable().default(null),
    /** The campaign's budget under CBO, every ad set's under ABO; lifetime when the template uses one. */
    budgetMinor: z.number().int().positive().nullable().default(null),
  })
  .refine((o) => o.ageMin == null || o.ageMax == null || o.ageMin <= o.ageMax, { message: 'The minimum age is above the maximum.', path: ['ageMin'] });
export type LaunchOverrides = z.infer<typeof LaunchOverrides>;

/** Nothing overridden: every field as the template has it. */
export const NO_OVERRIDES: LaunchOverrides = LaunchOverrides.parse({});

/** Which fields this launch sets for itself, in the words the Launch tab uses. */
export const OVERRIDE_LABELS: Record<keyof LaunchOverrides, string> = {
  campaignName: 'campaign name',
  startTime: 'start',
  endTime: 'end',
  genders: 'gender',
  ageMin: 'minimum age',
  ageMax: 'maximum age',
  countries: 'countries',
  advantageAudience: 'Advantage+ audience',
  budgetMinor: 'budget',
};

export function overriddenFields(o: LaunchOverrides): string[] {
  return (Object.keys(OVERRIDE_LABELS) as (keyof LaunchOverrides)[]).filter((k) => o[k] !== null).map((k) => OVERRIDE_LABELS[k]);
}

/** The Launch view's editable plan for one product: its own template copy and its chosen creatives. */
export const LaunchPlanView = z.object({
  productId: z.number().int(),
  templateId: z.number().int(),
  templateName: z.string(),
  /** The template as it will be launched, before this launch's own settings are laid over it. */
  template: z.record(z.string(), z.unknown()),
  /** True when this product has its own copy, so "revert to the template" is worth offering. */
  edited: z.boolean(),
  /** What this launch sets for itself; `null` fields follow the template. */
  overrides: LaunchOverrides,
  /** The same fields as the template resolves them, for the placeholders beside each box. */
  defaults: LaunchOverrides,
  updatedAt: z.string().nullable(),
  /** Every finished creative, with the chosen ones marked and ordered first. */
  creatives: z.array(CreativeView),
  creativeIds: z.array(z.number().int()),
  /** How many different creatives the fill rule consumes; the same set in every ad set needs one ad set's worth. */
  slots: z.number().int(),
  fillRule: FillRule,
});
export type LaunchPlanView = z.infer<typeof LaunchPlanView>;

/** A save of one part of the plan: anything left out is kept as it is. */
export const LaunchPlanSave = z.object({
  templateId: z.number().int(),
  template: z.record(z.string(), z.unknown()).nullable().default(null),
  creativeIds: z.array(z.number().int()).nullable().default(null),
  overrides: LaunchOverrides.nullable().default(null),
});
export type LaunchPlanSave = z.infer<typeof LaunchPlanSave>;

export const LaunchInput = z.object({
  productId: z.number().int(),
  templateId: z.number().int(),
  /** IDs of acknowledgeable warnings the user accepted. */
  acknowledge: z.array(z.string()).default([]),
  /** A board-edited structure; when absent the structure is built from the template and the fill rule. */
  structure: LaunchStructure.nullable().default(null),
});
export type LaunchInput = z.infer<typeof LaunchInput>;

/** "Save this board as a template": a new template file with the board's shape under x_conveyor. */
export const BoardSaveInput = z.object({ templateId: z.number().int(), name: z.string().trim().min(1).max(80), structure: LaunchStructure });

/** What the importer answers (PLAN.md section 9.2). */
export const ImportOutcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('imported'), format: z.enum(['template', 'graph', 'profile']), template: TemplateView, notes: z.array(z.string()) }),
  z.object({
    kind: z.literal('proposal'),
    signature: z.string(),
    mapping: z.record(z.string(), z.object({ from: z.string().nullable(), value: z.unknown().optional(), unit: z.enum(['major', 'minor']).optional() })),
    /** The template the mapping would produce, for the user to check before confirming. */
    preview: z.record(z.string(), z.unknown()),
    problems: z.array(z.string()),
    writer: z.string(),
  }),
  z.object({ kind: z.literal('unsupported'), message: z.string() }),
]);
export type ImportOutcome = z.infer<typeof ImportOutcome>;
export const ImportConfirm = z.object({ signature: z.string(), mapping: z.record(z.string(), z.object({ from: z.string().nullable(), value: z.unknown().optional(), unit: z.enum(['major', 'minor']).optional() })), raw: z.record(z.string(), z.unknown()) });

/** Live campaign state as read from Meta in one request (PLAN.md section 9.7). */
export const LiveAd = z.object({ id: z.string(), name: z.string(), status: z.string(), creativeId: z.string().nullable() });
export const LiveAdSet = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  dailyBudgetMinor: z.number().int().nullable(),
  lifetimeBudgetMinor: z.number().int().nullable(),
  interests: z.array(InterestRef),
  ads: z.array(LiveAd),
});
export const LiveCampaign = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  effectiveStatus: z.string().nullable(),
  dailyBudgetMinor: z.number().int().nullable(),
  lifetimeBudgetMinor: z.number().int().nullable(),
  adSets: z.array(LiveAdSet),
  readAt: z.string(),
});
export type LiveCampaign = z.infer<typeof LiveCampaign>;

export const LiveChange = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rename_campaign'), name: z.string().min(1) }),
  z.object({ type: z.literal('campaign_status'), status: z.enum(['ACTIVE', 'PAUSED']) }),
  z.object({ type: z.literal('campaign_budget'), dailyBudgetMinor: z.number().int().positive() }),
  z.object({ type: z.literal('adset_status'), adSetId: z.string(), status: z.enum(['ACTIVE', 'PAUSED']) }),
  z.object({ type: z.literal('adset_budget'), adSetId: z.string(), dailyBudgetMinor: z.number().int().positive() }),
  z.object({ type: z.literal('rename_adset'), adSetId: z.string(), name: z.string().min(1) }),
  z.object({ type: z.literal('adset_interests'), adSetId: z.string(), interests: z.array(InterestRef) }),
  z.object({ type: z.literal('ad_status'), adId: z.string(), status: z.enum(['ACTIVE', 'PAUSED']) }),
  z.object({ type: z.literal('add_adset'), adSet: LaunchAdSet }),
  z.object({ type: z.literal('add_ad'), adSetId: z.string(), ad: LaunchAd }),
  z.object({ type: z.literal('replace_ad_creative'), adId: z.string(), ad: LaunchAd }),
]);
export type LiveChange = z.infer<typeof LiveChange>;

export const ApplyEditsInput = z.object({
  campaignId: z.number().int(),
  changes: z.array(LiveChange).min(1),
  /** The `readAt` of the state the user saw; a newer read stops the apply and shows the differences. */
  basedOn: z.string(),
  acknowledgeLearning: z.boolean().default(false),
});
export type ApplyEditsInput = z.infer<typeof ApplyEditsInput>;

export const LiveDiff = z.object({ path: z.string(), before: z.unknown(), after: z.unknown() });
export type LiveDiff = z.infer<typeof LiveDiff>;

export const CampaignStatus = z.enum(['draft', 'launching', 'paused', 'active', 'failed']);
export const AdView = z.object({ id: z.number().int(), name: z.string(), creativeId: z.number().int().nullable(), metaAdId: z.string().nullable(), metaCreativeId: z.string().nullable(), status: z.string(), insights: z.record(z.string(), z.unknown()).nullable() });
export const AdSetView = z.object({ id: z.number().int(), name: z.string(), budgetMinor: z.number().int().nullable(), interests: z.array(InterestRef), metaId: z.string().nullable(), status: z.string(), ads: z.array(AdView) });
export const CampaignView = z.object({
  id: z.number().int(),
  productId: z.number().int(),
  name: z.string(),
  mode: BudgetMode,
  status: CampaignStatus,
  metaCampaignId: z.string().nullable(),
  adSets: z.array(AdSetView),
  operations: z.number().int(),
  completed: z.number().int(),
  lastError: z.string().nullable(),
  lastReadAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CampaignView = z.infer<typeof CampaignView>;

export const InterestPick = z.object({ label: z.string().min(1), interest: InterestRef });

/** Ad setup settings, the Conveyor-side defaults around a template (PLAN.md section 10). */
export const AdSetupSettings = z.object({
  defaultTemplateId: z.number().int().nullable().default(null),
  fillRule: FillRule.default('one_per_ad'),
  /** A past start_time becomes "start when launched"; with this on, the time of day is kept and the next occurrence used. */
  keepTimeOfDay: z.boolean().default(false),
  readInterestsFromNames: z.boolean().default(true),
  /** Always on: every object is created PAUSED. Activation is a separate user action. */
  createPaused: z.literal(true).default(true),
  urlParams: z.string().default('utm_source=meta&utm_campaign={{campaign}}'),
});
export type AdSetupSettings = z.infer<typeof AdSetupSettings>;
