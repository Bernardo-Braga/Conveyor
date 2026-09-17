import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_PHOTOS, type SourceProduct } from '@conveyor/shared';
import type { LedgerClient } from '../http/ledgerClient.ts';

const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
/** A supplier photo larger than this is not worth showing a writer. */
const MAX_BYTES = 8 * 1024 * 1024;

export interface PhotoSet {
  /** File names inside the product folder, in gallery order. */
  files: string[];
  downloaded: number;
  reused: number;
  skipped: string[];
}

/**
 * Downloads up to MAX_PHOTOS supplier photos into the product's folder so a local writer
 * can read them. These come from the supplier's image server, not RapidAPI, so they cost
 * no quota. Already-downloaded photos are reused, making a retry free.
 */
export async function ensurePhotos(ledger: LedgerClient, source: SourceProduct, dir: string, meta: { productId: number | null; jobId: number | null }, max = MAX_PHOTOS): Promise<PhotoSet> {
  const out: PhotoSet = { files: [], downloaded: 0, reused: 0, skipped: [] };
  if (max <= 0) return out;
  await fs.mkdir(dir, { recursive: true });
  const existing = new Set(await fs.readdir(dir).catch(() => [] as string[]));

  for (const [i, url] of source.images.slice(0, max).entries()) {
    const already = [...existing].find((f) => f.startsWith(`photo-${i}.`));
    if (already) {
      out.files.push(already);
      out.reused += 1;
      continue;
    }
    try {
      const res = await ledger.fetch({ service: 'cdn', purpose: 'listing_photo', productId: meta.productId, jobId: meta.jobId }, url, { headers: { accept: 'image/*' } }, { timeoutMs: 30_000, retries: 1 });
      if (!res.ok) {
        out.skipped.push(`image ${i}: HTTP ${res.status}`);
        continue;
      }
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const ext = EXT[type] ?? (path.extname(new URL(url).pathname).toLowerCase() || '.jpg');
      if (!Object.values(EXT).includes(ext)) {
        out.skipped.push(`image ${i}: unsupported type ${type || ext}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) {
        out.skipped.push(`image ${i}: ${buf.length} bytes`);
        continue;
      }
      const name = `photo-${i}${ext}`;
      await fs.writeFile(path.join(dir, name), buf);
      out.files.push(name);
      out.downloaded += 1;
    } catch (err) {
      out.skipped.push(`image ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
