import { z } from 'zod';
import { Platform } from './product.ts';

/**
 * The normalised supplier product, PLAN.md section 6. Money is in minor units of `currency`
 * (cents for USD, fen for CNY); the plan's `cost` field is `costMinor` here for that reason.
 */
export const SourceProduct = z.object({
  source: z.object({ platform: Platform, itemId: z.string(), url: z.string() }),
  /** Original language. */
  title: z.string(),
  /** HTML stripped. */
  descriptionText: z.string(),
  descriptionImages: z.array(z.string()),
  /** Cleaned, full-size, de-duplicated. */
  images: z.array(z.string()),
  options: z.array(z.object({ name: z.string(), values: z.array(z.object({ label: z.string(), image: z.string().optional() })) })),
  variants: z.array(z.object({ optionValues: z.array(z.string()), costMinor: z.number().int().nonnegative(), stock: z.number().int().optional(), skuId: z.string().optional() })),
  currency: z.enum(['USD', 'CNY']),
  /** 1688 only. */
  priceTiers: z.array(z.object({ minQty: z.number().int().positive(), priceMinor: z.number().int().nonnegative() })).optional(),
  /** 1688 only: minimum order quantity. */
  moq: z.number().int().positive().optional(),
  /** Supplier-stated attributes (material, origin, fit). The listing step may use these and nothing else as facts. */
  attributes: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
});
export type SourceProduct = z.infer<typeof SourceProduct>;

export const ParsedLink = z.object({ platform: Platform, itemId: z.string() });
export type ParsedLink = z.infer<typeof ParsedLink>;

/** Last known RapidAPI quota per platform, read from response headers only. */
export const QuotaView = z.object({
  platform: Platform,
  remaining: z.number().int().nullable(),
  resetAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  threshold: z.number().int(),
  paused: z.boolean(),
});
export type QuotaView = z.infer<typeof QuotaView>;
