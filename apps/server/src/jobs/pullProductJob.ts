import { eq } from 'drizzle-orm';
import { PullProductInput, type JobError } from '@conveyor/shared';
import { products } from '../db/schema.ts';
import { markAttention, setState } from '../products/repo.ts';
import type { ShopifyClient } from '../shopify/client.ts';
import { readSnapshot, readSnapshotByHandle, storeSnapshot } from '../shopify/snapshot.ts';
import { JobStepError } from './types.ts';
import type { JobDefinition } from './types.ts';

/** "Add a product already in Shopify", and the Launch tab's re-read: one query, saved as the product's snapshot. */
export function pullProductJob(deps: { shopify: ShopifyClient }): JobDefinition<PullProductInput> {
  return {
    type: 'pull_product',
    input: PullProductInput,
    steps: [
      {
        name: 'snapshot',
        async run(ctx) {
          const read = ctx.input.shopifyProductId
            ? await readSnapshot(deps.shopify, ctx.input.shopifyProductId, { productId: ctx.productId, jobId: ctx.jobId })
            : await readSnapshotByHandle(deps.shopify, ctx.input.handle!, { productId: ctx.productId, jobId: ctx.jobId });
          const { snapshot, requestId } = read;
          if (!snapshot) throw new JobStepError(`No Shopify product has the handle "${ctx.input.handle}".`, { service: 'shopify', requestId, suggestion: 'Check the destination URL in the template, or add the product from Shopify by name.' });
          storeSnapshot(ctx.db, ctx.productId!, snapshot);
          ctx.log(`Read ${snapshot.title} from Shopify (1 query): ${snapshot.images.length} images, ${snapshot.variants.length} variants.`, 'info', requestId);
          return { handle: snapshot.handle, fetchedAt: snapshot.fetchedAt };
        },
      },
      {
        name: 'finish',
        async run(ctx) {
          // A re-read only replaces the snapshot; a product further down the line keeps the state it is in.
          if (ctx.input.refresh) ctx.db.update(products).set({ failure: null }).where(eq(products.id, ctx.productId!)).run();
          else setState(ctx.db, ctx.productId!, 'from_shopify', { failure: null });
          return null;
        },
      },
    ],
    onError(ctx, error: JobError) {
      if (ctx.productId != null) markAttention(ctx.db, ctx.productId, error);
    },
  };
}
