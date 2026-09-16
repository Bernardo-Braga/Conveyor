import { PullProductInput, type JobError } from '@conveyor/shared';
import { markAttention, setState } from '../products/repo.ts';
import type { ShopifyClient } from '../shopify/client.ts';
import { readSnapshot, storeSnapshot } from '../shopify/snapshot.ts';
import type { JobDefinition } from './types.ts';

/** "Add a product already in Shopify": one query, saved as the product's snapshot. */
export function pullProductJob(deps: { shopify: ShopifyClient }): JobDefinition<PullProductInput> {
  return {
    type: 'pull_product',
    input: PullProductInput,
    steps: [
      {
        name: 'snapshot',
        async run(ctx) {
          const { snapshot, requestId } = await readSnapshot(deps.shopify, ctx.input.shopifyProductId, { productId: ctx.productId, jobId: ctx.jobId });
          storeSnapshot(ctx.db, ctx.productId!, snapshot);
          ctx.log(`Read ${snapshot.title} from Shopify (1 query): ${snapshot.images.length} images, ${snapshot.variants.length} variants.`, 'info', requestId);
          return { handle: snapshot.handle, fetchedAt: snapshot.fetchedAt };
        },
      },
      {
        name: 'finish',
        async run(ctx) {
          setState(ctx.db, ctx.productId!, 'from_shopify', { failure: null });
          return null;
        },
      },
    ],
    onError(ctx, error: JobError) {
      if (ctx.productId != null) markAttention(ctx.db, ctx.productId, error);
    },
  };
}
