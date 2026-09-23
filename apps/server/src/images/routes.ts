import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { CreativeAction, GenerateBatchInput, ImportShopifyPhotosInput, PromptTemplateInput, ShopifyMediaInput } from '@conveyor/shared';
import type { AppContext } from '../context.ts';
import { creatives, products } from '../db/schema.ts';
import { getBatch, getCreative, listBatches, toCreativeView } from './repo.ts';
import { listShopifyPhotos } from './shopifyPhotos.ts';
import { listTemplates, saveTemplate, setDefaultTemplate, ensureDefaultTemplate } from './prompts.ts';

export function imageRoutes(ctx: AppContext) {
  const r = new Hono();

  /** Start a batch: at most 1 Shopify query (only when the snapshot is stale). Codex costs no requests. */
  r.post('/products/:id/generate', async (c) => {
    const productId = Number(c.req.param('id'));
    const row = ctx.db.select().from(products).where(eq(products.id, productId)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!row.shopifyProductId) return c.json({ error: 'Write the listing first. Creatives are made from the Shopify product.' }, 400);
    const body = GenerateBatchInput.parse({ ...((await c.req.json().catch(() => ({}))) as object), productId });
    return c.json(ctx.worker.enqueue('generate_batch', body, productId), 202);
  });

  r.get('/products/:id/batches', (c) => c.json(listBatches(ctx.db, Number(c.req.param('id')))));
  r.get('/batches/:id', (c) => {
    const b = getBatch(ctx.db, Number(c.req.param('id')));
    return b ? c.json(b) : c.json({ error: 'Not found' }, 404);
  });

  /** `R` regenerates one image; `E` sends it back with an instruction. Both make a one-image batch. */
  r.post('/creatives/:id/regenerate', async (c) => {
    const id = Number(c.req.param('id'));
    const row = getCreative(ctx.db, id);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const { instruction } = z.object({ instruction: z.string().max(2000).nullable().default(null) }).parse((await c.req.json().catch(() => ({}))) as object);
    if (instruction && row.status !== 'finished') return c.json({ error: 'Only a finished image can be edited.' }, 400);
    const job = ctx.worker.enqueue('generate_batch', GenerateBatchInput.parse({ productId: row.productId, regenerate: { creativeId: id, instruction } }), row.productId);
    return c.json(job, 202);
  });

  /** Approve, reject or clear. Approving moves the product to "ready to launch". Local only. */
  r.post('/creatives/:id/:action', async (c) => {
    const id = Number(c.req.param('id'));
    const action = CreativeAction.parse(c.req.param('action'));
    const row = getCreative(ctx.db, id);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (row.status !== 'finished') return c.json({ error: 'Only finished images can be approved or rejected.' }, 400);
    const approval = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'pending';
    ctx.db.update(creatives).set({ approval }).where(eq(creatives.id, id)).run();
    const anyApproved = !!ctx.db.select({ id: creatives.id }).from(creatives).where(and(eq(creatives.productId, row.productId), eq(creatives.approval, 'approved'))).get();
    const product = ctx.db.select().from(products).where(eq(products.id, row.productId)).get()!;
    if (anyApproved && product.state === 'review') ctx.db.update(products).set({ state: 'ready_to_launch', updatedAt: new Date().toISOString() }).where(eq(products.id, row.productId)).run();
    if (!anyApproved && product.state === 'ready_to_launch') ctx.db.update(products).set({ state: 'review', updatedAt: new Date().toISOString() }).where(eq(products.id, row.productId)).run();
    // Optional: an approval also puts the image on the Shopify product (2 Admin requests + 1 upload).
    if (action === 'approve' && !row.shopifyMediaId && ctx.settings.get('images').shopify.addApproved && product.shopifyProductId) {
      ctx.worker.enqueue('shopify_media', ShopifyMediaInput.parse({ productId: row.productId, creativeIds: [id] }), row.productId);
    }
    return c.json(toCreativeView(getCreative(ctx.db, id)!));
  });

  /** The product's own Shopify photos, and the creative each has already become. 0 requests. */
  r.get('/products/:id/shopify-photos', (c) => {
    const list = listShopifyPhotos(ctx.db, Number(c.req.param('id')));
    return list ? c.json(list) : c.json({ error: 'Not found' }, 404);
  });

  /**
   * Import chosen Shopify photos as creatives, so a launch can use the store's own photography.
   * At most 1 Admin request (the snapshot, only when stale) plus one CDN download per photo.
   */
  r.post('/products/:id/shopify-photos/import', async (c) => {
    const productId = Number(c.req.param('id'));
    const row = ctx.db.select().from(products).where(eq(products.id, productId)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!row.shopifyProductId) return c.json({ error: 'This product is not in Shopify yet.' }, 400);
    const body = ImportShopifyPhotosInput.parse({ ...((await c.req.json().catch(() => ({}))) as object), productId });
    return c.json(ctx.worker.enqueue('import_shopify_photos', body, productId), 202);
  });

  /** Add finished images to the Shopify product: 2 Admin requests plus one storage upload per image. */
  r.post('/products/:id/shopify-media', async (c) => {
    const productId = Number(c.req.param('id'));
    const row = ctx.db.select().from(products).where(eq(products.id, productId)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!row.shopifyProductId) return c.json({ error: 'This product is not in Shopify yet.' }, 400);
    const body = ShopifyMediaInput.parse({ ...((await c.req.json().catch(() => ({}))) as object), productId });
    return c.json(ctx.worker.enqueue('shopify_media', body, productId), 202);
  });

  /** Image bytes for the gallery. Local files, served only on loopback. */
  const serve = (which: 'finishedPath' | 'originalPath') => (c: Context) => {
    const row = getCreative(ctx.db, Number(c.req.param('id')));
    const file = row?.[which];
    if (!file || !fs.existsSync(file)) return c.json({ error: 'Not found' }, 404);
    const type = which === 'finishedPath' ? 'image/jpeg' : `image/${row.detectedFormat === 'jpeg' ? 'jpeg' : (row.detectedFormat ?? 'png')}`;
    c.header('content-type', type);
    c.header('cache-control', 'private, max-age=3600');
    return c.body(fs.readFileSync(file));
  };
  r.get('/creatives/:id/file', serve('finishedPath'));
  r.get('/creatives/:id/original', serve('originalPath'));

  // Prompt templates: versioned; saving writes a new version.
  r.get('/prompt-templates', (c) => {
    ensureDefaultTemplate(ctx.db);
    return c.json(listTemplates(ctx.db));
  });
  r.post('/prompt-templates', async (c) => c.json(saveTemplate(ctx.db, PromptTemplateInput.parse(await c.req.json())), 201));
  r.put('/prompt-templates/:id', async (c) => c.json(saveTemplate(ctx.db, PromptTemplateInput.parse(await c.req.json()), Number(c.req.param('id')))));
  r.post('/prompt-templates/:id/default', (c) => c.json(setDefaultTemplate(ctx.db, Number(c.req.param('id')))));

  return r;
}
