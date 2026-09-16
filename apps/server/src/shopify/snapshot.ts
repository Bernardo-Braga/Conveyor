import { eq } from 'drizzle-orm';
import { ShopifySnapshot } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { products } from '../db/schema.ts';
import { toMinor, type ShopifyClient } from './client.ts';

/** Snapshots younger than this are reused (PLAN.md section 3). */
export const FRESH_MS = 10 * 60 * 1000;

export const PRODUCT_QUERY = `
query ConveyorProduct($id: ID!) {
  product(id: $id) {
    id handle title status descriptionHtml productType tags vendor onlineStoreUrl updatedAt
    featuredMedia { preview { image { url } } }
    media(first: 50) { nodes { id ... on MediaImage { image { url altText } } } }
    options { name optionValues { name } }
    variants(first: 100) { nodes { id title sku price compareAtPrice media(first: 1) { nodes { id } } } }
  }
  shop { currencyCode }
}`;

interface ProductData {
  product: {
    id: string; handle: string; title: string; status: string; descriptionHtml: string; productType: string; tags: string[]; vendor: string; onlineStoreUrl: string | null; updatedAt: string;
    featuredMedia: { preview: { image: { url: string } | null } | null } | null;
    media: { nodes: { id: string; image?: { url: string; altText: string | null } | null }[] };
    options: { name: string; optionValues: { name: string }[] }[];
    variants: { nodes: { id: string; title: string; sku: string | null; price: string; compareAtPrice: string | null; media: { nodes: { id: string }[] } }[] };
  } | null;
  shop: { currencyCode: string };
}

/** Read one product back from Shopify (1 query) and validate it into a snapshot. */
export async function readSnapshot(client: ShopifyClient, shopifyProductId: string, meta: { productId?: number | null; jobId?: number | null } = {}): Promise<{ snapshot: ShopifySnapshot; requestId: string | null }> {
  const { data, requestId } = await client.graphql<ProductData>('product_snapshot', PRODUCT_QUERY, { id: shopifyProductId }, meta);
  const p = data.product;
  if (!p) throw new Error(`Shopify product ${shopifyProductId} was not found.`);
  const snapshot = ShopifySnapshot.parse({
    id: p.id,
    handle: p.handle,
    title: p.title,
    status: p.status,
    descriptionHtml: p.descriptionHtml,
    productType: p.productType,
    tags: p.tags,
    vendor: p.vendor,
    onlineStoreUrl: p.onlineStoreUrl,
    featuredImage: p.featuredMedia?.preview?.image?.url ?? null,
    images: p.media.nodes.filter((m) => m.image).map((m) => ({ id: m.id, url: m.image!.url, altText: m.image!.altText })),
    options: p.options.map((o) => ({ name: o.name, values: o.optionValues.map((v) => v.name) })),
    variants: p.variants.nodes.map((v) => ({ id: v.id, title: v.title, sku: v.sku, priceMinor: toMinor(v.price) ?? 0, compareAtPriceMinor: toMinor(v.compareAtPrice), imageId: v.media.nodes[0]?.id ?? null })),
    currency: data.shop.currencyCode,
    updatedAt: p.updatedAt,
    fetchedAt: new Date().toISOString(),
  });
  return { snapshot, requestId };
}

export function storeSnapshot(db: Db, productId: number, snapshot: ShopifySnapshot): void {
  db.update(products)
    .set({ snapshot, snapshotAt: snapshot.fetchedAt, shopifyProductId: snapshot.id, shopifyHandle: snapshot.handle, title: snapshot.title, updatedAt: new Date().toISOString() })
    .where(eq(products.id, productId))
    .run();
}

export function isFresh(snapshotAt: string | null, now = Date.now()): boolean {
  return !!snapshotAt && now - new Date(snapshotAt).getTime() < FRESH_MS;
}
