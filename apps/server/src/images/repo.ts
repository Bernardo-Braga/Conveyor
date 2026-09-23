import { desc, eq, inArray } from 'drizzle-orm';
import { BatchView, CreativeView, type Aspect } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { creativeBatches, creatives } from '../db/schema.ts';

type CreativeRow = typeof creatives.$inferSelect;
type BatchRow = typeof creativeBatches.$inferSelect;

export function toCreativeView(r: CreativeRow): CreativeView {
  return CreativeView.parse({
    id: r.id,
    batchId: r.batchId,
    productId: r.productId,
    aspect: r.aspect,
    slot: r.slot,
    status: r.status,
    approval: r.approval,
    fileName: r.fileName,
    finishedUrl: r.finishedPath ? `/api/creatives/${r.id}/file` : null,
    originalUrl: r.originalPath ? `/api/creatives/${r.id}/original` : null,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    sha256: r.sha256,
    detectedFormat: r.detectedFormat,
    metadataCheck: r.metadataCheck,
    flags: (r.flags as string[] | null) ?? [],
    error: r.error,
    shopifyMediaId: r.shopifyMediaId,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  });
}

export function toBatchView(b: BatchRow, rows: CreativeRow[]): BatchView {
  const items = rows.filter((c) => c.batchId === b.id).sort((x, y) => x.aspect.localeCompare(y.aspect) || x.slot - y.slot).map(toCreativeView);
  return BatchView.parse({
    id: b.id,
    productId: b.productId,
    handle: b.handle,
    engine: b.engine,
    status: b.status,
    prompt: b.prompt,
    formats: b.formats as Aspect[],
    countPerFormat: b.countPerFormat,
    total: items.length,
    finished: items.filter((c) => c.status === 'finished').length,
    failed: items.filter((c) => c.status === 'failed').length,
    pending: items.filter((c) => c.status === 'pending' || c.status === 'generating').length,
    apiRequests: b.apiRequests,
    note: b.note,
    replacesCreativeId: b.replacesCreativeId,
    createdAt: b.createdAt,
    finishedAt: b.finishedAt,
    creatives: items,
  });
}

export function listBatches(db: Db, productId: number): BatchView[] {
  const batches = db.select().from(creativeBatches).where(eq(creativeBatches.productId, productId)).orderBy(desc(creativeBatches.id)).all();
  if (!batches.length) return [];
  const rows = db.select().from(creatives).where(inArray(creatives.batchId, batches.map((b) => b.id))).all();
  return batches.map((b) => toBatchView(b, rows));
}

export function getBatch(db: Db, id: number): BatchView | null {
  const b = db.select().from(creativeBatches).where(eq(creativeBatches.id, id)).get();
  if (!b) return null;
  return toBatchView(b, db.select().from(creatives).where(eq(creatives.batchId, id)).all());
}

export function getCreative(db: Db, id: number): CreativeRow | null {
  return db.select().from(creatives).where(eq(creatives.id, id)).get() ?? null;
}
