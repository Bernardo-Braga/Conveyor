import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { products, requests, supplierRaw } from '../src/db/schema.ts';
import { fakeFetch, json, testContext } from './helpers.ts';

/** A small synthetic DataHub-shaped body. The real captured fixtures drive the mapper tests. */
const BODY = {
  result: {
    status: { code: 200, data: 'success' },
    settings: { currency: 'USD' },
    item: {
      itemId: '1005006123456789',
      title: 'Ceramic Mug 350ml',
      images: ['//ae01.alicdn.com/kf/S1.jpg_350x350.jpg', 'https://ae01.alicdn.com/kf/S2.jpg_.webp', 'https://ae01.alicdn.com/kf/S1.jpg'],
      description: { html: '<p>Nice mug</p><img src="//ae01.alicdn.com/kf/D1.jpg_.webp">', images: [] },
      sku: {
        def: { price: 6.5, promotionPrice: 4.99, quantity: 100 },
        props: [{ pid: 14, name: 'Color', values: [{ vid: 29, name: 'Red', image: '//ae01.alicdn.com/kf/R.jpg_50x50.jpg' }, { vid: 173, name: 'Blue' }] }],
        base: [
          { skuId: '1', skuAttr: '14:29#Red', price: 6.5, promotionPrice: 4.99, quantity: 40 },
          { skuId: '2', skuAttr: '14:173#Blue', price: 6.5, promotionPrice: 5.49, quantity: 60 },
        ],
      },
    },
  },
};
const LINK = 'https://www.aliexpress.com/item/1005006123456789.html?spm=x';

async function setup(routes: Parameters<typeof fakeFetch>[0] = { 'rapidapi.com': () => json(BODY, 200, { 'x-ratelimit-requests-remaining': '400', 'x-ratelimit-requests-reset': '1000' }) }) {
  const ff = fakeFetch(routes);
  const ctx = testContext(ff.impl);
  await ctx.secrets.set('rapidapi_key', 'rapidapiSecret000');
  const app = createApp(ctx);
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const rapidCalls = () => ff.calls.filter((c) => c.url.includes('rapidapi')).length;
  return { ctx, app, post, calls: ff.calls, rapidCalls, ledger: () => ctx.db.select().from(requests).all() };
}

describe('import flow', () => {
  it('a new link: 1 RapidAPI request, raw saved before mapping, product mapped and handed to the listing step', async () => {
    const t = await setup();
    const res = await t.post('/api/line', { text: LINK });
    expect(res.status).toBe(202);
    const r = (await res.json()) as { kind: string; productId: number; jobId: number };
    expect(r.kind).toBe('importing');
    await t.ctx.worker.drain();

    expect(t.rapidCalls()).toBe(1);
    const job = t.ctx.worker.view(r.jobId);
    expect(job.status).toBe('done');
    expect(job.completedSteps).toEqual(['quota', 'fetch', 'map', 'finish']);

    const detail = (await (await t.app.request(`/api/products/${r.productId}`)).json()) as { state: string; title: string; costMinor: number; currency: string; imageCount: number; thumbnail: string; source: { images: string[]; variants: { optionValues: string[]; costMinor: number }[]; options: { name: string }[]; descriptionText: string; descriptionImages: string[] } };
    expect(detail.state).toBe('writing_listing');
    expect(detail.title).toBe('Ceramic Mug 350ml');
    expect(detail.currency).toBe('USD');
    expect(detail.costMinor).toBe(499);
    expect(detail.thumbnail).toBe('https://ae01.alicdn.com/kf/S1.jpg_220x220.jpg');
    expect(detail.source.images).toEqual(['https://ae01.alicdn.com/kf/S1.jpg', 'https://ae01.alicdn.com/kf/S2.jpg', 'https://ae01.alicdn.com/kf/R.jpg']);
    expect(detail.source.descriptionImages).toEqual(['https://ae01.alicdn.com/kf/D1.jpg']);
    expect(detail.source.descriptionText).toBe('Nice mug');
    expect(detail.source.options.map((o) => o.name)).toEqual(['Color']);
    expect(detail.source.variants).toEqual([
      { optionValues: ['Red'], costMinor: 499, stock: 40, skuId: '1' },
      { optionValues: ['Blue'], costMinor: 549, stock: 60, skuId: '2' },
    ]);
    expect(t.ctx.db.select().from(supplierRaw).all()).toHaveLength(1);
    expect(t.ctx.quota.get('aliexpress').remaining).toBe(400);
    await t.ctx.close();
  });

  it('pasting the same link again (any URL shape) costs 0 requests', async () => {
    const t = await setup();
    await t.post('/api/line', { text: LINK });
    await t.ctx.worker.drain();
    const again = (await (await t.post('/api/line', { text: 'https://pt.aliexpress.com/item/1005006123456789.html' })).json()) as { kind: string; productId: number };
    expect(again.kind).toBe('duplicate');
    expect(t.rapidCalls()).toBe(1);
    expect(t.ctx.db.select().from(products).all()).toHaveLength(1);
    await t.ctx.close();
  });

  it('a link whose raw response is already saved (e.g. by the capture script) imports with 0 requests', async () => {
    const t = await setup();
    await t.ctx.rapidapi.fetchItem('aliexpress', '1005006123456789'); // the capture script does this
    expect(t.rapidCalls()).toBe(1);
    const r = (await (await t.post('/api/line', { text: LINK })).json()) as { kind: string; productId: number; jobId: number };
    expect(r.kind).toBe('importing');
    await t.ctx.worker.drain();
    expect(t.rapidCalls()).toBe(1);
    const job = t.ctx.worker.view(r.jobId);
    expect(job.status).toBe('done');
    expect(job.log.some((l) => /Reusing the supplier response/.test(l.message))).toBe(true);
    await t.ctx.close();
  });

  it('an unsupported link makes no request and no product', async () => {
    const t = await setup();
    const r = (await (await t.post('/api/line', { text: 'https://www.amazon.com/dp/B0001' })).json()) as { kind: string };
    expect(r.kind).toBe('unsupported');
    expect(t.calls).toHaveLength(0);
    expect(t.ctx.db.select().from(products).all()).toHaveLength(0);
    await t.ctx.close();
  });

  it('stops before fetching when quota is below the threshold, and marks the product', async () => {
    const t = await setup();
    t.ctx.quota.updateFromHeaders('aliexpress', new Headers({ 'x-ratelimit-requests-remaining': '3', 'x-ratelimit-requests-reset': '5000' }));
    const r = (await (await t.post('/api/line', { text: LINK })).json()) as { productId: number; jobId: number };
    await t.ctx.worker.drain();
    expect(t.rapidCalls()).toBe(0);
    const job = t.ctx.worker.view(r.jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ step: 'quota', retryable: true });
    const p = (await (await t.app.request(`/api/products/${r.productId}`)).json()) as { state: string; failure: { step: string } };
    expect(p.state).toBe('needs_attention');
    expect(p.failure.step).toBe('quota');

    // Raising the threshold and retrying resumes at the quota step and then fetches once.
    t.ctx.settings.set('import', { quotaPauseThreshold: 0 });
    await t.app.request(`/api/products/${r.productId}/retry`, { method: 'POST' });
    await t.ctx.worker.drain();
    expect(t.rapidCalls()).toBe(1);
    expect(t.ctx.worker.view(r.jobId).status).toBe('done');
    await t.ctx.close();
  });

  it('a supplier error is final: 1 request, needs_attention with the code, and a retry does not re-fetch a 4xx', async () => {
    const t = await setup({ 'rapidapi.com': () => json({ result: { status: { code: 404, data: 'error', msg: 'Item not found' } } }) });
    const r = (await (await t.post('/api/line', { text: LINK })).json()) as { productId: number; jobId: number };
    await t.ctx.worker.drain();
    expect(t.rapidCalls()).toBe(1);
    const job = t.ctx.worker.view(r.jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ step: 'fetch', service: 'rapidapi', code: '404', retryable: false });
    expect(job.error!.message).toContain('Item not found');
    expect(t.ctx.db.select().from(supplierRaw).all()).toHaveLength(1);
    await t.ctx.close();
  });

  it('explicit refresh costs exactly 1 request and re-maps', async () => {
    const t = await setup();
    const r = (await (await t.post('/api/line', { text: LINK })).json()) as { productId: number };
    await t.ctx.worker.drain();
    const res = await t.app.request(`/api/products/${r.productId}/refresh-supplier`, { method: 'POST' });
    expect(res.status).toBe(202);
    await t.ctx.worker.drain();
    expect(t.rapidCalls()).toBe(2);
    expect(t.ctx.db.select().from(supplierRaw).all()).toHaveLength(2);
    expect(t.ledger().filter((l) => l.service === 'rapidapi').map((l) => l.productId)).toEqual([r.productId, r.productId]);
    await t.ctx.close();
  });

  it('a short link costs one redirect request and then imports normally', async () => {
    const t = await setup({
      'a.aliexpress.com': () => Object.defineProperty(new Response(''), 'url', { value: LINK }),
      'rapidapi.com': () => json(BODY),
    });
    const r = (await (await t.post('/api/line', { text: 'https://a.aliexpress.com/_mNc0Zl' })).json()) as { kind: string; jobId: number };
    expect(r.kind).toBe('importing');
    await t.ctx.worker.drain();
    expect(t.ledger().map((l) => l.purpose)).toEqual(['short_link', 'item_detail']);
    await t.ctx.close();
  });
});
