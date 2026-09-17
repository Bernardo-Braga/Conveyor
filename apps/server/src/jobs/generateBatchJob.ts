import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, max } from 'drizzle-orm';
import { GenerateBatchInput, ListingDraft, ShopifySnapshot, type Aspect, type ImageSettings, type JobError } from '@conveyor/shared';
import { creativeBatches, creatives, products } from '../db/schema.ts';
import { productDir } from '../env.ts';
import type { EngineSet, EngineSlot } from '../images/engine.ts';
import { exiftoolAvailable, exiftoolClean } from '../images/exiftool.ts';
import { finishCreative } from '../images/finish.ts';
import { builtinValues, defaultTemplate, fillPrompt, getTemplate } from '../images/prompts.ts';
import { ensureReferences } from '../images/references.ts';
import { finishedFileName, finishedPath, originalPath, writeFileSafe } from '../images/store.ts';
import { markAttention, setState } from '../products/repo.ts';
import type { ShopifyClient } from '../shopify/client.ts';
import { isFresh, readSnapshot, storeSnapshot } from '../shopify/snapshot.ts';
import { JobStepError, type JobDefinition } from './types.ts';

const EXT: Record<string, string> = { png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif', heif: '.heic', tiff: '.tif', unknown: '.bin' };

/**
 * Station 3 (PLAN.md section 8). One API request at most: the Shopify snapshot, and only when
 * the last one is 10 minutes old or older. Codex makes no API requests. Steps checkpoint, so a
 * retry regenerates only slots that are still missing.
 *
 * Steps: snapshot (0 or 1 query) → plan (local; batch row + one creative row per image) →
 * references (0 to 3 CDN downloads, once per product) → generate (engine + finishing) → finish.
 */
export function generateBatchJob(deps: { shopify: ShopifyClient; engines: (settings: ImageSettings) => EngineSet }): JobDefinition<GenerateBatchInput> {
  return {
    type: 'generate_batch',
    input: GenerateBatchInput,
    steps: [
      {
        name: 'snapshot',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get();
          if (!row) throw new JobStepError('Product not found.');
          if (!row.shopifyProductId) throw new JobStepError('This product is not in Shopify yet.', { suggestion: 'Write the listing first; creatives are made from the Shopify product.' });
          if (isFresh(row.snapshotAt)) {
            ctx.log(`Reusing the Shopify snapshot from ${row.snapshotAt} (under 10 minutes old). 0 requests.`);
            return { requests: 0, reused: true };
          }
          const { snapshot, requestId } = await readSnapshot(deps.shopify, row.shopifyProductId, { productId: row.id, jobId: ctx.jobId });
          storeSnapshot(ctx.db, row.id, snapshot);
          ctx.log(`Read ${snapshot.title} back from Shopify (1 query): ${snapshot.images.length} images, ${snapshot.variants.length} variants, status ${snapshot.status}.`, 'info', requestId);
          if (snapshot.status !== 'ACTIVE' && snapshot.status !== 'DRAFT') ctx.log(`Shopify status is ${snapshot.status}.`, 'warn');
          return { requests: 1, reused: false };
        },
      },
      {
        name: 'plan',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get()!;
          const snapshot = ShopifySnapshot.parse(row.snapshot);
          const draft = row.listingDraft ? ListingDraft.safeParse(row.listingDraft) : null;
          const settings = ctx.settings.get('images');
          const brand = ctx.settings.get('import').listing.tag;
          const template = ctx.input.promptTemplateId ? getTemplate(ctx.db, ctx.input.promptTemplateId) : defaultTemplate(ctx.db);
          if (!template) throw new JobStepError('Prompt template not found.');

          const regen = ctx.input.regenerate ? ctx.db.select().from(creatives).where(eq(creatives.id, ctx.input.regenerate.creativeId)).get() : null;
          if (ctx.input.regenerate && !regen) throw new JobStepError('The creative to regenerate no longer exists.');
          const formats: Aspect[] = regen ? [regen.aspect] : (ctx.input.formats ?? (template.formats as Aspect[]));
          const countPerFormat = regen ? 1 : (ctx.input.countPerFormat ?? template.countPerFormat);
          const engine = ctx.input.engine ?? settings.engine;

          // The prompt is filled once per batch; the 9:16 rule is appended per format at generate time.
          const values = { ...builtinValues(snapshot, draft?.success ? draft.data : null, brand, formats[0]!), ...ctx.input.variables };
          const { prompt, missing } = fillPrompt(template.body, values, '1:1');
          if (missing.length) ctx.log(`Prompt variables without a value were left blank: ${missing.join(', ')}.`, 'warn');
          const fullPrompt = ctx.input.regenerate?.instruction ? `${prompt}\n\nEdit instruction: ${ctx.input.regenerate.instruction}` : prompt;

          const batch = ctx.db
            .insert(creativeBatches)
            .values({ productId: row.id, promptTemplateId: template.id, promptTemplateVersion: template.version, prompt: fullPrompt, engine, status: 'running', handle: snapshot.handle, formats, countPerFormat, settingsUsed: settings, apiRequests: (ctx.prior.snapshot as { requests: number }).requests, replacesCreativeId: regen?.id ?? null })
            .returning()
            .get();

          // Slots continue the product-wide numbering per aspect so file names never collide.
          const slots: EngineSlot[] = [];
          for (const aspect of formats) {
            const last = ctx.db.select({ m: max(creatives.slot) }).from(creatives).where(and(eq(creatives.productId, row.id), eq(creatives.aspect, aspect))).get()?.m ?? 0;
            for (let i = 1; i <= countPerFormat; i++) {
              const slot = last + i;
              const c = ctx.db.insert(creatives).values({ batchId: batch.id, productId: row.id, aspect, slot, status: 'pending', fileName: finishedFileName(snapshot.handle, aspect, slot) }).returning({ id: creatives.id }).get();
              slots.push({ creativeId: c.id, aspect, slot });
            }
          }
          setState(ctx.db, row.id, 'generating', { failure: null });
          ctx.log(`Batch #${batch.id}: ${slots.length} image(s) planned (${formats.map((f) => `${countPerFormat} × ${f}`).join(', ')}) on ${engine}, template "${template.name}" v${template.version}.`);
          return { batchId: batch.id, slots, engine, referenceRule: template.referenceRule, handle: snapshot.handle };
        },
      },
      {
        name: 'references',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get()!;
          const snapshot = ShopifySnapshot.parse(row.snapshot);
          const { referenceRule } = ctx.prior.plan as { referenceRule: 'first_3_shopify_images' | 'first_shopify_image' | 'none' };
          const set = await ensureReferences(ctx, row.id, snapshot, referenceRule, productDir(ctx.dataDir, row.id), { jobId: ctx.jobId });
          for (const s of set.skipped) ctx.log(`Skipped ${s}`, 'warn');
          ctx.log(`${set.paths.length} reference image(s): ${set.downloaded} downloaded, ${set.reused} reused.`);
          return { paths: set.paths };
        },
      },
      {
        name: 'generate',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get()!;
          const { batchId, slots: planned, engine: engineId, handle } = ctx.prior.plan as { batchId: number; slots: EngineSlot[]; engine: 'codex' | 'openai'; handle: string };
          const { paths } = ctx.prior.references as { paths: string[] };
          const batch = ctx.db.select().from(creativeBatches).where(eq(creativeBatches.id, batchId)).get()!;
          const settings = ctx.settings.get('images');
          const engines = deps.engines(settings);
          const dir = productDir(ctx.dataDir, row.id);

          // A retry only generates what is still missing.
          const missingIds = new Set(ctx.db.select({ id: creatives.id }).from(creatives).where(and(eq(creatives.batchId, batchId), inArray(creatives.status, ['pending', 'failed', 'generating']))).all().map((c) => c.id));
          let slots = planned.filter((s) => missingIds.has(s.creativeId));
          if (!slots.length) {
            ctx.log('Every image in this batch is already finished. Nothing to generate.');
            return { produced: 0, handoff: null, apiRequests: 0 };
          }
          ctx.db.update(creatives).set({ status: 'generating', error: null }).where(inArray(creatives.id, slots.map((s) => s.creativeId))).run();

          let edit: { path: string; instruction: string } | null = null;
          if (ctx.input.regenerate?.instruction && batch.replacesCreativeId) {
            const target = ctx.db.select().from(creatives).where(eq(creatives.id, batch.replacesCreativeId)).get();
            if (target?.finishedPath) edit = { path: target.finishedPath, instruction: ctx.input.regenerate.instruction };
          }

          const useExif = settings.finished.exiftoolCheck && (await exiftoolAvailable());
          const onImage = async (slot: EngineSlot, original: Buffer) => {
            const finished = await finishCreative(original, slot.aspect, settings.finished.quality);
            const orig = originalPath(dir, batchId, slot.aspect, slot.slot, EXT[finished.sourceFormat] ?? '.bin');
            const fin = finishedPath(dir, handle, slot.aspect, slot.slot);
            await writeFileSafe(orig, original);
            await writeFileSafe(fin, finished.jpeg);
            let metadataCheck = 'clean (sharp)';
            const flags: string[] = [];
            if (useExif) {
              const check = await exiftoolClean(fin);
              if (!check.ok) {
                // Never keep a finished file that exiftool can still read metadata from.
                await fs.unlink(fin).catch(() => undefined);
                throw new Error(`exiftool found ${check.extra.join(', ')} in the finished file`);
              }
              metadataCheck = 'clean (sharp, exiftool)';
            }
            ctx.db
              .update(creatives)
              .set({ status: 'finished', originalPath: orig, detectedFormat: finished.sourceFormat, finishedPath: fin, fileName: path.basename(fin), width: finished.width, height: finished.height, bytes: finished.bytes, sha256: finished.sha256, metadataCheck, flags, error: null, finishedAt: new Date().toISOString() })
              .where(eq(creatives.id, slot.creativeId))
              .run();
          };

          const events = {
            onImage,
            log: (m: string, level: 'info' | 'warn' = 'info') => ctx.log(m, level),
            progress: (done: number, total: number) => ctx.progress({ batchId, done, total }),
          };
          const workDir = path.join(ctx.dataDir, 'workers', `batch-${batchId}`);
          let apiRequests = 0;
          let note: string | null = null;
          let producedTotal = 0;

          const order: ('codex' | 'openai')[] = engineId === 'codex' ? ['codex', 'openai'] : ['openai', 'codex'];
          for (const id of order) {
            const engine = engines[id];
            if (!engine) {
              if (id !== engineId) note = `${note ?? ''} The ${id} engine is not available in this build, so ${slots.length} image(s) are still to make.`.trim();
              else throw new JobStepError(`The ${id} engine is not available.`, { suggestion: 'Pick another engine under Settings, Image engine.' });
              continue;
            }
            const availability = await engine.available();
            if (!availability.ok) {
              if (id === engineId) throw new JobStepError(`${id}: ${availability.reason}`, { suggestion: 'Fix the engine or pick another under Settings, Image engine.', retryable: true });
              note = `${note ?? ''} ${availability.reason} ${slots.length} image(s) are still to make.`.trim();
              continue;
            }
            ctx.log(`${id === engineId ? 'Generating' : 'Handing the rest to'} ${id}: ${slots.length} image(s).`);
            const outcome = await engine.generate({ batchId, productId: row.id, workDir, referencePaths: paths, prompt: batch.prompt, slots, edit }, events);
            apiRequests += outcome.apiRequests;
            producedTotal += outcome.producedCreativeIds.length;
            slots = outcome.remaining;
            if (!slots.length) break;
            if (!outcome.handoff) {
              note = `${slots.length} image(s) did not arrive.`;
              break;
            }
            ctx.log(`${id} stopped: ${outcome.handoff.reason}`, 'warn');
            if (id === 'codex' && !settings.codex.handoffToOpenAI) {
              note = `${slots.length} image(s) left; hand-off to OpenAI is off.`;
              break;
            }
            note = `${outcome.handoff.reason} ${slots.length} image(s) left.`;
          }

          ctx.db.update(creativeBatches).set({ apiRequests: batch.apiRequests + apiRequests, note }).where(eq(creativeBatches.id, batchId)).run();
          ctx.log(`${producedTotal} image(s) finished this run, ${slots.length} missing. ${apiRequests} API request(s) by the engines.`);
          if (slots.length) {
            // Leave the step failed so a retry lands here and generates only what is missing.
            ctx.db.update(creatives).set({ status: 'failed', error: note ?? 'not produced' }).where(inArray(creatives.id, slots.map((s) => s.creativeId))).run();
            const finishedInBatch = ctx.db.select({ id: creatives.id }).from(creatives).where(and(eq(creatives.batchId, batchId), eq(creatives.status, 'finished'))).all().length;
            ctx.db.update(creativeBatches).set({ status: finishedInBatch ? 'partial' : note ? 'handoff' : 'failed', finishedAt: new Date().toISOString() }).where(eq(creativeBatches.id, batchId)).run();
            if (finishedInBatch) setState(ctx.db, row.id, 'review', { failure: null });
            throw new JobStepError(`${slots.length} of ${planned.length} images were not made. ${note ?? ''}`.trim(), {
              service: engineId,
              code: note && /limit/i.test(note) ? 'usage_limit' : null,
              suggestion: finishedInBatch ? 'The finished images are ready for review. Retry this step to generate only the missing ones.' : 'Check the Codex CLI under Connections, then retry this step.',
              retryable: true,
            });
          }
          return { produced: producedTotal, missing: 0, apiRequests, note };
        },
      },
      {
        name: 'finish',
        async run(ctx) {
          const { batchId } = ctx.prior.plan as { batchId: number };
          const total = ctx.db.select({ id: creatives.id }).from(creatives).where(eq(creatives.batchId, batchId)).all().length;
          ctx.db.update(creativeBatches).set({ status: 'done', note: null, finishedAt: new Date().toISOString() }).where(eq(creativeBatches.id, batchId)).run();
          setState(ctx.db, ctx.input.productId, 'review', { failure: null });
          ctx.log(`${total} images ready for review.`);
          return { finished: total, total };
        },
      },
    ],
    onError(ctx, error: JobError) {
      // A partial batch is still reviewable; only a run with nothing finished needs attention.
      const batchId = (ctx.prior.plan as { batchId?: number } | undefined)?.batchId;
      const finished = batchId ? ctx.db.select({ id: creatives.id }).from(creatives).where(and(eq(creatives.batchId, batchId), eq(creatives.status, 'finished'))).all().length : 0;
      if (!finished) markAttention(ctx.db, ctx.input.productId, error);
    },
  };
}
