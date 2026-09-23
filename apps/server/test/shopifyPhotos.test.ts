import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { ShopifySnapshot, Template, type ShopifyPhotoList } from '@conveyor/shared';
import { createApp } from '../src/app.ts';
import { productLaunch } from '../src/db/schema.ts';
import { creativeBatches, creatives, products, requests } from '../src/db/schema.ts';
import { exiftoolAvailable, exiftoolClean } from '../src/images/exiftool.ts';
import { defaultCreativeIds, savePlan } from '../src/meta/plan.ts';
import { FIXTURES, fakeFetch, fixture, json, testContext } from './helpers.ts';

const SQUARE = fs.readFileSync(path.join(FIXTURES, 'images', 'codex-mug.png'));
/** A portrait store photo: the 1:1 frame has to crop it, which the import flags. */
const TALL = await sharp({ create: { width: 900, height: 1600, channels: 3, background: '#cfd3d8' } }).png().toBuffer();

const PHOTOS = [
  { id: 'gid://shopify/MediaImage/9001', url: 'https://cdn.shopify.com/s/files/1/blazer-1.jpg', altText: 'front', width: 2000, height: 2000 },
  { id: 'gid://shopify/MediaImage/9002', url: 'https://cdn.shopify.com/s/files/1/blazer-2.jpg', altText: null, width: 2000, height: 2000 },
  { id: 'gid://shopify/MediaImage/9003', url: 'https://cdn.shopify.com/s/files/1/blazer-3.jpg', altText: null, width: 900, height: 1600 },
];

const SNAPSHOT = ShopifySnapshot.parse({
  id: 'gid://shopify/Product/8001', handle: 'linen-oversized-blazer', title: 'Linen Oversized Blazer', status: 'ACTIVE', descriptionHtml: '<p>x</p>', productType: 'Blazers', tags: [], vendor: 'conveyor', onlineStoreUrl: null,
  featuredImage: PHOTOS[0]!.url, images: PHOTOS, options: [],
  variants: [{ id: 'v1', title: 'S', sku: null, priceMinor: 8999, compareAtPriceMinor: null, imageId: null }],
  currency: 'USD', updatedAt: '2026-09-15T10:00:00Z', fetchedAt: new Date().toISOString(),
});

const ok = (body: Buffer) => new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'image/png' } });

/** The Shopify CDN answers with a real image; the third photo is the tall one. */
async function setup(snapshotAgeMin: number, opts: { down?: () => boolean } = {}) {
  const ff = fakeFetch({
    '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')),
    'graphql.json': () => json(fixture('shopify/product.json')),
    // The ledger retries a 5xx once, so a photo only fails when its route stays down.
    'blazer-1.jpg': () => (opts.down?.() ? new Response('nope', { status: 500 }) : ok(SQUARE)),
    'blazer-3.jpg': () => ok(TALL),
    'cdn.shopify.com': () => ok(SQUARE),
  });
  const ctx = testContext(ff.impl);
  await ctx.secrets.set('shopify_client_id', 'cid');
  await ctx.secrets.set('shopify_client_secret', 'shpss_secret1234567890');
  ctx.settings.set('connections', { shopify: { storeDomain: 'ashworth-studio.myshopify.com' } });
  const snapshotAt = new Date(Date.now() - snapshotAgeMin * 60_000).toISOString();
  const pid = ctx.db
    .insert(products)
    .values({ origin: 'shopify', state: 'review', shopifyProductId: 'gid://shopify/Product/8001', shopifyHandle: 'linen-oversized-blazer', title: 'Linen Oversized Blazer', snapshot: { ...SNAPSHOT, fetchedAt: snapshotAt }, snapshotAt })
    .returning({ id: products.id })
    .get().id;
  const app = createApp(ctx);
  const importPhotos = (mediaIds: string[]) => app.request(`/api/products/${pid}/shopify-photos/import`, { method: 'POST', body: JSON.stringify({ mediaIds }), headers: { 'content-type': 'application/json' } });
  const admin = () => ctx.db.select().from(requests).all().filter((r) => r.service === 'shopify' && r.purpose !== 'access_token');
  const cdn = () => ctx.db.select().from(requests).all().filter((r) => r.service === 'cdn');
  return { ctx, app, pid, ff, importPhotos, admin, cdn };
}

describe('importing Shopify photos as creatives', () => {
  it('finishes chosen photos as approved 1:1 JPEGs a launch can use, for 1 query and 1 download each', async () => {
    const t = await setup(30);
    const res = await t.importPhotos([PHOTOS[1]!.id, PHOTOS[0]!.id]);
    expect(res.status).toBe(202);
    await t.ctx.worker.drain();

    const job = t.ctx.worker.list()[0]!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    expect(job.completedSteps).toEqual(['snapshot', 'plan', 'fetch', 'finish']);
    // One Admin query for the stale snapshot; the photos come from the image CDN, not the API.
    expect(t.admin().map((r) => r.purpose)).toEqual(['product_snapshot']);
    expect(t.cdn().map((r) => r.purpose)).toEqual(['shopify_photo_import', 'shopify_photo_import']);
    expect(t.ff.calls.some((c) => /openai|anthropic|rapidapi|graph.facebook/.test(c.url))).toBe(false);

    const rows = t.ctx.db.select().from(creatives).all();
    expect(rows).toHaveLength(2);
    // Chosen order is kept, and the slots continue the product-wide 1:1 numbering.
    expect(rows.map((r) => r.sourceMediaId)).toEqual([PHOTOS[1]!.id, PHOTOS[0]!.id]);
    expect(rows.map((r) => r.fileName)).toEqual(['linen-oversized-blazer_1x1_01.jpg', 'linen-oversized-blazer_1x1_02.jpg']);
    for (const r of rows) {
      expect(r).toMatchObject({ status: 'finished', approval: 'approved', aspect: '1:1', width: 1080, height: 1080 });
      expect(r.metadataCheck?.startsWith('clean')).toBe(true);
      expect(r.flags).toEqual([]);
      // It is already on the Shopify product, so "add approved to Shopify" never sends it back.
      expect(r.shopifyMediaId).toBe(r.sourceMediaId);
      expect(fs.existsSync(r.finishedPath!)).toBe(true);
      expect(fs.readFileSync(r.finishedPath!).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      const m = await sharp(r.finishedPath!).metadata();
      expect([m.width, m.height, m.exif, m.xmp, m.icc]).toEqual([1080, 1080, undefined, undefined, undefined]);
      if (await exiftoolAvailable()) expect((await exiftoolClean(r.finishedPath!)).ok).toBe(true);
    }

    const batch = t.ctx.db.select().from(creativeBatches).all()[0]!;
    expect(batch).toMatchObject({ engine: 'shopify', status: 'done', apiRequests: 1, countPerFormat: 2 });

    // The point of the feature: with no choice saved, a launch uses these like any approved image.
    expect(defaultCreativeIds(t.ctx.db, t.pid)).toEqual(rows.map((r) => r.id));
    const p = (await (await t.app.request(`/api/products/${t.pid}`)).json()) as { state: string };
    expect(p.state).toBe('ready_to_launch');
    await t.ctx.close();
  });

  it('a fresh snapshot costs 0 queries, a non-square photo is flagged, and a repeat import is skipped', async () => {
    const t = await setup(2);
    await t.importPhotos([PHOTOS[2]!.id]);
    await t.ctx.worker.drain();
    expect(t.admin()).toHaveLength(0);

    const tall = t.ctx.db.select().from(creatives).all()[0]!;
    expect(tall).toMatchObject({ status: 'finished', width: 1080, height: 1080, flags: ['cropped'] });

    // Importing the same photo again adds nothing: the job refuses rather than duplicating it.
    const again = await t.importPhotos([PHOTOS[2]!.id]);
    expect(again.status).toBe(202);
    await t.ctx.worker.drain();
    expect(t.ctx.db.select().from(creatives).all()).toHaveLength(1);
    const failed = t.ctx.worker.list().find((j) => j.status === 'failed')!;
    expect(failed.error?.message).toContain('None of the chosen photos');

    // A mixed list still imports the new one and keeps going.
    await t.importPhotos([PHOTOS[2]!.id, PHOTOS[0]!.id]);
    await t.ctx.worker.drain();
    const names = t.ctx.db.select().from(creatives).all().map((r) => r.fileName);
    expect(names).toEqual(['linen-oversized-blazer_1x1_01.jpg', 'linen-oversized-blazer_1x1_02.jpg']);
    await t.ctx.close();
  });

  it('joins a saved launch plan, so an imported photo actually reaches Meta', async () => {
    const t = await setup(2);
    // A product that has already been launched once has an explicit list of creatives. Without
    // this, an imported photo sat in the gallery approved and was never sent.
    const template = Template.parse(fixture('templates/ashworth-cbo.json'));
    savePlan(t.ctx.db, t.pid, 1, { template, creativeIds: [4242] });

    await t.importPhotos([PHOTOS[0]!.id, PHOTOS[1]!.id]);
    await t.ctx.worker.drain();

    const imported = t.ctx.db.select().from(creatives).all().map((r) => r.id);
    const saved = t.ctx.db.select().from(productLaunch).where(eq(productLaunch.productId, t.pid)).get()!;
    // The earlier choice keeps its place; the photos are appended in the order they were picked.
    expect(saved.creativeIds).toEqual([4242, ...imported]);
    await t.ctx.close();
  });

  it('lists the product photos with the creative each became, without any request', async () => {
    const t = await setup(2);
    const before = (await (await t.app.request(`/api/products/${t.pid}/shopify-photos`)).json()) as ShopifyPhotoList;
    expect(before.photos.map((p) => p.creativeId)).toEqual([null, null, null]);
    expect(before.photos.map((p) => p.square)).toEqual([true, true, false]);
    expect(before.stale).toBe(false);

    await t.importPhotos([PHOTOS[0]!.id]);
    await t.ctx.worker.drain();
    const after = (await (await t.app.request(`/api/products/${t.pid}/shopify-photos`)).json()) as ShopifyPhotoList;
    expect(after.photos[0]!.fileName).toBe('linen-oversized-blazer_1x1_01.jpg');
    expect(after.photos[0]!.approval).toBe('approved');
    expect(after.photos.slice(1).map((p) => p.creativeId)).toEqual([null, null]);
    // Listing is local: only the import's own download shows in the ledger.
    expect(t.admin()).toHaveLength(0);
    expect(t.cdn()).toHaveLength(1);
    await t.ctx.close();
  });

  it('leaves a retry able to fetch only what is missing when the CDN fails', async () => {
    let down = true;
    const t = await setup(2, { down: () => down });
    await t.importPhotos([PHOTOS[0]!.id, PHOTOS[1]!.id]);
    await t.ctx.worker.drain();

    const job = t.ctx.worker.list()[0]!;
    expect(job.status).toBe('failed');
    const rows = () => t.ctx.db.select().from(creatives).all();
    expect(rows().filter((r) => r.status === 'finished')).toHaveLength(1);
    expect(t.ctx.db.select().from(creativeBatches).all()[0]!.status).toBe('partial');

    down = false;
    await t.app.request(`/api/jobs/${job.id}/retry`, { method: 'POST' });
    await t.ctx.worker.drain();
    expect(rows().every((r) => r.status === 'finished' && r.approval === 'approved')).toBe(true);
    await t.ctx.close();
  });
});
