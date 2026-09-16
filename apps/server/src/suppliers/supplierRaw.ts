import { and, desc, eq } from 'drizzle-orm';
import type { Platform } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { supplierRaw } from '../db/schema.ts';

/** Raw supplier responses are saved before parsing and kept for good. */
export function saveRaw(db: Db, row: { platform: Platform; itemId: string; httpStatus: number; body: string }): number {
  return db.insert(supplierRaw).values(row).returning({ id: supplierRaw.id }).get()!.id;
}

export function latestRaw(db: Db, platform: Platform, itemId: string) {
  return db
    .select()
    .from(supplierRaw)
    .where(and(eq(supplierRaw.platform, platform), eq(supplierRaw.itemId, itemId)))
    .orderBy(desc(supplierRaw.id))
    .limit(1)
    .get() ?? null;
}
