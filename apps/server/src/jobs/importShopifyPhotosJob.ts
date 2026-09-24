import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNotNull, max } from 'drizzle-orm';
import { ImportShopifyPhotosInput, ShopifySnapshot, isSquare, type JobError } from '@conveyor/shared';
import { creativeBatches, creatives, products } from '../db/schema.ts';
import { productDir } from '../env.ts';
import { exiftoolAvailable, exiftoolClean } from '../images/exiftool.ts';
import { finishCreative } from '../images/finish.ts';
import { finishedFileName, finishedPath, originalPath, writeFileSafe } from '../images/store.ts';
import { addToPlan } from '../meta/plan.ts';
import { markAttention, setState } from '../products/repo.ts';
import type { ShopifyClient } from '../shopify/client.ts';
import { isFresh, readSnapshot, storeSnapshot } from '../shopify/snapshot.ts';
import { JobStepError, type JobDefinition } from './types.ts';

const EXT: Record<string, string> = { png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif', heif: '.heic', tiff: '.tif', unknown: '.bin' };

/** States a newly approved creative may move a product out of. A live product is left alone. */
const PRE_LAUNCH = new Set(['editing_in_shopify', 'from_shopify', 'generating', 'review']);

interface Planned {
  creativeId: number;
  mediaId: string;
  url: string;
  slot: number;
}

/**
 * Brings photos that are already on the Shopify product in as creatives, so a launch can use the
 * store's own photography instead of only generated images.
 *
 * At most one API request: the Shopify snapshot, and only when the last one is 10 minutes old or
 * older. Each photo is one Shopify CDN download, which costs no Admin quota. Every photo goes
 * through `finishCreative`, so what a launch uploads is the same branded `FinishedJpeg` as a
 * generated image and hard rule 7 still holds: there is no second path to Meta.
 *
 * Steps: snapshot (0 or 1 query) → plan (local) → fetch (1 CDN download each + finishing) → finish.
 */
export function importShopifyPhotosJob(deps: { shopify: ShopifyClient }): JobDefinition<ImportShopifyPhotosInput> {
  return {
    type: 'import_shopify_photos',
    input: ImportShopifyPhotosInput,
    steps: [
      {
        name: 'snapshot',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get();
          if (!row) throw new JobStepError('Product not found.');
          if (!row.shopifyProductId) throw new JobStepError('This product is not in Shopify yet.', { suggestion: 'Write the listing first; its photos are read back from the Shopify product.' });
          if (isFresh(row.snapshotAt)) {
            ctx.log(`Reusing the Shopify snapshot from ${row.snapshotAt} (under 10 minutes old). 0 requests.`);
            return { requests: 0 };
          }
          const { snapshot, requestId } = await readSnapshot(deps.shopify, row.shopifyProductId, { productId: row.id, jobId: ctx.jobId });
          storeSnapshot(ctx.db, row.id, snapshot);
          ctx.log(`Read ${snapshot.title} back from Shopify (1 query): ${snapshot.images.length} photo(s) on the product.`, 'info', requestId);
          return { requests: 1 };
        },
      },
      {
        name: 'plan',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get()!;
          const snapshot = ShopifySnapshot.parse(row.snapshot);
          const byId = new Map(snapshot.images.map((i) => [i.id, i]));

          // Photos already imported keep their creative; re-importing one would only duplicate it.
          const already = new Set(
            ctx.db
              .select({ m: creatives.sourceMediaId })
              .from(creatives)
              .where(and(eq(creatives.productId, row.id), isNotNull(creatives.sourceMediaId)))
              .all()
              .map((r) => r.m!),
          );
          const gone = ctx.input.mediaIds.filter((id) => !byId.has(id));
          const repeats = ctx.input.mediaIds.filter((id) => byId.has(id) && already.has(id));
          const wanted = ctx.input.mediaIds.filter((id) => byId.has(id) && !already.has(id));
          if (gone.length) ctx.log(`${gone.length} photo(s) are no longer on the Shopify product and were skipped.`, 'warn');
          if (repeats.length) ctx.log(`${repeats.length} photo(s) are already imported and were skipped.`);
          if (!wanted.length) throw new JobStepError('None of the chosen photos can be imported.', { suggestion: gone.length ? 'Read the product back from Shopify, then choose again.' : 'These photos are already creatives for this product.' });

          const batch = ctx.db
            .insert(creativeBatches)
            .values({
              productId: row.id,
              prompt: `Imported ${wanted.length} photo(s) from the Shopify product. No engine ran.`,
              engine: 'shopify',
              status: 'running',
              handle: snapshot.handle,
              formats: ['1:1'],
              countPerFormat: wanted.length,
              settingsUsed: ctx.settings.get('images'),
              apiRequests: (ctx.prior.snapshot as { requests: number }).requests,
            })
            .returning()
            .get();

          // Slots continue the product-wide 1:1 numbering, so file names never collide.
          const last = ctx.db.select({ m: max(creatives.slot) }).from(creatives).where(and(eq(creatives.productId, row.id), eq(creatives.aspect, '1:1'))).get()?.m ?? 0;
          const planned: Planned[] = wanted.map((mediaId, i) => {
            const slot = last + i + 1;
            const c = ctx.db
              .insert(creatives)
              .values({ batchId: batch.id, productId: row.id, aspect: '1:1', slot, status: 'pending', sourceMediaId: mediaId, fileName: finishedFileName(snapshot.handle, '1:1', slot) })
              .returning({ id: creatives.id })
              .get();
            return { creativeId: c.id, mediaId, url: byId.get(mediaId)!.url, slot };
          });
          ctx.log(`Batch #${batch.id}: ${planned.length} Shopify photo(s) to import as 1:1 creatives. ${planned.length} CDN download(s), no Admin request.`);
          return { batchId: batch.id, planned, handle: snapshot.handle };
        },
      },
      {
        name: 'fetch',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get()!;
          const { batchId, planned, handle } = ctx.prior.plan as { batchId: number; planned: Planned[]; handle: string };
          const settings = ctx.settings.get('images');
          const dir = productDir(ctx.dataDir, row.id);

          // A retry downloads only what is still missing.
          const missing = new Set(ctx.db.select({ id: creatives.id }).from(creatives).where(and(eq(creatives.batchId, batchId), inArray(creatives.status, ['pending', 'failed', 'generating']))).all().map((c) => c.id));
          const todo = planned.filter((p) => missing.has(p.creativeId));
          if (!todo.length) {
            ctx.log('Every photo in this batch is already finished. Nothing to fetch.');
            return { imported: 0, failed: 0 };
          }

          const useExif = settings.finished.exiftoolCheck && (await exiftoolAvailable());
          const failures: string[] = [];
          let imported = 0;
          let cropped = 0;

          for (const [i, p] of todo.entries()) {
            try {
              const res = await ctx.ledger.fetch({ service: 'cdn', purpose: 'shopify_photo_import', productId: row.id, jobId: ctx.jobId }, p.url, { headers: { accept: 'image/*' } }, { timeoutMs: 60_000, retries: 1 });
              if (!res.ok) throw new Error(`HTTP ${res.status} from Shopify's image CDN`);
              const original = Buffer.from(await res.arrayBuffer());
              if (!original.length) throw new Error('the CDN returned an empty file');

              const finished = await finishCreative(original, '1:1', settings.finished.quality);
              const orig = originalPath(dir, batchId, '1:1', p.slot, EXT[finished.sourceFormat] ?? '.bin');
              const fin = finishedPath(dir, handle, '1:1', p.slot);
              await writeFileSafe(orig, original);
              await writeFileSafe(fin, finished.jpeg);

              let metadataCheck = 'clean (sharp)';
              if (useExif) {
                const check = await exiftoolClean(fin);
                if (!check.ok) {
                  // Never keep a finished file that exiftool can still read metadata from.
                  await fs.unlink(fin).catch(() => undefined);
                  throw new Error(`exiftool found ${check.extra.join(', ')} in the finished file`);
                }
                metadataCheck = 'clean (sharp, exiftool)';
              }

              // The store photo is usually square already; say so when it was not, since the
              // 1:1 frame crops the difference away.
              const square = isSquare(finished.sourceWidth, finished.sourceHeight);
              const flags = square ? [] : ['cropped'];
              if (!square) {
                cropped += 1;
                ctx.log(`${path.basename(fin)} came from a ${finished.sourceWidth}×${finished.sourceHeight} photo and was cropped to square.`, 'warn');
              }

              ctx.db
                .update(creatives)
                .set({
                  status: 'finished',
                  // Picking a photo is the choice; it arrives approved, ready for the launch plan.
                  approval: 'approved',
                  originalPath: orig,
                  detectedFormat: finished.sourceFormat,
                  finishedPath: fin,
                  fileName: path.basename(fin),
                  width: finished.width,
                  height: finished.height,
                  bytes: finished.bytes,
                  sha256: finished.sha256,
                  metadataCheck,
                  flags,
                  // It is already on the Shopify product, so "add approved to Shopify" skips it.
                  shopifyMediaId: p.mediaId,
                  error: null,
                  finishedAt: new Date().toISOString(),
                })
                .where(eq(creatives.id, p.creativeId))
                .run();
              imported += 1;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              failures.push(message);
              ctx.db.update(creatives).set({ status: 'failed', error: message }).where(eq(creatives.id, p.creativeId)).run();
              ctx.log(`Photo ${i + 1} of ${todo.length} failed: ${message}`, 'warn');
            }
            ctx.progress({ batchId, done: i + 1, total: todo.length });
          }

          ctx.log(`${imported} photo(s) finished as 1:1 JPEGs${cropped ? `, ${cropped} cropped from a non-square original` : ''}. ${todo.length} CDN download(s), 0 Admin requests.`);
          if (failures.length) {
            const note = `${failures.length} photo(s) did not arrive: ${failures[0]}`;
            ctx.db.update(creativeBatches).set({ status: imported ? 'partial' : 'failed', note, finishedAt: new Date().toISOString() }).where(eq(creativeBatches.id, batchId)).run();
            throw new JobStepError(note, { service: 'shopify', suggestion: imported ? 'The photos that arrived are ready. Retry this step to fetch only the missing ones.' : 'Check that the product still has these photos in Shopify, then retry this step.', retryable: true });
          }
          return { imported, failed: 0 };
        },
      },
      {
        name: 'finish',
        async run(ctx) {
          const { batchId } = ctx.prior.plan as { batchId: number };
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get()!;
          const done = ctx.db.select().from(creatives).where(and(eq(creatives.batchId, batchId), eq(creatives.status, 'finished'))).all().sort((a, b) => a.id - b.id);
          ctx.db.update(creativeBatches).set({ status: 'done', finishedAt: new Date().toISOString() }).where(eq(creativeBatches.id, batchId)).run();
          // Imported photos arrive approved, so the product is ready to launch with them.
          if (done.length && PRE_LAUNCH.has(row.state)) setState(ctx.db, row.id, 'ready_to_launch', { failure: null });
          // A saved launch plan is an explicit list: without this the photos would sit in the
          // gallery, approved, and never reach Meta.
          const plan = addToPlan(ctx.db, row.id, done.map((c) => c.id));
          ctx.log(
            plan
              ? `${done.length} Shopify photo(s) imported and added to this product's launch: ${plan.length} creative(s) now chosen.`
              : `${done.length} Shopify photo(s) imported. No launch plan is saved yet, so every approved creative launches, these included.`,
          );
          return { imported: done.length, chosen: plan?.length ?? null };
        },
      },
    ],
    onError(ctx, error: JobError) {
      // A partly imported batch is still usable; only a run with nothing finished needs attention.
      const batchId = (ctx.prior.plan as { batchId?: number } | undefined)?.batchId;
      const finished = batchId ? ctx.db.select({ id: creatives.id }).from(creatives).where(and(eq(creatives.batchId, batchId), eq(creatives.status, 'finished'))).all().length : 0;
      if (!finished) markAttention(ctx.db, ctx.input.productId, error);
    },
  };
}
