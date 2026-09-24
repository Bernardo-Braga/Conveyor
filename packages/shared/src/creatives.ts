import { z } from 'zod';

/** Meta placements Conveyor produces. */
export const Aspect = z.enum(['1:1', '4:5', '9:16']);
export type Aspect = z.infer<typeof Aspect>;
export const ASPECTS = Aspect.options;

/** Finished size per aspect. */
export const META_SIZE: Record<Aspect, readonly [number, number]> = { '1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920] };
/** Generation size: edges must be multiples of 16, slightly larger than the finished frame so the crop has room. */
export const GEN_SIZE: Record<Aspect, readonly [number, number]> = { '1:1': [1088, 1088], '4:5': [1088, 1360], '9:16': [1088, 1936] };
/** File-name tag: `{handle}_{4x5}_{NN}.jpg`. */
export const ASPECT_TAG: Record<Aspect, string> = { '1:1': '1x1', '4:5': '4x5', '9:16': '9x16' };
export const ASPECT_LABEL: Record<Aspect, string> = { '1:1': 'Square 1:1', '4:5': 'Feed 4:5', '9:16': 'Reels and Stories 9:16' };

export const ImageEngineId = z.enum(['codex', 'openai']);
export type ImageEngineId = z.infer<typeof ImageEngineId>;

/**
 * Where a batch's images came from: an engine, or the product's own Shopify photos. A Shopify
 * photo is finished into the same 1:1 JPEG as a generated image, so everything downstream —
 * approval, the launch plan, preflight, the Meta upload — treats the two the same.
 */
export const BatchOrigin = z.enum(['codex', 'openai', 'shopify']);
export type BatchOrigin = z.infer<typeof BatchOrigin>;
export const ORIGIN_LABEL: Record<BatchOrigin, string> = { codex: 'Codex', openai: 'OpenAI', shopify: 'Shopify photos' };

export const CreativeStatus = z.enum(['pending', 'generating', 'finished', 'failed']);
export type CreativeStatus = z.infer<typeof CreativeStatus>;
export const Approval = z.enum(['pending', 'approved', 'rejected']);
export type Approval = z.infer<typeof Approval>;
export const BatchStatus = z.enum(['queued', 'running', 'handoff', 'done', 'partial', 'failed', 'cancelled']);
export type BatchStatus = z.infer<typeof BatchStatus>;

export const CreativeView = z.object({
  id: z.number().int(),
  batchId: z.number().int(),
  productId: z.number().int(),
  aspect: Aspect,
  /** Product-wide number per aspect; also the NN in the file name. */
  slot: z.number().int(),
  status: CreativeStatus,
  approval: Approval,
  fileName: z.string().nullable(),
  /** Local API paths the gallery loads. Never a file-system path. */
  finishedUrl: z.string().nullable(),
  originalUrl: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  bytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  detectedFormat: z.string().nullable(),
  /** "clean" when sharp and exiftool both saw no metadata, else the reason. */
  metadataCheck: z.string().nullable(),
  flags: z.array(z.string()),
  error: z.string().nullable(),
  /** Set once the finished file is on the Shopify product as a media item. */
  shopifyMediaId: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type CreativeView = z.infer<typeof CreativeView>;

export const BatchView = z.object({
  id: z.number().int(),
  productId: z.number().int(),
  handle: z.string().nullable(),
  engine: BatchOrigin,
  status: BatchStatus,
  prompt: z.string(),
  formats: z.array(Aspect),
  countPerFormat: z.number().int(),
  total: z.number().int(),
  finished: z.number().int(),
  failed: z.number().int(),
  pending: z.number().int(),
  /** Outside API requests the batch made (the snapshot, plus the OpenAI backup's calls). */
  apiRequests: z.number().int(),
  /** Set when the batch was handed off or stopped early. */
  note: z.string().nullable(),
  /** For a regenerate or edit batch: the creative it replaces. */
  replacesCreativeId: z.number().int().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  creatives: z.array(CreativeView),
});
export type BatchView = z.infer<typeof BatchView>;

export const GenerateBatchInput = z.object({
  productId: z.number().int(),
  promptTemplateId: z.number().int().nullable().default(null),
  formats: z.array(Aspect).min(1).optional(),
  countPerFormat: z.number().int().min(1).max(12).optional(),
  engine: ImageEngineId.optional(),
  /** Custom prompt variables such as scene or audience. */
  variables: z.record(z.string(), z.string()).default({}),
  /** `R` (regenerate one) and `E` (edit one): a single-slot batch for that creative's aspect. */
  regenerate: z.object({ creativeId: z.number().int(), instruction: z.string().max(2000).nullable().default(null) }).nullable().default(null),
});
export type GenerateBatchInput = z.infer<typeof GenerateBatchInput>;

export const ReferenceRule = z.enum(['first_3_shopify_images', 'first_shopify_image', 'none']);
export type ReferenceRule = z.infer<typeof ReferenceRule>;

export const PromptTemplateView = z.object({
  id: z.number().int(),
  name: z.string(),
  version: z.number().int(),
  body: z.string(),
  variables: z.array(z.string()),
  formats: z.array(Aspect),
  countPerFormat: z.number().int(),
  referenceRule: ReferenceRule,
  isDefault: z.boolean(),
  createdAt: z.string(),
});
export type PromptTemplateView = z.infer<typeof PromptTemplateView>;

export const PromptTemplateInput = z.object({
  name: z.string().trim().min(1).max(80),
  body: z.string().min(10).max(6000),
  formats: z.array(Aspect).min(1).default(['1:1', '4:5', '9:16']),
  countPerFormat: z.number().int().min(1).max(12).default(4),
  referenceRule: ReferenceRule.default('first_3_shopify_images'),
  isDefault: z.boolean().default(false),
});
export type PromptTemplateInput = z.infer<typeof PromptTemplateInput>;

/** Built-in variables every template can use. Custom ones are anything else in `{{…}}`. */
export const BUILTIN_PROMPT_VARIABLES = ['title', 'highlight_1', 'highlight_2', 'highlight_3', 'price', 'brand', 'product_type', 'aspect'] as const;

/** Every template must carry these instructions. Appended automatically. */
export const PROMPT_FIXED_RULES =
  'Match the reference images exactly: the same product, colours, materials, proportions and details. Do not alter, restyle or add features to the product. No text, no logos, no watermarks, no captions, no borders.';
export const PROMPT_9x16_RULE = 'For 9:16 keep the top 14% and the bottom 35% of the frame clear of the product and of any important detail, so interface overlays do not cover it.';

export const DEFAULT_PROMPT_BODY = `A clean, photorealistic product photograph of {{title}}, shown as in the reference images.
Setting: a bright, minimal scene that suits the product, soft natural light, shallow depth of field, the product sharp and centred.
The product fills most of the frame. One product only.`;

/**
 * One direction per image, so a batch is a set of different shots rather than one shot repeated.
 * Image models given the same prompt twice return near-copies; only the prompt can vary them.
 */
export const DEFAULT_SHOTS = [
  'Three-quarter front view at eye level, the whole product in frame and centred.',
  'Side profile from a low camera close to the surface, the product off-centre with empty space on one side.',
  'Seen from directly above, looking straight down.',
  'Close-up on the material, texture and construction details; the frame may crop part of the product.',
  'Pulled back to show more of the scene, the product smaller in the frame and in natural use.',
  'Three-quarter view from behind, at a slight downward angle.',
] as const;

const SHOTS_HEADING = /^[ \t]*shots[ \t]*:[ \t]*$/im;

/**
 * A prompt body may end with its own shot list: a line reading "Shots:" followed by one shot per
 * line. Those replace the defaults. The list is removed from the body that becomes the prompt.
 */
export function splitShots(body: string): { body: string; shots: string[] } {
  const m = SHOTS_HEADING.exec(body);
  if (!m) return { body, shots: [] };
  const shots = body
    .slice(m.index + m[0].length)
    .split('\n')
    .map((l) => l.replace(/^[ \t]*(?:[-*•]|\d+[.)])?[ \t]*/, '').trim())
    .filter(Boolean);
  return { body: body.slice(0, m.index).trimEnd(), shots };
}

/** The direction for the nth image of a format (0-based). Lists shorter than the batch repeat, and say so. */
export function shotFor(shots: readonly string[], index: number): string {
  const list = shots.length ? shots : DEFAULT_SHOTS;
  const shot = list[index % list.length]!;
  const lap = Math.floor(index / list.length);
  return lap === 0 ? shot : `${shot} Use a different pose, distance and crop from any earlier image of this view.`;
}

/** Add finished images to the Shopify product. Empty `creativeIds` means every approved image not yet sent. */
export const ShopifyMediaInput = z.object({ productId: z.number().int(), creativeIds: z.array(z.number().int()).default([]) });
export type ShopifyMediaInput = z.infer<typeof ShopifyMediaInput>;

export const CreativeAction = z.enum(['approve', 'reject', 'unapprove']);
export type CreativeAction = z.infer<typeof CreativeAction>;

/**
 * Bring photos that are already on the Shopify product in as creatives, so a launch can use the
 * store's own photography instead of only generated images. Each becomes one 1:1 finished JPEG.
 */
export const ImportShopifyPhotosInput = z.object({
  productId: z.number().int(),
  /** Shopify MediaImage IDs, in the order they take their slots. */
  mediaIds: z.array(z.string().min(1)).min(1).max(50),
});
export type ImportShopifyPhotosInput = z.infer<typeof ImportShopifyPhotosInput>;

/** How far from square a photo may be before the 1:1 frame visibly crops it. */
export const SQUARE_TOLERANCE = 0.02;
export function isSquare(width: number | null, height: number | null): boolean {
  return !width || !height ? true : Math.abs(width / height - 1) <= SQUARE_TOLERANCE;
}

/** One photo on the Shopify product, as the picker lists it. */
export const ShopifyPhotoView = z.object({
  id: z.string(),
  url: z.string(),
  altText: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** False when the photo is not square, so the 1:1 frame will crop it. */
  square: z.boolean(),
  /** Set once the photo has been imported: the creative it became. */
  creativeId: z.number().int().nullable(),
  fileName: z.string().nullable(),
  approval: Approval.nullable(),
});
export type ShopifyPhotoView = z.infer<typeof ShopifyPhotoView>;

export const ShopifyPhotoList = z.object({
  productId: z.number().int(),
  handle: z.string().nullable(),
  /** Null when the product has never been read back from Shopify. */
  fetchedAt: z.string().nullable(),
  /** The snapshot is 10 minutes old or more, so importing re-reads it (1 query). */
  stale: z.boolean(),
  photos: z.array(ShopifyPhotoView),
});
export type ShopifyPhotoList = z.infer<typeof ShopifyPhotoList>;
