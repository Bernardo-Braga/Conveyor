import { z } from 'zod';
import { ListingWriterId } from './listing.ts';

/** Non-secret identifiers each connection needs. Keys themselves live in the Keychain. */
export const ConnectionSettings = z.object({
  shopify: z.object({
    /** `my-store.myshopify.com` */
    storeDomain: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, 'Use the my-store.myshopify.com form')
      .or(z.literal(''))
      .default(''),
  }).prefault({}),
  meta: z.object({
    /** `act_123…` */
    adAccountId: z.string().trim().regex(/^(act_\d+)?$/, 'Use the act_123 form').default(''),
    pageId: z.string().trim().regex(/^\d*$/).default(''),
    instagramUserId: z.string().trim().regex(/^\d*$/).default(''),
    pixelId: z.string().trim().regex(/^\d*$/).default(''),
    /** Test ad account for phase 6, `act_…` */
    testAdAccountId: z.string().trim().regex(/^(act_\d+)?$/, 'Use the act_123 form').default(''),
  }).prefault({}),
});
export type ConnectionSettings = z.infer<typeof ConnectionSettings>;

/** Import settings, PLAN.md section 10. Money in minor units; the UI formats currency. */
export const ImportSettings = z.object({
  quotaPauseThreshold: z.number().int().min(0).default(50),
  pricing: z.object({
    multiplier: z.number().min(1).default(3.0),
    compareAtMarkupPercent: z.number().min(0).default(40),
    minimumMarginMinor: z.number().int().min(0).default(800),
    agentFeeMinor1688: z.number().int().min(0).default(250),
    shippingEstimateMinor: z.number().int().min(0).default(600),
    cnyRate: z.object({
      mode: z.enum(['fixed', 'daily']).default('fixed'),
      /** USD per CNY, as a decimal string to avoid float drift in storage. */
      fixed: z.string().regex(/^\d+(\.\d+)?$/).default('0.14'),
    }).prefault({}),
  }).prefault({}),
  listing: z.object({
    brandVoice: z.string().default(''),
    /** Default writer. A usage limit hands off to the other local writer. */
    writer: ListingWriterId.default('claude_code'),
    /** Show the writer up to MAX_PHOTOS product photos, downloaded once into the product's folder. */
    showPhotos: z.boolean().default(true),
    createAsDraft: z.literal(true).default(true),
    tag: z.string().default('conveyor'),
    includeDescriptionImages: z.boolean().default(false),
  }).prefault({}),
});
export type ImportSettings = z.infer<typeof ImportSettings>;

/** Every settings section has a name and a schema. Later phases add sections here. */
/** Internal: the daily CNY rate cache (one request per day). Not user-edited. */
export const RatesCache = z.object({
  usdPerCny: z.number().positive().nullable().default(null),
  fetchedOn: z.string().nullable().default(null),
});
export type RatesCache = z.infer<typeof RatesCache>;

export const SETTINGS_SECTIONS = {
  connections: ConnectionSettings,
  import: ImportSettings,
  rates: RatesCache,
} as const;
export type SettingsSection = keyof typeof SETTINGS_SECTIONS;
export const SettingsSection = z.enum(Object.keys(SETTINGS_SECTIONS) as [SettingsSection, ...SettingsSection[]]);

export type SettingsFor<S extends SettingsSection> = z.infer<(typeof SETTINGS_SECTIONS)[S]>;
