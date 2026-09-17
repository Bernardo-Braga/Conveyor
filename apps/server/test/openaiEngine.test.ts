import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImageSettings, ShopifySnapshot } from '@conveyor/shared';
import { createApp } from '../src/app.ts';
import { costs, creativeBatches, creatives, products, requests } from '../src/db/schema.ts';
import { openaiEngine } from '../src/images/openaiEngine.ts';
import { FIXTURES, fakeCli, fakeFetch, fixture, json, testContext, type CliCall, type Recorded } from './helpers.ts';

const MUG = fs.readFileSync(path.join(FIXTURES, 'images', 'codex-mug.png'));
const KEY = 'sk-proj-OpenAiImageSecret0001';
const slots = (n: number, aspects: ('1:1' | '4:5' | '9:16')[] = ['1:1', '4:5', '9:16']) => aspects.flatMap((aspect, a) => Array.from({ length: n }, (_, i) => ({ creativeId: a * 100 + i + 1, aspect, slot: i + 1 })));

async function engineWith(routes: Record<string, (r: Recorded) => Response>, quality: ImageSettings['openai']['quality'] = 'medium', oneRequestPerFormat = true) {
  const ff = fakeFetch(routes);
  const ctx = testContext(ff.impl);
  await ctx.secrets.set('openai_api_key', KEY);
  const refDir = path.join(ctx.dataDir, 'refs');
  fs.mkdirSync(refDir, { recursive: true });
  const refs = ['ref-0.png', 'ref-1.png'].map((n) => {
    const p = path.join(refDir, n);
    fs.writeFileSync(p, MUG);
    return p;
  });
  const engine = openaiEngine({ ledger: ctx.ledger, secrets: ctx.secrets, db: ctx.db, settings: { ...ImageSettings.parse({}).openai, quality, oneRequestPerFormat }, jobId: 7 });
  return { ctx, ff, engine, refs };
}

describe('openaiEngine', () => {
  it('one edits request per format with the references attached, n = count, PNG, size and quality; usage goes to costs', async () => {
    const t = await engineWith({ '/v1/images/edits': (r) => json(r.form!.n === '4' ? fixture('openai/images-edit-n4.json') : fixture('openai/images-edit-n1.json'), 200, { 'x-request-id': 'oai-1' }) });
    const produced: { id: number; bytes: number }[] = [];
    const out = await t.engine.generate({ batchId: 1, productId: 3, workDir: t.ctx.dataDir, referencePaths: t.refs, prompt: 'PROMPT', slots: slots(4) }, { onImage: async (s, b) => void produced.push({ id: s.creativeId, bytes: b.length }), log: () => undefined, progress: () => undefined });
    expect(out.producedCreativeIds).toHaveLength(12);
    expect(out.remaining).toEqual([]);
    expect(out.apiRequests).toBe(3);
    expect(out.tasks).toBe(3);
    expect(produced.every((p) => p.bytes > 100)).toBe(true);

    const calls = t.ff.calls;
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url).toBe('https://api.openai.com/v1/images/edits');
      expect(c.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(c.form).toMatchObject({ model: 'gpt-image-2', prompt: 'PROMPT', n: '4', quality: 'medium', output_format: 'png' });
      expect(c.form!.input_fidelity).toBeUndefined();
      expect((c.form!['image[]'] as { name: string }[]).map((f) => f.name)).toEqual(['ref-0.png', 'ref-1.png']);
    }
    expect(calls.map((c) => c.form!.size).sort()).toEqual(['1088x1088', '1088x1360', '1088x1936']);

    const ledger = t.ctx.db.select().from(requests).all();
    expect(ledger).toHaveLength(3);
    expect(ledger[0]).toMatchObject({ service: 'openai', purpose: 'image_edit', productId: 3, jobId: 7, status: 200, requestId: 'oai-1' });
    expect(JSON.stringify(ledger)).not.toContain(KEY);
    const cost = t.ctx.db.select().from(costs).all();
    expect(cost).toHaveLength(3);
    expect(cost[0]).toMatchObject({ service: 'openai', jobId: 7 });
    expect(cost[0]!.units).toMatchObject({ total_tokens: 1420, n: 4 });
    await t.ctx.close();
  });

  it('falls back to one image per request when the API refuses n above 1', async () => {
    const t = await engineWith({ '/v1/images/edits': (r) => (r.form!.n === '1' ? json(fixture('openai/images-edit-n1.json')) : json(fixture('openai/error-400-n.json'), 400)) });
    const log: string[] = [];
    const out = await t.engine.generate({ batchId: 1, productId: 1, workDir: t.ctx.dataDir, referencePaths: t.refs, prompt: 'p', slots: slots(3, ['4:5']) }, { onImage: async () => undefined, log: (m) => void log.push(m), progress: () => undefined });
    expect(out.producedCreativeIds).toHaveLength(3);
    expect(out.apiRequests).toBe(4); // one refused, then three singles
    expect(out.failures).toBe(0);
    expect(log.some((l) => /one image per request/.test(l))).toBe(true);
    await t.ctx.close();
  });

  it('a quota error stops at once and is a usage limit; two other failures stop without one', async () => {
    const q = await engineWith({ '/v1/images/edits': () => json(fixture('openai/error-429-quota.json'), 429) });
    const out = await q.engine.generate({ batchId: 1, productId: 1, workDir: q.ctx.dataDir, referencePaths: [], prompt: 'p', slots: slots(2) }, { onImage: async () => undefined, log: () => undefined, progress: () => undefined });
    expect(out.handoff).toMatchObject({ usageLimit: true });
    expect(out.remaining).toHaveLength(6);
    expect(q.ff.calls.length).toBeLessThanOrEqual(2); // the ledger's one retry on 429
    await q.ctx.close();

    const f = await engineWith({ '/v1/images/edits': () => json({ error: { message: 'Your request was rejected by the safety system.', type: 'invalid_request_error' } }, 400) });
    const out2 = await f.engine.generate({ batchId: 1, productId: 1, workDir: f.ctx.dataDir, referencePaths: [], prompt: 'p', slots: slots(1) }, { onImage: async () => undefined, log: () => undefined, progress: () => undefined });
    expect(out2.handoff).toMatchObject({ usageLimit: false });
    expect(out2.failures).toBe(2);
    expect(f.ff.calls).toHaveLength(2);
    await f.ctx.close();
  });

  it('an edit puts the target first and adds the instruction to the prompt', async () => {
    const t = await engineWith({ '/v1/images/edits': () => json(fixture('openai/images-edit-n1.json')) });
    const target = path.join(t.ctx.dataDir, 'target.jpg');
    fs.writeFileSync(target, MUG);
    await t.engine.generate({ batchId: 1, productId: 1, workDir: t.ctx.dataDir, referencePaths: t.refs, prompt: 'base', slots: slots(1, ['1:1']), edit: { path: target, instruction: 'darker background' } }, { onImage: async () => undefined, log: () => undefined, progress: () => undefined });
    const form = t.ff.calls[0]!.form!;
    expect((form['image[]'] as { name: string }[]).map((f) => f.name)).toEqual(['target.jpg', 'ref-0.png', 'ref-1.png']);
    expect(form.prompt).toContain('darker background');
    await t.ctx.close();
  });

  it('is unavailable without a key', async () => {
    const ctx = testContext();
    const e = openaiEngine({ ledger: ctx.ledger, secrets: ctx.secrets, db: ctx.db, settings: ImageSettings.parse({}).openai });
    expect((await e.available()).ok).toBe(false);
    await ctx.close();
  });
});

describe('a simulated Codex limit finishes the batch on the API', () => {
  const SNAPSHOT = ShopifySnapshot.parse({
    id: 'gid://shopify/Product/8001', handle: 'linen-oversized-blazer', title: 'Linen Oversized Blazer', status: 'ACTIVE', descriptionHtml: '<p>x</p>', productType: 'Blazers', tags: [], vendor: 'conveyor', onlineStoreUrl: null,
    featuredImage: null, images: [1, 2].map((i) => ({ id: `gid://shopify/MediaImage/900${i}`, url: `https://cdn.shopify.com/s/files/1/blazer-${i}.jpg`, altText: null })),
    options: [], variants: [{ id: 'v1', title: 'S', sku: null, priceMinor: 8999, compareAtPriceMinor: null, imageId: null }], currency: 'USD', updatedAt: '2026-09-15T10:00:00Z', fetchedAt: new Date().toISOString(),
  });

  /** Codex makes the first format's images, then reports a plan limit on the next task. */
  function limitedCodex() {
    let tasks = 0;
    return fakeCli({
      codex: async (call: CliCall) => {
        if (call.args[0] === '--version') return { stdout: 'codex-cli 0.154.0' };
        tasks += 1;
        const files = [...fs.readFileSync(path.join(call.cwd, 'TASK.md'), 'utf8').matchAll(/out\/(\d\d\.png)/g)].map((m) => m[1]!);
        if (tasks > 1) return { stdout: '', stderr: "You've hit your usage limit for image generation. Try again in 2 hours.", code: 1 };
        fs.mkdirSync(path.join(call.cwd, 'out'), { recursive: true });
        for (const f of files) fs.writeFileSync(path.join(call.cwd, 'out', f), MUG);
        return { stdout: '' };
      },
    });
  }

  it('Codex does one format, OpenAI the other two: 1 snapshot + 2 image requests, 12 clean files, batch done', async () => {
    const ff = fakeFetch({
      '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')),
      'graphql.json': () => json(fixture('shopify/product.json')),
      'cdn.shopify.com': () => new Response(MUG, { status: 200, headers: { 'content-type': 'image/png' } }),
      '/v1/images/edits': () => json(fixture('openai/images-edit-n4.json')),
    });
    const codex = limitedCodex();
    const ctx = testContext(ff.impl, { runCli: codex.run });
    await ctx.secrets.set('shopify_client_id', 'cid');
    await ctx.secrets.set('shopify_client_secret', 'shpss_secret1234567890');
    await ctx.secrets.set('openai_api_key', KEY);
    ctx.settings.set('connections', { shopify: { storeDomain: 'ashworth-studio.myshopify.com' } });
    ctx.settings.set('images', { codex: { workers: 1 } });
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    const pid = ctx.db.insert(products).values({ origin: 'shopify', state: 'editing_in_shopify', shopifyProductId: 'gid://shopify/Product/8001', shopifyHandle: 'linen-oversized-blazer', snapshot: { ...SNAPSHOT, fetchedAt: old }, snapshotAt: old }).returning({ id: products.id }).get().id;
    const app = createApp(ctx);
    await app.request(`/api/products/${pid}/generate`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    await ctx.worker.drain();

    const job = ctx.worker.list()[0]!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const batch = ctx.db.select().from(creativeBatches).get()!;
    expect(batch.status).toBe('done');
    expect(batch.apiRequests).toBe(1 + 2);
    expect(batch.note).toMatch(/plan limit|usage limit/i);
    const rows = ctx.db.select().from(creatives).all();
    expect(rows.filter((c) => c.status === 'finished')).toHaveLength(12);
    expect(rows.every((c) => c.width === 1080 && c.finishedPath && fs.existsSync(c.finishedPath))).toBe(true);
    expect(codex.of('codex').filter((c) => c.args[0] === 'exec')).toHaveLength(2);
    expect(ff.calls.filter((c) => c.url.includes('images/edits'))).toHaveLength(2);
    expect(ctx.db.select().from(costs).all().filter((c) => c.service === 'openai')).toHaveLength(2);
    expect(job.log.some((l) => /Handing the rest to openai/.test(l.message))).toBe(true);
    expect(((await (await app.request(`/api/products/${pid}`)).json()) as { state: string }).state).toBe('review');
    await ctx.close();
  });

  it('with hand-off switched off, the batch stays partial and says why', async () => {
    const ff = fakeFetch({
      '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')),
      'graphql.json': () => json(fixture('shopify/product.json')),
      'cdn.shopify.com': () => new Response(MUG, { status: 200, headers: { 'content-type': 'image/png' } }),
      '/v1/images/edits': () => json(fixture('openai/images-edit-n4.json')),
    });
    const ctx = testContext(ff.impl, { runCli: limitedCodex().run });
    await ctx.secrets.set('shopify_client_id', 'cid');
    await ctx.secrets.set('shopify_client_secret', 'shpss_secret1234567890');
    await ctx.secrets.set('openai_api_key', KEY);
    ctx.settings.set('connections', { shopify: { storeDomain: 'ashworth-studio.myshopify.com' } });
    ctx.settings.set('images', { codex: { workers: 1, handoffToOpenAI: false } });
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    const pid = ctx.db.insert(products).values({ origin: 'shopify', state: 'editing_in_shopify', shopifyProductId: 'gid://shopify/Product/8001', shopifyHandle: 'linen-oversized-blazer', snapshot: { ...SNAPSHOT, fetchedAt: old }, snapshotAt: old }).returning({ id: products.id }).get().id;
    const app = createApp(ctx);
    await app.request(`/api/products/${pid}/generate`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    await ctx.worker.drain();
    expect(ctx.worker.list()[0]!.status).toBe('failed');
    expect(ctx.db.select().from(creativeBatches).get()!).toMatchObject({ status: 'partial' });
    expect(ctx.db.select().from(creativeBatches).get()!.note).toMatch(/hand-off to OpenAI is off/);
    expect(ff.calls.filter((c) => c.url.includes('images/edits'))).toHaveLength(0);
    await ctx.close();
  });
});
