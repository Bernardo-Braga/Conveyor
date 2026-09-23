import { and, eq, isNotNull } from 'drizzle-orm';
import { ShopifyPhotoList, ShopifySnapshot, isSquare } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { creatives, products } from '../db/schema.ts';
import { isFresh } from '../shopify/snapshot.ts';

/**
 * The photos on the Shopify product, with the creative each one has already become. Read from
 * the stored snapshot, so listing them costs nothing; importing re-reads when it is stale.
 */
export function listShopifyPhotos(db: Db, productId: number): ShopifyPhotoList | null {
  const row = db.select().from(products).where(eq(products.id, productId)).get();
  if (!row) return null;
  const parsed = row.snapshot ? ShopifySnapshot.safeParse(row.snapshot) : null;
  const imported = new Map(
    db
      .select()
      .from(creatives)
      .where(and(eq(creatives.productId, productId), isNotNull(creatives.sourceMediaId)))
      .all()
      .map((c) => [c.sourceMediaId!, c]),
  );
  return ShopifyPhotoList.parse({
    productId,
    handle: row.shopifyHandle,
    fetchedAt: row.snapshotAt,
    stale: !isFresh(row.snapshotAt),
    photos: (parsed?.success ? parsed.data.images : []).map((i) => {
      const c = imported.get(i.id);
      return {
        id: i.id,
        url: i.url,
        altText: i.altText,
        width: i.width,
        height: i.height,
        square: isSquare(i.width, i.height),
        creativeId: c?.id ?? null,
        fileName: c?.fileName ?? null,
        approval: c?.approval ?? null,
      };
    }),
  });
}
