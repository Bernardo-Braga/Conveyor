import { eq } from 'drizzle-orm';
import { ListingDraft, ListingJobInput, SourceProduct, WRITER_LABELS, type JobError, type Pricing } from '@conveyor/shared';
import { costs, products } from '../db/schema.ts';
import { productDir } from '../env.ts';
import { usdPerCnyToday } from '../listing/cnyRate.ts';
import { ensurePhotos, photoIndexes } from '../listing/photos.ts';
import { usdPerCny } from '../listing/pricing.ts';
import { buildDraftInput, createDraft } from '../listing/shopifyDraft.ts';
import { runListingWriter, WriterError, type WriterSet } from '../listing/writers/index.ts';
import { markAttention, recentTitles, setState } from '../products/repo.ts';
import type { ShopifyClient } from '../shopify/client.ts';
import { JobStepError, type JobDefinition } from './types.ts';

/**
 * Station 2. Two outside API requests: none for the writer, which runs
 * locally on your own plan, and one `productSet` for the draft. Photos are downloaded once
 * from the supplier's image server, which costs no quota.
 *
 * Steps: source → photos → write → price → shopify_draft → handoff. Each checkpoints, so a
 * Shopify failure never re-runs the writer, and a retry after a usage limit reuses the photos.
 */
export function listingJob(deps: { shopify: ShopifyClient; writers: WriterSet }): JobDefinition<ListingJobInput> {
  return {
    type: 'write_listing',
    input: ListingJobInput,
    steps: [
      {
        name: 'source',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get();
          if (!row) throw new JobStepError('Product not found.');
          const parsed = SourceProduct.safeParse(row.source);
          if (!parsed.success) throw new JobStepError('This product has no supplier data yet.', { suggestion: 'Import it from a link first, or use "Refresh supplier data".' });
          if (ctx.input.rewrite && !row.shopifyProductId) throw new JobStepError('Nothing to rewrite: no Shopify product yet.', { suggestion: 'Use "Write listing" instead.' });
          setState(ctx.db, row.id, 'writing_listing', { failure: null });
          ctx.log(`${parsed.data.images.length} images, ${parsed.data.variants.length} variants, ${parsed.data.attributes.length} attributes. Seller and review data stay out of the prompt.`);
          return { existingId: row.shopifyProductId };
        },
      },
      {
        name: 'photos',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get()!;
          const source = SourceProduct.parse(row.source);
          const settings = ctx.settings.get('import');
          const dir = productDir(ctx.dataDir, row.id);
          if (!settings.listing.showPhotos) {
            ctx.log('Photos are off in Settings; the writer works from the supplier text alone.');
            return { dir, files: [] as string[] };
          }
          const set = await ensurePhotos(ctx.ledger, source, dir, { productId: row.id, jobId: ctx.jobId });
          for (const s of set.skipped) ctx.log(`Skipped ${s}`, 'warn');
          ctx.log(`${set.files.length} photo(s) ready for the writer: ${set.downloaded} downloaded, ${set.reused} reused. No supplier quota is used.`);
          return { dir, files: set.files };
        },
      },
      {
        name: 'write',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get()!;
          const source = SourceProduct.parse(row.source);
          const settings = ctx.settings.get('import');
          const { dir, files } = ctx.prior.photos as { dir: string; files: string[] };
          const focus = row.focus.trim();
          // Names already used in the store, so the writer does not hand a second product the first one's title.
          const history = recentTitles(ctx.db, { exclude: row.id });
          ctx.log(`Running ${WRITER_LABELS[settings.listing.writer]}. This uses your plan, not an API request.`);
          if (focus) ctx.log(`Focus for this listing: ${focus}`);
          if (history.length) ctx.log(`${history.length} title(s) the store has already used go to the writer, so this one gets its own name.`);

          let outcome;
          try {
            outcome = await runListingWriter(ctx.writers, settings.listing.writer, { dir, source, brandVoice: settings.listing.brandVoice, instructions: settings.listing.instructions, focus, recentTitles: history, photos: files, productId: row.id, jobId: ctx.jobId }, (m, level) => ctx.log(m, level ?? 'info'));
          } catch (err) {
            if (err instanceof WriterError) {
              throw new JobStepError(err.message, {
                service: err.writer,
                code: err.usageLimit ? 'usage_limit' : null,
                suggestion: err.usageLimit ? 'Wait for the limit to reset, or pick another writer under Settings, Import. Retrying reuses the saved supplier data and photos, so nothing is fetched again.' : 'Retry this step; no supplier or Shopify request is repeated.',
                retryable: err.retryable || err.usageLimit,
              });
            }
            throw err;
          }

          ctx.db.update(products).set({ listingDraft: outcome.draft, updatedAt: new Date().toISOString() }).where(eq(products.id, row.id)).run();
          ctx.db.insert(costs).values({ jobId: ctx.jobId, service: outcome.writer, units: { attempts: outcome.attempts, durationMs: outcome.durationMs, apiRequests: outcome.apiRequests, handedOffFrom: outcome.handedOffFrom }, amountMinor: Math.round((outcome.reportedCostUsd ?? 0) * 100) }).run();
          ctx.log(`${outcome.detail} wrote "${outcome.draft.title}" in ${(outcome.durationMs / 1000).toFixed(1)}s (${outcome.apiRequests} API request${outcome.apiRequests === 1 ? '' : 's'}). ${outcome.draft.needsCheck.length} item(s) to verify in Shopify.`);
          return { writer: outcome.writer, apiRequests: outcome.apiRequests, attempts: outcome.attempts };
        },
      },
      {
        name: 'price',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get()!;
          const source = SourceProduct.parse(row.source);
          const settings = ctx.settings.get('import');
          const daily = source.currency === 'CNY' && settings.pricing.cnyRate.mode === 'daily' ? await usdPerCnyToday(ctx.ledger, ctx.settings, ctx.jobId) : null;
          const rate = usdPerCny(settings.pricing, daily);
          ctx.log(source.currency === 'CNY' ? `Pricing with ${rate} USD per CNY (${daily ? 'daily rate' : 'fixed rate'}).` : 'Pricing in USD.');
          return { usdPerCny: rate };
        },
      },
      {
        name: 'shopify_draft',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get()!;
          const source = SourceProduct.parse(row.source);
          const draft = ListingDraft.parse(row.listingDraft);
          const settings = ctx.settings.get('import');
          const { usdPerCny: rate } = ctx.prior.price as { usdPerCny: number };
          // Only the photos the writer read may be dropped by its imageOrder; the rest are kept.
          const reviewedImages = photoIndexes((ctx.prior.photos as { files?: string[] } | undefined)?.files ?? []);
          const plan = buildDraftInput({ source, draft, settings, usdPerCny: rate, reviewedImages, sourceMeta: { platform: source.source.platform, itemId: source.source.itemId, url: source.source.url, importedAt: row.createdAt, conveyorProductId: row.id } });
          for (const n of plan.notes) ctx.log(n, 'warn');
          const existingId = ctx.input.rewrite ? row.shopifyProductId : null;
          const created = await createDraft(deps.shopify, plan, { productId: row.id, jobId: ctx.jobId, existingId });
          const low = plan.pricing.reduce((m, p) => (p.priceMinor < m.priceMinor ? p : m), plan.pricing[0]!);
          ctx.db
            .update(products)
            .set({ shopifyProductId: created.id, shopifyHandle: created.handle, title: created.title, highlights: { pricing: low, notes: plan.notes, variantCount: plan.variantCount, imageCount: plan.imageCount }, updatedAt: new Date().toISOString() })
            .where(eq(products.id, row.id))
            .run();
          ctx.log(`${existingId ? 'Updated' : 'Created'} Shopify draft ${created.handle}: ${plan.variantCount} variants, ${plan.imageCount} images, from ${(low.priceMinor / 100).toFixed(2)} (${created.requests} request${created.requests === 1 ? '' : 's'}).`, 'info', created.requestId);
          return { shopifyProductId: created.id, handle: created.handle, requests: created.requests, pricing: low as Pricing };
        },
      },
      {
        name: 'handoff',
        async run(ctx) {
          setState(ctx.db, ctx.input.productId, 'editing_in_shopify', { failure: null });
          ctx.log('Editing in Shopify. "Generate creatives" will read the product back when you are done.');
          return null;
        },
      },
    ],
    onError(ctx, error: JobError) {
      markAttention(ctx.db, ctx.input.productId, error);
    },
  };
}
