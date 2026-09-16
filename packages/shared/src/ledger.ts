import { z } from 'zod';

/** Outside services. Every request is attributed to exactly one. */
export const LedgerService = z.enum(['rapidapi', 'claude', 'openai', 'shopify', 'meta', 'cdn', 'other']);
export type LedgerService = z.infer<typeof LedgerService>;

/**
 * One row of the request ledger. Never contains headers, bodies or keys:
 * `url` is host + path only, with the query string removed.
 */
export const LedgerEntry = z.object({
  id: z.number().int(),
  at: z.string(),
  service: LedgerService,
  purpose: z.string(),
  productId: z.number().int().nullable(),
  jobId: z.number().int().nullable(),
  method: z.string(),
  url: z.string(),
  status: z.number().int().nullable(),
  ok: z.boolean(),
  durationMs: z.number().int(),
  quotaRemaining: z.number().int().nullable(),
  quotaResetAt: z.string().nullable(),
  requestId: z.string().nullable(),
  error: z.string().nullable(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const LedgerSummaryRow = z.object({
  day: z.string(),
  service: LedgerService,
  count: z.number().int(),
  failed: z.number().int(),
});
export type LedgerSummaryRow = z.infer<typeof LedgerSummaryRow>;
