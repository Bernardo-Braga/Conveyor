import fs from 'node:fs/promises';
import path from 'node:path';
import { ASPECT_TAG, type Aspect } from '@conveyor/shared';

/**
 * Where creative files live, under the product's folder:
 *   creatives/<handle>_<4x5>_<NN>.jpg          finished, the only files Meta ever sees
 *   creatives/originals/batch-<id>/<4x5>-<NN>.<ext>   untouched engine output
 * Templates name ads after the finished file, so the name is stable per product, aspect and slot.
 */
export function finishedFileName(handle: string, aspect: Aspect, slot: number): string {
  const safe = handle.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'product';
  return `${safe}_${ASPECT_TAG[aspect]}_${String(slot).padStart(2, '0')}.jpg`;
}

export function finishedPath(productDir: string, handle: string, aspect: Aspect, slot: number): string {
  return path.join(productDir, 'creatives', finishedFileName(handle, aspect, slot));
}

export function originalPath(productDir: string, batchId: number, aspect: Aspect, slot: number, ext: string): string {
  return path.join(productDir, 'creatives', 'originals', `batch-${batchId}`, `${ASPECT_TAG[aspect]}-${String(slot).padStart(2, '0')}${ext}`);
}

export async function writeFileSafe(file: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

/** A file is safe to read once its size has stopped changing between two looks. */
export async function fileIsStable(file: string, waitMs = 400): Promise<boolean> {
  const a = await fs.stat(file).catch(() => null);
  if (!a || a.size === 0) return false;
  await new Promise((r) => setTimeout(r, waitMs));
  const b = await fs.stat(file).catch(() => null);
  return !!b && b.size === a.size;
}
