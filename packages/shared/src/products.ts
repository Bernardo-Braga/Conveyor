import { z } from 'zod';
import { JobError } from './jobs.ts';
import { Platform, ProductState } from './product.ts';
import { SourceProduct } from './supplier.ts';

/**
 * What the listing writer is told to lean on for one product: "the full-grain leather", "for
 * commuters, not hikers". It changes with every import, so it belongs on the product, not in
 * the brand voice under Settings.
 */
export const ProductFocus = z.string().trim().max(500).default('');

/**
 * What the input bar sends: a link or a product name, and the focus for this one product.
 * The server decides which the text is; the focus rides along to the listing writer.
 */
export const AddToLineInput = z.object({ text: z.string().trim().min(1).max(2048), focus: ProductFocus });
export type AddToLineInput = z.infer<typeof AddToLineInput>;

/** A line or two of direction for this product's listing, set before it is imported. */
export const ProductFocusInput = z.object({ focus: ProductFocus });
export type ProductFocusInput = z.infer<typeof ProductFocusInput>;

export const ProductView = z.object({
  id: z.number().int(),
  origin: z.enum(['link', 'shopify']),
  platform: Platform.nullable(),
  itemId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  state: ProductState,
  title: z.string().nullable(),
  /** First cleaned image, or the Shopify featured image. The browser loads a small supplier version. */
  thumbnail: z.string().nullable(),
  moq: z.number().int().nullable(),
  currency: z.enum(['USD', 'CNY']).nullable(),
  /** Lowest variant cost in minor units of `currency`. */
  costMinor: z.number().int().nullable(),
  variantCount: z.number().int(),
  imageCount: z.number().int(),
  shopifyProductId: z.string().nullable(),
  shopifyHandle: z.string().nullable(),
  snapshotAt: z.string().nullable(),
  failure: JobError.nullable(),
  /** The focus the listing was (or will be) written to, empty when there is none. */
  focus: z.string(),
  /** Listing station summary, once Claude has written a draft. */
  listing: z
    .object({
      title: z.string().nullable(),
      needsCheck: z.array(z.string()),
      priceMinor: z.number().int().nullable(),
      compareAtMinor: z.number().int().nullable(),
      marginMinor: z.number().int().nullable(),
      notes: z.array(z.string()),
    })
    .nullable(),
  adminUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductView = z.infer<typeof ProductView>;

export const ProductDetail = ProductView.extend({
  source: SourceProduct.nullable(),
  supplierFetchedAt: z.string().nullable(),
});
export type ProductDetail = z.infer<typeof ProductDetail>;

/** The answer to "Add to the line". */
export const AddToLineResult = z.discriminatedUnion('kind', [
  /** A supported link that is new: an import job was queued. 1 RapidAPI request. */
  z.object({ kind: z.literal('importing'), productId: z.number().int(), jobId: z.number().int() }),
  /** A link already on the Line: 0 requests. */
  z.object({ kind: z.literal('duplicate'), productId: z.number().int() }),
  /** Not a link: candidates from the Shopify store (1 query). Picking one costs 1 more. */
  z.object({ kind: z.literal('search'), query: z.string(), results: z.array(z.object({ id: z.string(), title: z.string(), handle: z.string(), status: z.string(), image: z.string().nullable(), updatedAt: z.string(), onLine: z.number().int().nullable() })) }),
  /** A link Conveyor does not understand. 0 requests. */
  z.object({ kind: z.literal('unsupported'), message: z.string() }),
]);
export type AddToLineResult = z.infer<typeof AddToLineResult>;
export type ShopifySearchHit = Extract<AddToLineResult, { kind: 'search' }>['results'][number];

export const ImportJobInput = z.object({ productId: z.number().int(), platform: Platform, itemId: z.string(), url: z.string(), refresh: z.boolean().default(false) });
export type ImportJobInput = z.infer<typeof ImportJobInput>;

export const PullProductInput = z.object({ productId: z.number().int().nullable(), shopifyProductId: z.string().nullable().default(null), handle: z.string().nullable().default(null), /** A re-read of a product already on the Line: the snapshot is replaced, the state is left alone. */ refresh: z.boolean().default(false) });
export const FromHandleInput = z.object({ handle: z.string().trim().min(1).max(255) });
export type PullProductInput = z.infer<typeof PullProductInput>;

/** A Shopify product read (one query). Stored on the product as `snapshot`; Shopify is the source of truth after import. */
export const ShopifySnapshot = z.object({
  id: z.string(),
  handle: z.string(),
  title: z.string(),
  status: z.string(),
  descriptionHtml: z.string(),
  productType: z.string(),
  tags: z.array(z.string()),
  vendor: z.string(),
  onlineStoreUrl: z.string().nullable(),
  featuredImage: z.string().nullable(),
  images: z.array(z.object({ id: z.string(), url: z.string(), altText: z.string().nullable(), width: z.number().int().nullable().default(null), height: z.number().int().nullable().default(null) })),
  options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
  variants: z.array(z.object({ id: z.string(), title: z.string(), sku: z.string().nullable(), priceMinor: z.number().int(), compareAtPriceMinor: z.number().int().nullable(), imageId: z.string().nullable() })),
  currency: z.string(),
  updatedAt: z.string(),
  fetchedAt: z.string(),
});
export type ShopifySnapshot = z.infer<typeof ShopifySnapshot>;
