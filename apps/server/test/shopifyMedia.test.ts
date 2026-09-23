import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShopifySnapshot } from '@conveyor/shared';
import { createApp } from '../src/app.ts';
import { creativeBatches, creatives, jobs, products, requests } from '../src/db/schema.ts';
import { FIXTURES, fakeFetch, fixture, json, testContext, type Recorded } from './helpers.ts';

const SNAPSHOT = ShopifySnapshot.parse({
  id: 'gid://shopify/Product/8001', handle: 'loafers', title: 'Loafers', status: 'DRAFT', descriptionHtml: '<p>x</p>', productType: 'Loafers', tags: [], vendor: 'conveyor', onlineStoreUrl: null, featuredImage: null,
  images: [], options: [], variants: [{ id: 'v1', title: '42', sku: null, priceMinor: 8999, compareAtPriceMinor: null, imageId: null }], currency: 'USD', updatedAt: '2026-09-15T10:00:00Z', fetchedAt: new Date().toISOString(),
});
// Any bytes will do: the job sends the finished file as it is and never inspects it.
const JPEG = fs.readFileSync(path.join(FIXTURES, 'images', 'codex-mug.png'));

async function seed(routes: Record<string, (r: Recorded) => Response>) {
  const ff = fakeFetch({ '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')), ...routes });
  const ctx = testContext(ff.impl);
  await ctx.secrets.set('shopify_client_id', 'cid');
  await ctx.secrets.set('shopify_client_secret', 'shpss_secret1234567890');
  ctx.settings.set('connections', { shopify: { storeDomain: 'ashworth-studio.myshopify.com' } });
  const pid = ctx.db.insert(products).values({ origin: 'shopify', state: 'review', shopifyProductId: SNAPSHOT.id, shopifyHandle: SNAPSHOT.handle, title: SNAPSHOT.title, snapshot: SNAPSHOT }).returning({ id: products.id }).get().id;
  const batchId = ctx.db.insert(creativeBatches).values({ productId: pid, prompt: 'P', engine: 'codex', status: 'done', formats: ['1:1'], countPerFormat: 3, handle: SNAPSHOT.handle }).returning({ id: creativeBatches.id }).get().id;
  const dir = path.join(ctx.dataDir, 'products', String(pid), 'finished');
  fs.mkdirSync(dir, { recursive: true });
  const ids: number[] = [];
  for (const slot of [1, 2, 3]) {
    const file = path.join(dir, `loafers_1x1_0${slot}.jpg`);
    fs.writeFileSync(file, JPEG);
    ids.push(ctx.db.insert(creatives).values({ batchId, productId: pid, aspect: '1:1', slot, status: 'finished', approval: slot === 3 ? 'pending' : 'approved', finishedPath: file, fileName: path.basename(file), bytes: JPEG.length }).returning({ id: creatives.id }).get().id);
  }
  return { ctx, ff, pid, ids, gql: () => ff.calls.filter((c) => c.url.includes('graphql.json')), uploads: () => ff.calls.filter((c) => c.url.includes('storage.googleapis.com')) };
}

describe('adding finished images to the Shopify product', () => {
  it('sends the approved images with 2 Admin requests and one upload each, and records the media ids', async () => {
    const t = await seed({
      'graphql.json': (r) => json(fixture(r.body!.includes('stagedUploadsCreate') ? 'shopify/stagedUploadsCreate.json' : 'shopify/productCreateMedia.json'), 200, { 'x-request-id': 'shop-media-1' }),
      'storage.googleapis.com': () => new Response('', { status: 201 }),
    });
    const app = createApp(t.ctx);
    const res = await app.request(`/api/products/${t.pid}/shopify-media`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(202);
    await t.ctx.worker.drain();

    const job = t.ctx.worker.list()[0]!;
    expect(job.status).toBe('done');
    expect(job.completedSteps).toEqual(['select', 'stage', 'upload', 'attach']);
    expect(t.gql()).toHaveLength(2);
    expect(t.uploads()).toHaveLength(2);

    // Stage asks for every file at once; the upload form carries Shopify's parameters, then the file.
    const stage = JSON.parse(t.gql()[0]!.body!) as { variables: { input: { resource: string; filename: string; mimeType: string; httpMethod: string; fileSize: string }[] } };
    expect(stage.variables.input.map((i) => i.filename)).toEqual(['loafers_1x1_01.jpg', 'loafers_1x1_02.jpg']);
    expect(stage.variables.input[0]).toMatchObject({ resource: 'IMAGE', mimeType: 'image/jpeg', httpMethod: 'POST', fileSize: String(JPEG.length) });
    const form = t.uploads()[0]!.form!;
    expect(Object.keys(form)).toEqual(['key', 'policy', 'x-goog-signature', 'file']);
    expect((form.file as { name: string; type: string; size: number }[])[0]).toMatchObject({ name: 'loafers_1x1_01.jpg', type: 'image/jpeg', size: JPEG.length });

    // Attach uses the staged resource URLs, in order, with alt text and IMAGE type.
    const attach = JSON.parse(t.gql()[1]!.body!) as { variables: { productId: string; media: { originalSource: string; mediaContentType: string; alt: string }[] } };
    expect(attach.variables.productId).toBe(SNAPSHOT.id);
    expect(attach.variables.media.map((m) => m.originalSource)).toEqual([expect.stringContaining('loafers_1x1_01.jpg'), expect.stringContaining('loafers_1x1_02.jpg')]);
    expect(attach.variables.media[0]).toMatchObject({ mediaContentType: 'IMAGE', alt: `${SNAPSHOT.title} (1:1, image 1)` });

    const rows = t.ctx.db.select().from(creatives).orderBy(creatives.slot).all();
    expect(rows.map((r) => r.shopifyMediaId)).toEqual(['gid://shopify/MediaImage/7001', 'gid://shopify/MediaImage/7002', null]);
    // The ledger attributes the Admin calls to Shopify and the storage POSTs to the CDN bucket, never with a token.
    const ledger = t.ctx.db.select().from(requests).all();
    expect(ledger.filter((r) => r.service === 'shopify' && r.purpose !== 'access_token')).toHaveLength(2);
    expect(ledger.filter((r) => r.service === 'cdn' && r.purpose === 'shopify_staged_upload')).toHaveLength(2);

    // A second send finds nothing new and makes no request at all.
    await app.request(`/api/products/${t.pid}/shopify-media`, { method: 'POST', body: '{}' });
    await t.ctx.worker.drain();
    expect(t.gql()).toHaveLength(2);
    expect(t.ctx.worker.list()[0]!.status).toBe('done');
    await t.ctx.close();
  });

  it('a media error names the step and quotes Shopify, and a retry resumes without re-uploading', async () => {
    let attachCalls = 0;
    const t = await seed({
      'graphql.json': (r) => {
        if (r.body!.includes('stagedUploadsCreate')) return json(fixture('shopify/stagedUploadsCreate.json'));
        attachCalls += 1;
        return json(fixture(attachCalls === 1 ? 'shopify/productCreateMedia-error.json' : 'shopify/productCreateMedia.json'), 200, { 'x-request-id': `shop-media-${attachCalls}` });
      },
      'storage.googleapis.com': () => new Response('', { status: 201 }),
    });
    const app = createApp(t.ctx);
    await app.request(`/api/products/${t.pid}/shopify-media`, { method: 'POST', body: JSON.stringify({ creativeIds: [t.ids[0], t.ids[1]] }) });
    await t.ctx.worker.drain();
    const failed = t.ctx.worker.list()[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ step: 'attach', service: 'shopify', code: 'MEDIA_CANNOT_BE_MODIFIED', requestId: 'shop-media-1' });
    expect(failed.error!.message).toContain('currently being processed');

    t.ctx.worker.retry(failed.id);
    await t.ctx.worker.drain();
    expect(t.ctx.worker.list()[0]!.status).toBe('done');
    expect(t.uploads()).toHaveLength(2); // the upload step had its checkpoint; only attach ran again
    expect(t.gql()).toHaveLength(3);
    await t.ctx.close();
  });

  it('approving an image sends it on its own when the setting is on, and not otherwise', async () => {
    const t = await seed({
      'graphql.json': (r) => json(fixture(r.body!.includes('stagedUploadsCreate') ? 'shopify/stagedUploadsCreate.json' : 'shopify/productCreateMedia.json')),
      'storage.googleapis.com': () => new Response('', { status: 201 }),
    });
    const app = createApp(t.ctx);
    await app.request(`/api/creatives/${t.ids[2]}/approve`, { method: 'POST' });
    expect(t.ctx.worker.list()).toHaveLength(0);

    t.ctx.settings.set('images', { ...t.ctx.settings.get('images'), shopify: { addApproved: true } });
    await app.request(`/api/creatives/${t.ids[2]}/unapprove`, { method: 'POST' });
    await app.request(`/api/creatives/${t.ids[2]}/approve`, { method: 'POST' });
    const list = t.ctx.worker.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: 'shopify_media', productId: t.pid });
    expect((t.ctx.db.select().from(jobs).all()[0]!.input as { creativeIds: number[] }).creativeIds).toEqual([t.ids[2]]);
    await t.ctx.close();
  });
});
