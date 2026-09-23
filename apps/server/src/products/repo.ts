import { desc, eq } from 'drizzle-orm';
import { HISTORY_TITLES, ListingDraft, ProductDetail, ProductView, SourceProduct, type JobError, type Pricing, type ProductState } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { products, supplierRaw } from '../db/schema.ts';
import { thumbnailUrl } from '../suppliers/cleanImages.ts';

type Row = typeof products.$inferSelect;

export function toProductView(row: Row): ProductView {
  const src = row.source ? SourceProduct.safeParse(row.source) : null;
  const source = src?.success ? src.data : null;
  const snapshot = row.snapshot as { featuredImage?: string | null } | null;
  const costs = source?.variants.map((v) => v.costMinor) ?? [];
  return ProductView.parse({
    id: row.id,
    origin: row.origin,
    platform: row.platform,
    itemId: row.itemId,
    sourceUrl: row.sourceUrl,
    state: row.state as ProductState,
    title: row.title ?? source?.title ?? null,
    thumbnail: snapshot?.featuredImage ?? (source?.images[0] ? thumbnailUrl(source.images[0]) : null),
    moq: row.moq ?? source?.moq ?? null,
    currency: source?.currency ?? null,
    costMinor: costs.length ? Math.min(...costs) : null,
    variantCount: source?.variants.length ?? 0,
    imageCount: source?.images.length ?? 0,
    shopifyProductId: row.shopifyProductId,
    shopifyHandle: row.shopifyHandle,
    snapshotAt: row.snapshotAt,
    failure: (row.failure as JobError | null) ?? null,
    focus: row.focus,
    listing: listingSummary(row),
    adminUrl: row.shopifyProductId ? adminUrlFor(row.shopifyProductId) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function listProducts(db: Db): ProductView[] {
  return db.select().from(products).orderBy(desc(products.id)).all().map(toProductView);
}

/**
 * Titles this store has already used, newest first, for the history block in the writer's prompt.
 * A product's own title is left out so a rewrite is free to keep the name it already has. Reads
 * the draft first: a listing that was written but never reached Shopify still counts as used.
 */
export function recentTitles(db: Db, opts: { exclude?: number | null; limit?: number } = {}): string[] {
  const limit = opts.limit ?? HISTORY_TITLES;
  const rows = db
    .select({ id: products.id, title: products.title, listingDraft: products.listingDraft })
    .from(products)
    .orderBy(desc(products.id))
    .limit(limit * 2)
    .all();
  const titles: string[] = [];
  for (const row of rows) {
    if (opts.exclude != null && row.id === opts.exclude) continue;
    const draft = row.listingDraft ? ListingDraft.safeParse(row.listingDraft) : null;
    const title = (draft?.success ? draft.data.title : null) ?? row.title;
    if (title?.trim()) titles.push(title.trim());
    if (titles.length >= limit) break;
  }
  return titles;
}

export function getProduct(db: Db, id: number): Row | null {
  return db.select().from(products).where(eq(products.id, id)).get() ?? null;
}

export function productDetail(db: Db, id: number): ProductDetail | null {
  const row = getProduct(db, id);
  if (!row) return null;
  const view = toProductView(row);
  const src = row.source ? SourceProduct.safeParse(row.source) : null;
  const raw = row.sourceRawId ? db.select({ fetchedAt: supplierRaw.fetchedAt }).from(supplierRaw).where(eq(supplierRaw.id, row.sourceRawId)).get() : null;
  return ProductDetail.parse({ ...view, source: src?.success ? src.data : null, supplierFetchedAt: raw?.fetchedAt ?? null });
}

export function setState(db: Db, id: number, state: ProductState, patch: Partial<typeof products.$inferInsert> = {}): void {
  db.update(products).set({ state, ...patch, updatedAt: new Date().toISOString() }).where(eq(products.id, id)).run();
}

export function markAttention(db: Db, id: number, failure: JobError): void {
  setState(db, id, 'needs_attention', { failure });
}

function listingSummary(row: Row): ProductView['listing'] {
  const draft = row.listingDraft ? ListingDraft.safeParse(row.listingDraft) : null;
  const extra = (row.highlights as { pricing?: Pricing; notes?: string[]; variantCount?: number; imageCount?: number } | null) ?? null;
  if (!draft?.success && !extra?.pricing) return null;
  return {
    title: draft?.success ? draft.data.title : null,
    needsCheck: draft?.success ? draft.data.needsCheck : [],
    priceMinor: extra?.pricing?.priceMinor ?? null,
    compareAtMinor: extra?.pricing?.compareAtMinor ?? null,
    marginMinor: extra?.pricing?.marginMinor ?? null,
    notes: extra?.notes ?? [],
  };
}

/** Store-agnostic admin deep link; Shopify redirects to the right store for a logged-in owner. */
export function adminUrlFor(shopifyProductId: string): string {
  return `https://admin.shopify.com/products/${shopifyProductId.split('/').pop()}`;
}
