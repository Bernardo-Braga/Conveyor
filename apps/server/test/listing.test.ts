import { describe, expect, it } from 'vitest';
import { ImportSettings, ListingDraft, MAX_PHOTOS, type SourceProduct } from '@conveyor/shared';
import { createApp } from '../src/app.ts';
import { costs, products, requests } from '../src/db/schema.ts';
import { photoIndexes } from '../src/listing/photos.ts';
import { buildDraftInput, createDraft } from '../src/listing/shopifyDraft.ts';
import { recentTitles } from '../src/products/repo.ts';
import { mapAliexpress } from '../src/suppliers/mapAliexpress.ts';
import { claudeAuthOk, claudeResult, fakeCli, fakeFetch, fixture, json, testContext, type CliCall, type Recorded } from './helpers.ts';

const ALI_FIXTURE = fixture('rapidapi/aliexpress-item.json');
const LINK = 'https://www.aliexpress.com/item/3256812772817240.html';
const source = (): SourceProduct => mapAliexpress(ALI_FIXTURE, { itemId: '3256812772817240', url: LINK });
const goodDraft = (): ListingDraft => {
  const wire = JSON.parse((fixture('claude/listing-response.json') as { content: { text: string }[] }).content[0]!.text) as { optionNames: { from: string; to: string }[]; optionValues: { from: string; to: string }[] };
  return ListingDraft.parse({ ...wire, optionNames: Object.fromEntries(wire.optionNames.map((p) => [p.from, p.to])), optionValues: Object.fromEntries(wire.optionValues.map((p) => [p.from, p.to])) });
};
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const WIRE = JSON.parse((fixture('claude/listing-response.json') as { content: { text: string }[] }).content[0]!.text) as unknown;
const isAuth = (c: CliCall) => c.args[0] === 'auth';

/** The writer always succeeds unless a test says otherwise. No subprocess starts. */
function writerCli(claudeReply?: (c: CliCall) => { stdout?: string; stderr?: string; code?: number }) {
  return fakeCli({
    claude: (c) => (isAuth(c) ? { stdout: claudeAuthOk() } : (claudeReply?.(c) ?? { stdout: claudeResult(WIRE) })),
    codex: () => ({ files: { 'listing-reply.json': JSON.stringify(WIRE) } }),
  });
}

describe('buildDraftInput', () => {
  const settings = ImportSettings.parse({ listing: { brandVoice: '', tag: 'conveyor' } });

  it('translates options, prices every variant, orders images and stays a DRAFT', () => {
    const plan = buildDraftInput({ source: source(), draft: goodDraft(), settings, usdPerCny: 0.14, sourceMeta: { platform: 'aliexpress', itemId: '3256812772817240' } });
    const input = plan.input as { status: string; title: string; tags: string[]; productOptions: { name: string; values: { name: string }[] }[]; variants: { optionValues: { optionName: string; name: string }[]; price: string; compareAtPrice: string; inventoryItem: { tracked: boolean; cost: string }; inventoryPolicy: string; file?: { originalSource: string } }[]; files: { originalSource: string; contentType: string }[]; metafields: { namespace: string; key: string; value: string }[]; seo: { title: string } };
    expect(input.status).toBe('DRAFT');
    expect(input.title).toBe('Soft-sole slip-on loafers for men');
    expect(input.tags.slice(0, 2)).toEqual(['conveyor', 'aliexpress']);
    expect(input.productOptions.map((o) => o.name)).toEqual(['Colour', 'Size']);
    expect(input.productOptions[1]!.values.map((v) => v.name)).toContain('EU 40');
    expect(plan.variantCount).toBe(28);
    expect(plan.synchronous).toBe(true);
    const v = input.variants[0]!;
    expect(v.optionValues).toEqual([{ optionName: 'Colour', name: 'Assorted' }, { optionName: 'Size', name: 'EU 40' }]);
    expect(v.price).toBe('105.99'); // (29.03 + 6.00) × 3 → 105.09 → 105.99
    expect(v.compareAtPrice).toBe('148.99');
    expect(v.inventoryItem).toEqual({ tracked: false, cost: '35.03' });
    expect(v.inventoryPolicy).toBe('CONTINUE');
    // Images: Claude's order [0,2,1,4,5] first, all from the cleaned gallery, and every variant file is also in files.
    expect(input.files.slice(0, 2).map((f) => f.originalSource)).toEqual([source().images[0], source().images[2]]);
    expect(input.files.every((f) => f.contentType === 'IMAGE' && f.originalSource.startsWith('https://'))).toBe(true);
    for (const variant of input.variants) if (variant.file) expect(input.files.some((f) => f.originalSource === variant.file!.originalSource)).toBe(true);
    expect(input.metafields.find((m) => m.key === 'source')!.value).toContain('3256812772817240');
    expect(input.metafields.find((m) => m.key === 'needs_check')).toBeTruthy();
    expect(input.seo.title.length).toBeLessThanOrEqual(60);
    expect(JSON.stringify(input)).not.toContain('sellerId');
  });

  it('keeps the gallery images the writer never saw, after the ones it chose', () => {
    // The writer reads MAX_PHOTOS photos, so its imageOrder can only judge those. A 1688 gallery
    // of 7 with imageOrder [0,3,1,2] used to reach Shopify as 4 images; 4, 5 and 6 were lost.
    const src = source();
    expect(src.images.length).toBeGreaterThan(MAX_PHOTOS);
    const reviewedImages = photoIndexes(Array.from({ length: MAX_PHOTOS }, (_, i) => `photo-${i}.jpg`));
    const plan = buildDraftInput({ source: src, draft: { ...goodDraft(), imageOrder: [0, 3, 1, 2] }, settings, usdPerCny: 0.14, reviewedImages, sourceMeta: {} });
    const files = (plan.input as { files: { originalSource: string }[] }).files;
    expect(files.map((f) => f.originalSource)).toEqual([src.images[0], src.images[3], src.images[1], src.images[2], ...src.images.slice(MAX_PHOTOS)]);
    expect(plan.imageCount).toBe(src.images.length);
    expect(plan.notes.some((n) => n.includes('did not see'))).toBe(true);
  });

  it('drops a reviewed image the writer rejected, and adds no note when it saw them all', () => {
    const src = source();
    const reviewedImages = photoIndexes(Array.from({ length: src.images.length }, (_, i) => `photo-${i}.jpg`));
    const plan = buildDraftInput({ source: src, draft: { ...goodDraft(), imageOrder: [1, 0] }, settings, usdPerCny: 0.14, reviewedImages, sourceMeta: {} });
    const files = (plan.input as { files: { originalSource: string }[] }).files;
    expect(files.map((f) => f.originalSource)).toEqual([src.images[1], src.images[0]]);
    expect(plan.notes.some((n) => n.includes('did not see'))).toBe(false);
  });

  it('falls back to the supplier image order and goes async above 100 variants', () => {
    const src = source();
    const big: SourceProduct = { ...src, options: [{ name: 'N', values: Array.from({ length: 120 }, (_, i) => ({ label: String(i) })) }], variants: Array.from({ length: 120 }, (_, i) => ({ optionValues: [String(i)], costMinor: 1000 })) };
    const plan = buildDraftInput({ source: big, draft: { ...goodDraft(), imageOrder: [99, 98] }, settings, usdPerCny: 0.14, sourceMeta: {} });
    expect(plan.synchronous).toBe(false);
    expect(plan.variantCount).toBe(120);
    expect((plan.input as { files: { originalSource: string }[] }).files[0]!.originalSource).toBe(src.images[0]);
    expect(plan.notes.some((n) => /image order/.test(n))).toBe(true);
  });
});

describe('createDraft (Shopify productSet)', () => {
  async function shop(routes: Record<string, (r: Recorded) => Response>) {
    const ff = fakeFetch({ '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')), ...routes });
    const ctx = testContext(ff.impl);
    await ctx.secrets.set('shopify_client_id', 'cid');
    await ctx.secrets.set('shopify_client_secret', 'shpss_secret1234567890');
    ctx.settings.set('connections', { shopify: { storeDomain: 'ashworth-studio.myshopify.com' } });
    return { ctx, ff, gql: () => ff.calls.filter((c) => c.url.includes('graphql.json')) };
  }
  const plan = () => buildDraftInput({ source: source(), draft: goodDraft(), settings: ImportSettings.parse({}), usdPerCny: 0.14, sourceMeta: {} });

  it('one synchronous request creates the draft; rewrite passes the identifier', async () => {
    const t = await shop({ 'graphql.json': () => json(fixture('shopify/productSet.json'), 200, { 'x-request-id': 'shop-ps-1' }) });
    const created = await createDraft(t.ctx.shopify, plan(), { productId: 1, jobId: 1 });
    expect(created).toMatchObject({ id: 'gid://shopify/Product/9101', handle: 'soft-sole-slip-on-loafers-for-men', status: 'DRAFT', requests: 1, requestId: 'shop-ps-1' });
    const vars = JSON.parse(t.gql()[0]!.body!).variables as { synchronous: boolean; identifier?: unknown; input: { status: string } };
    expect(vars.synchronous).toBe(true);
    expect(vars.identifier).toBeUndefined();
    expect(vars.input.status).toBe('DRAFT');

    await createDraft(t.ctx.shopify, plan(), { productId: 1, jobId: 2, existingId: 'gid://shopify/Product/9101' });
    expect(JSON.parse(t.gql()[1]!.body!).variables.identifier).toEqual({ id: 'gid://shopify/Product/9101' });
    await t.ctx.close();
  });

  it('userErrors become a final step error quoting the field and code', async () => {
    const t = await shop({ 'graphql.json': () => json(fixture('shopify/productSet-userError.json')) });
    await expect(createDraft(t.ctx.shopify, plan(), { productId: 1, jobId: 1 })).rejects.toMatchObject({ details: { service: 'shopify', code: 'INVALID', retryable: false } });
    await expect(createDraft(t.ctx.shopify, plan(), { productId: 1, jobId: 1 })).rejects.toThrow(/variants\.0\.price/);
    await t.ctx.close();
  });

  it('async mode polls the operation with spaced requests', async () => {
    let n = 0;
    const t = await shop({ 'graphql.json': (r) => (r.body!.includes('ConveyorProductSetOperation') ? json(fixture('shopify/productSetOperation-complete.json')) : (n++, json(fixture('shopify/productSet-async.json')))) });
    const waits: number[] = [];
    const created = await createDraft(t.ctx.shopify, { ...plan(), synchronous: false }, { productId: 1, jobId: 1, sleep: async (ms) => void waits.push(ms) });
    expect(created).toMatchObject({ id: 'gid://shopify/Product/9102', requests: 2 });
    expect(waits).toEqual([20_000]);
    expect(n).toBe(1);
    await t.ctx.close();
  });
});

describe('a pasted link becomes a Shopify draft in 2 API requests', () => {
  async function setup(claudeReply?: (c: CliCall) => { stdout?: string; stderr?: string; code?: number }) {
    const ff = fakeFetch({
      'rapidapi.com': () => json(ALI_FIXTURE, 200, { 'x-ratelimit-requests-remaining': '98' }),
      'aliexpress-media.com': () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')),
      'graphql.json': () => json(fixture('shopify/productSet.json')),
    });
    const cli = writerCli(claudeReply);
    const ctx = testContext(ff.impl, { runCli: cli.run });
    await ctx.secrets.set('rapidapi_key', 'rapid000');
    await ctx.secrets.set('shopify_client_id', 'cid');
    await ctx.secrets.set('shopify_client_secret', 'shpss_secret1234567890');
    ctx.settings.set('connections', { shopify: { storeDomain: 'ashworth-studio.myshopify.com' } });
    const app = createApp(ctx);
    const post = (path: string, body?: unknown) => app.request(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json' } });
    const ledger = () => ctx.db.select().from(requests).all();
    /** What the request budget counts: supplier and Shopify calls, not photo downloads or the token exchange. */
    const billable = () => ledger().filter((r) => r.service === 'rapidapi' || (r.service === 'shopify' && r.purpose !== 'access_token'));
    return { ctx, app, post, ff, cli, ledger, billable };
  }

  it('import and listing together make 2 API requests; the writer runs on the plan and photos cost no quota', async () => {
    const t = await setup();
    const r = (await (await t.post('/api/line', { text: LINK })).json()) as { productId: number };
    await t.ctx.worker.drain();

    expect(t.billable().map((x) => `${x.service}:${x.purpose}`)).toEqual(['rapidapi:item_detail', 'shopify:product_set']);
    expect(t.ledger().filter((x) => x.service === 'cdn')).toHaveLength(4);
    expect(t.ledger().every((x) => x.productId === r.productId || x.purpose === 'access_token')).toBe(true);
    // No Claude API request was made: the writer was a local CLI on the plan.
    expect(t.ff.calls.some((c) => c.url.includes('anthropic'))).toBe(false);
    expect(t.cli.of('claude').some((c) => !isAuth(c))).toBe(true);

    const p = (await (await t.app.request(`/api/products/${r.productId}`)).json()) as { state: string; title: string; adminUrl: string; listing: { priceMinor: number; needsCheck: string[] } };
    expect(p.state).toBe('editing_in_shopify');
    expect(p.title).toBe('Soft-sole slip-on loafers for men');
    expect(p.adminUrl).toBe('https://admin.shopify.com/products/9101');
    expect(p.listing.priceMinor).toBe(10599);
    expect(p.listing.needsCheck).toHaveLength(1);

    const job = t.ctx.worker.list().find((j) => j.type === 'write_listing')!;
    expect(job.status).toBe('done');
    expect(job.completedSteps).toEqual(['source', 'photos', 'write', 'price', 'shopify_draft', 'handoff']);
    await t.ctx.close();
  });

  it('the focus typed with the link reaches the writer, and can be changed before a rewrite', async () => {
    const t = await setup();
    const r = (await (await t.post('/api/line', { text: LINK, focus: 'The full-grain leather; write for commuters.' })).json()) as { productId: number };
    await t.ctx.worker.drain();

    const prompt = t.cli.of('claude').find((c) => !isAuth(c))!.args.join('\n');
    expect(prompt).toContain('Focus for this listing: The full-grain leather; write for commuters.');
    expect(prompt).toContain('Never invent a fact to fit the focus.');
    const view = (await (await t.app.request(`/api/products/${r.productId}`)).json()) as { focus: string };
    expect(view.focus).toBe('The full-grain leather; write for commuters.');
    expect(t.billable()).toHaveLength(2); // the focus costs nothing: it rides along with the writer run

    // Changed on the row, then used by the next run. Still local.
    const changed = (await (await t.app.request(`/api/products/${r.productId}/focus`, { method: 'PUT', body: JSON.stringify({ focus: 'Lead on the rubber sole' }), headers: { 'content-type': 'application/json' } })).json()) as { focus: string };
    expect(changed.focus).toBe('Lead on the rubber sole');
    await t.post(`/api/products/${r.productId}/write-listing`);
    await t.ctx.worker.drain();
    expect(t.cli.of('claude').filter((c) => !isAuth(c)).at(-1)!.args.join('\n')).toContain('Focus for this listing: Lead on the rubber sole');
    await t.ctx.close();
  });

  it('records the writer run as a cost row rather than a request', async () => {
    const t = await setup();
    await t.post('/api/line', { text: LINK });
    await t.ctx.worker.drain();
    const rows = t.ctx.db.select().from(costs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service: 'claude_code' });
    expect((rows[0]!.units as { apiRequests: number }).apiRequests).toBe(0);
    await t.ctx.close();
  });

  it('a Claude Code usage limit finishes the listing on Codex, still 2 API requests', async () => {
    const t = await setup(() => ({ stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Claude usage limit reached. Your limit resets at 3pm.' }) }));
    const r = (await (await t.post('/api/line', { text: LINK })).json()) as { productId: number };
    await t.ctx.worker.drain();

    const job = t.ctx.worker.list().find((j) => j.type === 'write_listing')!;
    expect(job.status).toBe('done');
    expect(t.cli.of('codex').filter((c) => c.args[0] === 'exec')).toHaveLength(1);
    expect(t.billable()).toHaveLength(2);
    expect(job.log.some((l) => /usage limit/i.test(l.message))).toBe(true);
    expect(((await (await t.app.request(`/api/products/${r.productId}`)).json()) as { state: string }).state).toBe('editing_in_shopify');
    await t.ctx.close();
  });

  it('when every writer is limited the product waits, and a later retry reuses the photos', async () => {
    const ff = fakeFetch({
      'rapidapi.com': () => json(ALI_FIXTURE),
      'aliexpress-media.com': () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')),
      'graphql.json': () => json(fixture('shopify/productSet.json')),
    });
    let limited = true;
    const cli = fakeCli({
      claude: (c) => (isAuth(c) ? { stdout: claudeAuthOk() } : limited ? { stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Claude usage limit reached.' }) } : { stdout: claudeResult(WIRE) }),
      codex: () => (limited ? { stderr: 'usage limit reached', code: 1 } : { files: { 'listing-reply.json': JSON.stringify(WIRE) } }),
    });
    const ctx = testContext(ff.impl, { runCli: cli.run });
    await ctx.secrets.set('rapidapi_key', 'rapid000');
    await ctx.secrets.set('shopify_client_id', 'cid');
    await ctx.secrets.set('shopify_client_secret', 'shpss_secret1234567890');
    ctx.settings.set('connections', { shopify: { storeDomain: 'ashworth-studio.myshopify.com' } });
    const app = createApp(ctx);
    const r = (await (await app.request('/api/line', { method: 'POST', body: JSON.stringify({ text: LINK }), headers: { 'content-type': 'application/json' } })).json()) as { productId: number };
    await ctx.worker.drain();

    const failed = ctx.worker.list().find((j) => j.type === 'write_listing')!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ step: 'write', code: 'usage_limit', retryable: true });
    expect(failed.error!.suggestion).toContain('Wait for the limit to reset');
    expect(failed.completedSteps).toEqual(['source', 'photos']);
    expect(((await (await app.request(`/api/products/${r.productId}`)).json()) as { state: string }).state).toBe('needs_attention');
    const photoCalls = ff.calls.filter((c) => c.url.includes('aliexpress-media')).length;
    expect(photoCalls).toBe(4);

    limited = false;
    await app.request(`/api/products/${r.productId}/retry`, { method: 'POST' });
    await ctx.worker.drain();
    expect(ctx.worker.view(failed.id).status).toBe('done');
    // The photos step was already checkpointed, so nothing was downloaded again.
    expect(ff.calls.filter((c) => c.url.includes('aliexpress-media'))).toHaveLength(photoCalls);
    expect(ff.calls.filter((c) => c.url.includes('rapidapi'))).toHaveLength(1);
    await ctx.close();
  });

  it('a Shopify failure keeps the written listing; the retry does not re-run the writer', async () => {
    const ff = fakeFetch({
      'rapidapi.com': () => json(ALI_FIXTURE),
      'aliexpress-media.com': () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')),
      'graphql.json': () => (fail ? json({}, 503) : json(fixture('shopify/productSet.json'))),
    });
    let fail = true;
    const cli = writerCli();
    const ctx = testContext(ff.impl, { runCli: cli.run });
    await ctx.secrets.set('rapidapi_key', 'rapid000');
    await ctx.secrets.set('shopify_client_id', 'cid');
    await ctx.secrets.set('shopify_client_secret', 'shpss_secret1234567890');
    ctx.settings.set('connections', { shopify: { storeDomain: 'ashworth-studio.myshopify.com' } });
    const app = createApp(ctx);
    const r = (await (await app.request('/api/line', { method: 'POST', body: JSON.stringify({ text: LINK }), headers: { 'content-type': 'application/json' } })).json()) as { productId: number };
    await ctx.worker.drain();

    const failed = ctx.worker.list().find((j) => j.type === 'write_listing')!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ step: 'shopify_draft', service: 'shopify', code: '503' });
    expect(failed.completedSteps).toEqual(['source', 'photos', 'write', 'price']);
    const writerRuns = () => cli.of('claude').filter((c) => !isAuth(c)).length;
    expect(writerRuns()).toBe(1);

    fail = false;
    await app.request(`/api/products/${r.productId}/retry`, { method: 'POST' });
    await ctx.worker.drain();
    expect(ctx.worker.view(failed.id).status).toBe('done');
    expect(writerRuns()).toBe(1);
    await ctx.close();
  });

  it('rewrite: 1 Shopify request and one writer run, updating the same product', async () => {
    const t = await setup();
    const r = (await (await t.post('/api/line', { text: LINK })).json()) as { productId: number };
    await t.ctx.worker.drain();
    const before = t.billable().length;
    expect(await (await t.post(`/api/products/${r.productId}/write-listing`)).status).toBe(202);
    await t.ctx.worker.drain();

    expect(t.billable().slice(before).map((x) => x.purpose)).toEqual(['product_set']);
    const last = JSON.parse(t.ff.calls.filter((c) => c.url.includes('graphql.json')).at(-1)!.body!) as { variables: { identifier: { id: string } } };
    expect(last.variables.identifier).toEqual({ id: 'gid://shopify/Product/9101' });
    expect(t.ctx.db.select().from(products).all()).toHaveLength(1);
    await t.ctx.close();
  });

  it('with photos turned off the writer still runs and nothing is downloaded', async () => {
    const t = await setup();
    t.ctx.settings.set('import', { listing: { showPhotos: false } });
    await t.post('/api/line', { text: LINK });
    await t.ctx.worker.drain();
    expect(t.ff.calls.filter((c) => c.url.includes('aliexpress-media'))).toHaveLength(0);
    expect(t.billable()).toHaveLength(2);
    expect(t.ctx.worker.list().find((j) => j.type === 'write_listing')!.status).toBe('done');
    await t.ctx.close();
  });

  it('hands the writer the titles the store already uses, and leaves the product\'s own out of them', async () => {
    const t = await setup();
    t.ctx.db.insert(products).values({ origin: 'link', state: 'ready_to_launch', title: 'Ashworth leather loafer', listingDraft: { ...goodDraft(), title: 'Ashworth leather loafer' } }).run();
    t.ctx.settings.set('import', { listing: { instructions: 'Never use the word premium.' } });
    const r = (await (await t.post('/api/line', { text: LINK })).json()) as { productId: number };
    await t.ctx.worker.drain();
    const prompt = t.cli.calls.find((c) => c.file === 'claude' && !isAuth(c))!.args.join('\n');
    expect(prompt).toContain('- Ashworth leather loafer');
    expect(prompt).toContain('Do not reuse one of these titles');
    expect(prompt).toContain('Never use the word premium.');
    // Its own draft title is written during the same job; a rewrite must not be told to avoid it.
    expect(recentTitles(t.ctx.db, { exclude: r.productId })).not.toContain('Soft-sole slip-on loafers for men');
    expect(recentTitles(t.ctx.db)).toEqual(['Soft-sole slip-on loafers for men', 'Ashworth leather loafer']);
    await t.ctx.close();
  });

  it('refresh supplier data after a draft exists costs 1 request and does not rewrite by itself', async () => {
    const t = await setup();
    const r = (await (await t.post('/api/line', { text: LINK })).json()) as { productId: number };
    await t.ctx.worker.drain();
    const before = t.billable().length;
    await t.post(`/api/products/${r.productId}/refresh-supplier`);
    await t.ctx.worker.drain();
    expect(t.billable().slice(before).map((x) => x.purpose)).toEqual(['item_detail']);
    await t.ctx.close();
  });
});
