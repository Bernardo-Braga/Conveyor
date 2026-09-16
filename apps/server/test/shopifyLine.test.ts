import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { requests } from '../src/db/schema.ts';
import { readSnapshot } from '../src/shopify/snapshot.ts';
import { fakeFetch, fixture, json, testContext } from './helpers.ts';

async function setup() {
  const ff = fakeFetch({
    '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')),
    '/admin/api/2026-07/graphql.json': (req) => (req.body!.includes('ConveyorSearch') ? json(fixture('shopify/search.json')) : json(fixture('shopify/product.json'))),
  });
  const ctx = testContext(ff.impl);
  await ctx.secrets.set('shopify_client_id', 'cid');
  await ctx.secrets.set('shopify_client_secret', 'shpss_secret1234567890');
  ctx.settings.set('connections', { shopify: { storeDomain: 'ashworth-studio.myshopify.com' } });
  const app = createApp(ctx);
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const gql = () => ff.calls.filter((c) => c.url.includes('graphql.json'));
  return { ctx, app, post, calls: ff.calls, gql, ledger: () => ctx.db.select().from(requests).all() };
}

describe('Shopify name search and add', () => {
  it('a product name searches the store with one query and lists matches', async () => {
    const t = await setup();
    const r = (await (await t.post('/api/line', { text: 'linen' })).json()) as { kind: string; results: { id: string; title: string; image: string | null; onLine: number | null }[] };
    expect(r.kind).toBe('search');
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toMatchObject({ id: 'gid://shopify/Product/8001', title: 'Linen Oversized Blazer', onLine: null });
    expect(r.results[0]!.image).toContain('blazer_240x240');
    expect(t.gql()).toHaveLength(1);
    expect(JSON.parse(t.gql()[0]!.body!).variables).toEqual({ query: 'title:*linen*', first: 12 });
    await t.ctx.close();
  });

  it('an empty search lists the newest products (query null)', async () => {
    const t = await setup();
    // The route requires text, so call the search function directly through a space-only-safe path: use the client.
    const { searchShopify } = await import('../src/shopify/search.ts');
    const { hits } = await searchShopify(t.ctx.shopify, '   ');
    expect(hits).toHaveLength(2);
    expect(JSON.parse(t.gql()[0]!.body!).variables.query).toBeNull();
    await t.ctx.close();
  });

  it('picking a result creates the product and reads one snapshot; picking again is a duplicate with 0 requests', async () => {
    const t = await setup();
    const r = (await (await t.post('/api/line/from-shopify', { shopifyProductId: 'gid://shopify/Product/8001' })).json()) as { kind: string; productId: number; jobId: number };
    expect(r.kind).toBe('importing');
    await t.ctx.worker.drain();
    expect(t.ctx.worker.view(r.jobId).status).toBe('done');
    expect(t.gql()).toHaveLength(1);

    const p = (await (await t.app.request(`/api/products/${r.productId}`)).json()) as { state: string; title: string; shopifyHandle: string; thumbnail: string; origin: string; snapshotAt: string };
    expect(p).toMatchObject({ state: 'from_shopify', origin: 'shopify', title: 'Linen Oversized Blazer', shopifyHandle: 'linen-oversized-blazer', thumbnail: 'https://cdn.shopify.com/s/files/1/blazer.jpg' });
    expect(p.snapshotAt).toMatch(/^\d{4}-/);

    const dup = (await (await t.post('/api/line/from-shopify', { shopifyProductId: 'gid://shopify/Product/8001' })).json()) as { kind: string };
    expect(dup.kind).toBe('duplicate');
    expect(t.gql()).toHaveLength(1);

    // The search now marks it as on the line.
    const s = (await (await t.post('/api/line', { text: 'linen' })).json()) as { results: { onLine: number | null }[] };
    expect(s.results[0]!.onLine).toBe(r.productId);
    expect(t.ledger().map((l) => l.purpose)).toEqual(['access_token', 'product_snapshot', 'search']);
    await t.ctx.close();
  });

  it('readSnapshot validates the product into minor units and media images only', async () => {
    const t = await setup();
    const { snapshot } = await readSnapshot(t.ctx.shopify, 'gid://shopify/Product/8001');
    expect(snapshot.images).toHaveLength(2);
    expect(snapshot.variants[0]).toEqual({ id: 'gid://shopify/ProductVariant/7001', title: 'S', sku: 'BLZ-S', priceMinor: 8999, compareAtPriceMinor: 12599, imageId: 'gid://shopify/MediaImage/9001' });
    expect(snapshot.variants[1]).toMatchObject({ sku: null, compareAtPriceMinor: null, imageId: null });
    expect(snapshot.options).toEqual([{ name: 'Size', values: ['S', 'M'] }]);
    expect(snapshot.currency).toBe('USD');
    await t.ctx.close();
  });
});
