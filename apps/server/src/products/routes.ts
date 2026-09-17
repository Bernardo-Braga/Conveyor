import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { AddToLineInput, FromHandleInput, Platform, type AddToLineResult, type ShopifySearchHit } from '@conveyor/shared';
import type { AppContext } from '../context.ts';
import { jobs, products } from '../db/schema.ts';
import { JobStepError } from '../jobs/types.ts';
import { searchShopify } from '../shopify/search.ts';
import { isShortLink, looksLikeUrl, parseLink, resolveShortLink } from '../suppliers/parseLink.ts';
import { listProducts, productDetail } from './repo.ts';

const FromShopify = z.object({ shopifyProductId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/) });

export function productRoutes(ctx: AppContext) {
  const r = new Hono();

  /** The input bar. A link is parsed locally; a name searches Shopify (1 query). */
  r.post('/line', async (c) => {
    const { text } = AddToLineInput.parse(await c.req.json());
    if (looksLikeUrl(text)) {
      let link = text;
      if (isShortLink(text)) link = (await resolveShortLink(ctx.ledger, text)) ?? text; // 1 redirect request, not RapidAPI
      const parsed = parseLink(link);
      if (!parsed) return c.json<AddToLineResult>({ kind: 'unsupported', message: 'Only AliExpress item links and 1688 offer links are supported. Nothing was requested.' });
      const existing = ctx.db.select({ id: products.id }).from(products).where(and(eq(products.platform, parsed.platform), eq(products.itemId, parsed.itemId))).get();
      if (existing) return c.json<AddToLineResult>({ kind: 'duplicate', productId: existing.id }); // 0 requests
      const row = ctx.db.insert(products).values({ origin: 'link', platform: parsed.platform, itemId: parsed.itemId, sourceUrl: link, state: 'importing' }).returning().get();
      const job = ctx.worker.enqueue('import', { productId: row.id, platform: parsed.platform, itemId: parsed.itemId, url: link, refresh: false }, row.id);
      return c.json<AddToLineResult>({ kind: 'importing', productId: row.id, jobId: job.id }, 202);
    }
    const { hits } = await searchShopify(ctx.shopify, text);
    const onLine = new Map(ctx.db.select({ id: products.id, sid: products.shopifyProductId }).from(products).all().filter((p) => p.sid).map((p) => [p.sid!, p.id]));
    const results: ShopifySearchHit[] = hits.map((h) => ({ ...h, onLine: onLine.get(h.id) ?? null }));
    return c.json<AddToLineResult>({ kind: 'search', query: text, results });
  });

  /** Pick a Shopify search result: creates the product and reads its snapshot (1 query). */
  r.post('/line/from-shopify', async (c) => {
    const { shopifyProductId } = FromShopify.parse(await c.req.json());
    const existing = ctx.db.select({ id: products.id }).from(products).where(eq(products.shopifyProductId, shopifyProductId)).get();
    if (existing) return c.json<AddToLineResult>({ kind: 'duplicate', productId: existing.id });
    const row = ctx.db.insert(products).values({ origin: 'shopify', shopifyProductId, state: 'from_shopify' }).returning().get();
    const job = ctx.worker.enqueue('pull_product', { productId: row.id, shopifyProductId }, row.id);
    return c.json<AddToLineResult>({ kind: 'importing', productId: row.id, jobId: job.id }, 202);
  });

  /** A template's product by its URL handle: local when it is on the Line, otherwise 1 Shopify query. */
  r.post('/line/from-handle', async (c) => {
    const { handle } = FromHandleInput.parse(await c.req.json());
    const existing = ctx.db.select({ id: products.id }).from(products).where(eq(products.shopifyHandle, handle)).get();
    if (existing) return c.json<AddToLineResult>({ kind: 'duplicate', productId: existing.id });
    const row = ctx.db.insert(products).values({ origin: 'shopify', shopifyHandle: handle, state: 'from_shopify' }).returning().get();
    const job = ctx.worker.enqueue('pull_product', { productId: row.id, shopifyProductId: null, handle }, row.id);
    return c.json<AddToLineResult>({ kind: 'importing', productId: row.id, jobId: job.id }, 202);
  });

  r.get('/products', (c) => c.json(listProducts(ctx.db)));
  r.get('/products/:id', (c) => {
    const d = productDetail(ctx.db, Number(c.req.param('id')));
    return d ? c.json(d) : c.json({ error: 'Not found' }, 404);
  });
  r.get('/products/:id/jobs', (c) => {
    const id = Number(c.req.param('id'));
    return c.json(ctx.db.select().from(jobs).where(eq(jobs.productId, id)).orderBy(desc(jobs.id)).limit(20).all().map((j) => ctx.worker.view(j.id)));
  });

  /** Explicit refresh of supplier data: 1 RapidAPI request. */
  r.post('/products/:id/refresh-supplier', (c) => {
    const id = Number(c.req.param('id'));
    const row = ctx.db.select().from(products).where(eq(products.id, id)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!row.platform || !row.itemId) return c.json({ error: 'This product did not come from a supplier link.' }, 400);
    const job = ctx.worker.enqueue('import', { productId: id, platform: Platform.parse(row.platform), itemId: row.itemId, url: row.sourceUrl ?? '', refresh: true }, id);
    return c.json(job, 202);
  });

  /** Write the listing and create the Shopify draft (2 requests), or rewrite an existing draft (2 requests). */
  r.post('/products/:id/write-listing', async (c) => {
    const id = Number(c.req.param('id'));
    const row = ctx.db.select().from(products).where(eq(products.id, id)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    const rewrite = !!row.shopifyProductId;
    return c.json(ctx.worker.enqueue('write_listing', { productId: id, rewrite }, id), 202);
  });

  /** Retry the product's latest failed job from its failed step. 0 repeated requests. */
  r.post('/products/:id/retry', (c) => {
    const id = Number(c.req.param('id'));
    const last = ctx.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.productId, id), eq(jobs.status, 'failed'))).orderBy(desc(jobs.id)).limit(1).get();
    if (!last) return c.json({ error: 'No failed job to retry.' }, 400);
    return c.json(ctx.worker.retry(last.id), 202);
  });

  /** Remove from the Line. Local only; the raw supplier response is kept. */
  r.delete('/products/:id', (c) => {
    const id = Number(c.req.param('id'));
    ctx.db.delete(products).where(eq(products.id, id)).run();
    return c.json({ ok: true });
  });

  r.get('/quota', (c) => {
    const threshold = ctx.settings.get('import').quotaPauseThreshold;
    return c.json(Platform.options.map((p) => ctx.quota.view(p, threshold)));
  });

  r.onError((err, c) => {
    if (err instanceof JobStepError) return c.json({ error: err.message, suggestion: err.details.suggestion, code: err.details.code, requestId: err.details.requestId }, 502);
    throw err;
  });
  return r;
}
