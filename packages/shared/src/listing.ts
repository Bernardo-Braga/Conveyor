import { z } from 'zod';

/** Who writes the listing. Claude Code and Codex run locally on your own plans; the API key is optional. */
export const ListingWriterId = z.enum(['claude_code', 'codex', 'claude_api']);
export type ListingWriterId = z.infer<typeof ListingWriterId>;
export const WRITER_LABELS: Record<ListingWriterId, string> = {
  claude_code: 'Claude Code (your Claude plan)',
  codex: 'Codex (your ChatGPT plan)',
  claude_api: 'Claude API key',
};

/** The writer shows the model at most this many product photos, saved in the product's folder. */
export const MAX_PHOTOS = 4;

/** How many titles the store has already used are shown to the writer, so it does not name a product twice. */
export const HISTORY_TITLES = 40;

/**
 * The listing Claude writes, PLAN.md section 7. Validated strictly after the call.
 * Length limits are enforced client-side; a failure asks Claude once to fix its output.
 */
export const ListingDraft = z.object({
  title: z.string().min(3).max(70),
  descriptionHtml: z.string().min(20),
  highlights: z.array(z.string().min(3)).min(3).max(5),
  seo: z.object({ title: z.string().min(3).max(60), description: z.string().min(20).max(160) }),
  tags: z.array(z.string()).max(20),
  productType: z.string().min(2),
  /** "颜色" → "Color" */
  optionNames: z.record(z.string(), z.string()),
  /** "暖白" → "Warm white" */
  optionValues: z.record(z.string(), z.string()),
  /** Indexes into the source images: hero first, text banners dropped. */
  imageOrder: z.array(z.number().int().nonnegative()),
  /** Unconfirmed claims, shown as "verify in Shopify". */
  needsCheck: z.array(z.string()),
});
export type ListingDraft = z.infer<typeof ListingDraft>;

/**
 * The wire shape for structured output. Structured outputs forbid open records, so the
 * translation maps travel as pairs and are folded into records afterwards.
 */
export const ListingWire = z.object({
  title: z.string().max(70).describe('Product title, at most 70 characters, no supplier keyword stuffing'),
  descriptionHtml: z.string().describe('Product description as simple HTML: <p>, <ul>, <li>, <strong> only'),
  highlights: z.array(z.string()).min(3).max(5).describe('3 to 5 short benefit bullets'),
  seo: z.object({ title: z.string().max(60), description: z.string().max(160) }),
  tags: z.array(z.string()).max(20),
  productType: z.string(),
  optionNames: z.array(z.object({ from: z.string(), to: z.string() })).describe('Each source option name and its English translation'),
  optionValues: z.array(z.object({ from: z.string(), to: z.string() })).describe('Each source option value and its English translation'),
  imageOrder: z.array(z.number().int()).describe('Indexes of the source images to keep, hero first; drop text banners and size charts'),
  needsCheck: z.array(z.string()).describe('Claims you could not confirm from the supplier data'),
});
export type ListingWire = z.infer<typeof ListingWire>;

export function foldListing(w: ListingWire): ListingDraft {
  return ListingDraft.parse({
    ...w,
    optionNames: Object.fromEntries(w.optionNames.map((p) => [p.from, p.to])),
    optionValues: Object.fromEntries(w.optionValues.map((p) => [p.from, p.to])),
  });
}

/** Pricing result, all minor units of the store currency (USD). */
export const Pricing = z.object({
  costMinor: z.number().int(),
  landedCostMinor: z.number().int(),
  priceMinor: z.number().int(),
  compareAtMinor: z.number().int(),
  marginMinor: z.number().int(),
  /** How the landed cost was reached, for the UI. */
  notes: z.array(z.string()),
});
export type Pricing = z.infer<typeof Pricing>;

export const ListingJobInput = z.object({ productId: z.number().int(), rewrite: z.boolean().default(false) });
export type ListingJobInput = z.infer<typeof ListingJobInput>;

/**
 * The JSON Schema handed to the writers (`claude -p --json-schema`, `codex exec --output-schema`).
 * Generated from ListingWire so the schema and the Zod check can never drift apart.
 * Every reply is still validated with Zod: the schema is a hint, not a guarantee.
 */
export function listingJsonSchema(): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(ListingWire, { target: 'draft-2020-12', io: 'output' }) as Record<string, unknown>;
  // Claude Code 2.1.274 rejects a schema naming the 2020-12 dialect ("no schema with key or ref").
  // Only plain keywords are used, so the dialect line carries nothing.
  return schema;
}
