import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { ReferenceRule, ShopifySnapshot } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { referenceCache } from '../db/schema.ts';
import type { LedgerClient } from '../http/ledgerClient.ts';
import { detectFormat } from './finish.ts';

const EXT: Record<string, string> = { png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif' };

export interface ReferenceSet {
  /** Absolute paths, in Shopify image order. */
  paths: string[];
  downloaded: number;
  reused: number;
  skipped: string[];
}

export function referenceImageIds(snapshot: ShopifySnapshot, rule: ReferenceRule): { id: string; url: string }[] {
  const imgs = snapshot.images.map((i) => ({ id: i.id, url: i.url }));
  if (rule === 'none') return [];
  if (rule === 'first_shopify_image') return imgs.slice(0, 1);
  return imgs.slice(0, 3);
}

/**
 * Downloads reference images once per product into `<productDir>/references/`, keyed by the
 * Shopify image ID in `reference_cache`. These are Shopify CDN reads, not Admin API queries.
 */
export async function ensureReferences(deps: { db: Db; ledger: LedgerClient }, productId: number, snapshot: ShopifySnapshot, rule: ReferenceRule, productDir: string, meta: { jobId: number | null }): Promise<ReferenceSet> {
  const out: ReferenceSet = { paths: [], downloaded: 0, reused: 0, skipped: [] };
  const dir = path.join(productDir, 'references');
  await fs.mkdir(dir, { recursive: true });
  for (const [i, img] of referenceImageIds(snapshot, rule).entries()) {
    const cached = deps.db.select().from(referenceCache).where(and(eq(referenceCache.productId, productId), eq(referenceCache.shopifyImageId, img.id))).get();
    if (cached && (await fs.stat(cached.path).catch(() => null))) {
      out.paths.push(cached.path);
      out.reused += 1;
      continue;
    }
    try {
      const res = await deps.ledger.fetch({ service: 'cdn', purpose: 'reference_image', productId, jobId: meta.jobId }, img.url, { headers: { accept: 'image/*' } }, { timeoutMs: 30_000, retries: 1 });
      if (!res.ok) {
        out.skipped.push(`reference ${i}: HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = EXT[detectFormat(buf)];
      if (!ext) {
        out.skipped.push(`reference ${i}: not an image`);
        continue;
      }
      const file = path.join(dir, `ref-${i}${ext}`);
      await fs.writeFile(file, buf);
      deps.db
        .insert(referenceCache)
        .values({ productId, shopifyImageId: img.id, path: file })
        .onConflictDoUpdate({ target: [referenceCache.productId, referenceCache.shopifyImageId], set: { path: file } })
        .run();
      out.paths.push(file);
      out.downloaded += 1;
    } catch (err) {
      out.skipped.push(`reference ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
