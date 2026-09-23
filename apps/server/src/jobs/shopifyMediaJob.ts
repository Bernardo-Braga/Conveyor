import fs from 'node:fs/promises';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { ShopifyMediaInput, ShopifySnapshot } from '@conveyor/shared';
import { creatives, products } from '../db/schema.ts';
import type { ShopifyClient } from '../shopify/client.ts';
import { altTextFor, attachMedia, stageUploads, stagedFile, uploadStaged, type StagedFile, type StagedTarget } from '../shopify/media.ts';
import { JobStepError, type JobDefinition } from './types.ts';

/**
 * Adds finished creatives to the Shopify product as media. Two Admin requests for any number of
 * images (stage, then attach) plus one storage upload per image. Only finished files are sent,
 * never originals, and an image already on the product is skipped, so a retry never duplicates.
 *
 * Steps: select (local) → stage (1 request) → upload (N storage POSTs) → attach (1 request).
 */
export function shopifyMediaJob(deps: { shopify: ShopifyClient }): JobDefinition<ShopifyMediaInput> {
  return {
    type: 'shopify_media',
    input: ShopifyMediaInput,
    steps: [
      {
        name: 'select',
        async run(ctx) {
          const product = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get();
          if (!product) throw new JobStepError('Product not found.');
          if (!product.shopifyProductId) throw new JobStepError('This product is not in Shopify yet.', { suggestion: 'Write the listing first.' });
          const where = ctx.input.creativeIds.length
            ? and(eq(creatives.productId, product.id), inArray(creatives.id, ctx.input.creativeIds))
            : and(eq(creatives.productId, product.id), eq(creatives.approval, 'approved'));
          const rows = ctx.db.select().from(creatives).where(and(where, eq(creatives.status, 'finished'), isNull(creatives.shopifyMediaId))).all();
          const skipped = ctx.input.creativeIds.length - rows.length;
          if (!rows.length) {
            ctx.log(ctx.input.creativeIds.length ? 'Every chosen image is already on the Shopify product, or is not finished. Nothing to send.' : 'No approved image is waiting to go to Shopify. Nothing to send.');
            return { files: [] as (StagedFile & { creativeId: number; alt: string })[], shopifyProductId: product.shopifyProductId };
          }
          if (skipped > 0) ctx.log(`${skipped} image(s) skipped: already on the product or not finished.`);
          const title = product.snapshot ? ShopifySnapshot.parse(product.snapshot).title : (product.title ?? 'Product');
          const files: (StagedFile & { creativeId: number; alt: string })[] = [];
          for (const r of rows.sort((a, b) => a.aspect.localeCompare(b.aspect) || a.slot - b.slot)) {
            if (!r.finishedPath) continue;
            const stat = await fs.stat(r.finishedPath).catch(() => null);
            if (!stat) {
              ctx.log(`${r.fileName ?? r.id} is missing on disk and was skipped.`, 'warn');
              continue;
            }
            files.push({ ...stagedFile(r.finishedPath, stat.size), creativeId: r.id, alt: altTextFor(title, r.aspect, r.slot) });
          }
          ctx.log(`${files.length} finished image(s) to add to the Shopify product: 2 Admin requests plus ${files.length} storage upload(s).`);
          return { files, shopifyProductId: product.shopifyProductId };
        },
      },
      {
        name: 'stage',
        async run(ctx) {
          const { files } = ctx.prior.select as { files: StagedFile[] };
          if (!files.length) return { targets: [] as StagedTarget[], requests: 0 };
          const { targets, requestId } = await stageUploads(deps.shopify, files, { productId: ctx.input.productId, jobId: ctx.jobId });
          ctx.log(`Shopify issued ${targets.length} upload target(s) (1 request).`, 'info', requestId);
          return { targets, requests: 1 };
        },
      },
      {
        name: 'upload',
        async run(ctx) {
          const { files } = ctx.prior.select as { files: StagedFile[] };
          const { targets } = ctx.prior.stage as { targets: StagedTarget[] };
          for (const [i, f] of files.entries()) {
            await uploadStaged(ctx.ledger, f, targets[i]!, { productId: ctx.input.productId, jobId: ctx.jobId });
            ctx.progress({ done: i + 1, total: files.length });
          }
          if (files.length) ctx.log(`${files.length} file(s) uploaded to Shopify's storage.`);
          return { uploaded: files.length };
        },
      },
      {
        name: 'attach',
        async run(ctx) {
          const { files, shopifyProductId } = ctx.prior.select as { files: (StagedFile & { creativeId: number; alt: string })[]; shopifyProductId: string };
          const { targets } = ctx.prior.stage as { targets: StagedTarget[] };
          if (!files.length) return { attached: 0, requests: 0 };
          const { media, requestId } = await attachMedia(deps.shopify, shopifyProductId, files.map((f, i) => ({ resourceUrl: targets[i]!.resourceUrl, alt: f.alt })), { productId: ctx.input.productId, jobId: ctx.jobId });
          for (const [i, f] of files.entries()) ctx.db.update(creatives).set({ shopifyMediaId: media[i]!.id }).where(eq(creatives.id, f.creativeId)).run();
          ctx.log(`${media.length} image(s) added to the Shopify product (1 request). Shopify finishes processing them in the background.`, 'info', requestId);
          return { attached: media.length, requests: 1 };
        },
      },
    ],
  };
}
