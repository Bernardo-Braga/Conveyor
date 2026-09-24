import { ImportJobInput, type JobError } from '@conveyor/shared';
import { eq } from 'drizzle-orm';
import { supplierRaw } from '../db/schema.ts';
import { markAttention, setState } from '../products/repo.ts';
import { mapItem } from '../suppliers/mapItem.ts';
import type { QuotaStore } from '../suppliers/quota.ts';
import { dataHubStatus, type RapidApiClient } from '../suppliers/rapidapi.ts';
import { latestRaw } from '../suppliers/supplierRaw.ts';
import { JobStepError, type JobDefinition } from './types.ts';

/**
 * Station 1. Parsing and the duplicate check happen before the job
 * exists (in the route, 0 requests). The job: quota → fetch (saves raw first) → map → finish.
 * Only `fetch` leaves the machine, and it reuses a saved response unless `refresh` is set.
 */
export function importJob(deps: { rapidapi: RapidApiClient; quota: QuotaStore; enqueue: (type: 'write_listing', input: unknown, productId: number) => { id: number }; autoListing?: boolean }): JobDefinition<ImportJobInput> {
  return {
    type: 'import',
    input: ImportJobInput,
    steps: [
      {
        name: 'quota',
        async run(ctx) {
          const { platform, itemId, refresh } = ctx.input;
          if (!refresh && latestRaw(ctx.db, platform, itemId)?.httpStatus === 200) {
            ctx.log('A saved supplier response exists; no quota needed.');
            return { skipped: true };
          }
          const threshold = ctx.settings.get('import').quotaPauseThreshold;
          const g = deps.quota.guard(platform, threshold);
          if (!g.ok) throw new JobStepError(g.reason, { service: 'rapidapi', suggestion: 'Raise the pause threshold or wait for the reset. No request was made.', retryable: true });
          const q = deps.quota.get(platform);
          ctx.log(q.remaining == null ? 'Quota unknown until the first response.' : `Quota ${q.remaining} remaining, threshold ${threshold}.`);
          return { remaining: q.remaining };
        },
      },
      {
        name: 'fetch',
        async run(ctx) {
          const { platform, itemId, refresh } = ctx.input;
          if (!refresh) {
            const saved = latestRaw(ctx.db, platform, itemId);
            if (saved?.httpStatus === 200) {
              if (savedIsUsable(saved.body)) {
                ctx.log(`Reusing the supplier response saved ${saved.fetchedAt}. 0 requests.`);
                return { rawId: saved.id, reused: true };
              }
            }
          }
          const res = await deps.rapidapi.fetchItem(platform, itemId, { productId: ctx.productId, jobId: ctx.jobId });
          const q = deps.quota.get(platform);
          // A 205 from item_detail is answered by a backup endpoint, which costs one more request.
          if (res.requests > 1) ctx.log(`item_detail found no results (205), so ${res.endpoint} answered instead. That is ${res.requests} requests for this item, not 1.`, 'warn');
          ctx.log(`Fetched item ${itemId} from RapidAPI (${res.requests} request${res.requests === 1 ? '' : 's'}). Raw saved as #${res.rawId}.${q.remaining != null ? ` Quota ${q.remaining} remaining.` : ''}`, 'info', res.requestId);
          return { rawId: res.rawId, reused: false };
        },
      },
      {
        name: 'map',
        async run(ctx) {
          const { rawId } = ctx.prior.fetch as { rawId: number };
          const raw = ctx.db.select().from(supplierRaw).where(eq(supplierRaw.id, rawId)).get();
          if (!raw) throw new JobStepError(`Saved response #${rawId} is missing.`, { suggestion: 'Use "Refresh supplier data" to fetch it again (1 request).' });
          let body: unknown;
          try {
            body = JSON.parse(raw.body);
          } catch {
            throw new JobStepError('The saved supplier response is not JSON.', { suggestion: 'Use "Refresh supplier data" (1 request).' });
          }
          let source;
          try {
            source = mapItem(ctx.input.platform, body, { itemId: ctx.input.itemId, url: ctx.input.url });
          } catch (err) {
            throw new JobStepError(`Could not map the ${ctx.input.platform} response: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`, {
              suggestion: 'The raw response is saved. Fix the mapper and retry this step; no request is needed.',
              retryable: true,
            });
          }
          if (!source.title) throw new JobStepError('The supplier response has no title.', { suggestion: 'Inspect the saved raw response. Retrying costs nothing.', retryable: true });
          setState(ctx.db, ctx.productId!, 'importing', { source, sourceRawId: rawId, title: source.title, moq: source.moq ?? null, failure: null });
          ctx.log(`Mapped: ${source.images.length} images, ${source.options.length} options, ${source.variants.length} variants, ${source.currency}.`);
          return { images: source.images.length, variants: source.variants.length };
        },
      },
      {
        name: 'finish',
        async run(ctx) {
          setState(ctx.db, ctx.productId!, 'writing_listing');
          if (ctx.input.refresh && !deps.autoListing) {
            ctx.log('Supplier data refreshed. Use "Rewrite listing" to update the draft (2 requests).');
            return { listingJobId: null };
          }
          const job = deps.enqueue('write_listing', { productId: ctx.productId!, rewrite: ctx.input.refresh }, ctx.productId!);
          ctx.log(`Ready for the listing step. Queued write_listing job #.`);
          return { listingJobId: job.id };
        },
      },
    ],
    onError(ctx, error: JobError) {
      if (ctx.productId != null) markAttention(ctx.db, ctx.productId, error);
    },
  };
}

function savedIsUsable(body: string): boolean {
  try {
    return dataHubStatus(JSON.parse(body)).ok;
  } catch {
    return false;
  }
}
