import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShopifySnapshot, Template } from '@conveyor/shared';
import { createApp } from '../src/app.ts';
import { campaignEdits, campaigns, creativeBatches, creatives, productCopy, products, requests, templates } from '../src/db/schema.ts';
import { applyMapping, detectFormat, fromGraphExport, linkTemplateCopy, shapeSignature } from '../src/meta/importer.ts';
import { diffLive, learningWarnings } from '../src/meta/liveEdit.ts';
import { storeTemplate } from '../src/meta/templates.ts';
import { FIXTURES, fakeCli, fakeFetch, fixture, json, testContext, type CliCall, type Recorded } from './helpers.ts';

const MUG = fs.readFileSync(path.join(FIXTURES, 'images', 'codex-mug.png'));
const GRAPH_EXPORT = {
  campaign: { id: '1', name: 'Loafers autumn', objective: 'OUTCOME_SALES', buying_type: 'AUCTION', daily_budget: '5000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', special_ad_categories: [] },
  adsets: [
    { id: '10', name: 'US - Formal Wear', status: 'PAUSED', billing_event: 'IMPRESSIONS', optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE', start_time: 1789600000, promoted_object: { pixel_id: '1000000000000001', custom_event_type: 'PURCHASE' }, targeting: { geo_locations: { countries: ['US'] }, age_min: 25, age_max: 55, genders: [1], targeting_automation: { advantage_audience: 1 }, flexible_spec: [{ interests: [{ id: '6003290737525', name: 'Formal wear' }] }] }, ads: [{ id: '100', name: 'a', creative: { object_story_spec: { page_id: '100000000000001', link_data: { message: 'Body text', name: 'Headline', link: 'https://example-store.com/products/ashworth-leather-penny-loafers', call_to_action: { type: 'SHOP_NOW' } } }, url_tags: 'utm_source=meta' } }, { id: '101', name: 'b' }] },
    { id: '11', name: 'US - Broad', targeting: { geo_locations: { countries: ['US'] } } },
  ],
};
const UNKNOWN_EXPORT = { title: 'Loafers spring', goal: 'OUTCOME_SALES', budget_usd: 45.5, audiences: [{ label: 'US - Broad' }, { label: 'US - Formal Wear' }], creative: { body: 'Soft loafers for long days', title: 'Ashworth loafers', url: 'https://example-store.com/products/ashworth-leather-penny-loafers' } };

describe('importer', () => {
  it('detects the three formats', () => {
    expect(detectFormat(fixture('templates/ashworth-cbo.json'))).toBe('template');
    expect(detectFormat(GRAPH_EXPORT)).toBe('graph');
    expect(detectFormat(UNKNOWN_EXPORT)).toBe('unknown');
  });

  it('converts plain Meta API fields into the template shape', () => {
    const { template: t, notes } = fromGraphExport(GRAPH_EXPORT);
    expect(t.campaign.budget.mode).toBe('CBO');
    expect(t.campaign.budget.daily_budget_minor).toBe(5000);
    expect(t.adset_count).toBe(2);
    expect(t.ads_per_adset).toBe(2);
    expect(t.adset.targeting.advantage_audience).toBe(true);
    expect(t.adset.targeting.genders).toEqual([1]);
    expect(t.adset.schedule.start_time).toBe(new Date(1789600000 * 1000).toISOString());
    expect(t.adset_variants[0]).toMatchObject({ name: 'US - Formal Wear', interests: [{ id: '6003290737525', name: 'Formal wear' }] });
    expect(t.ad).toMatchObject({ primary_text: 'Body text', headline: 'Headline', destination_url: 'https://example-store.com/products/ashworth-leather-penny-loafers', page_id: '100000000000001', default_cta: 'SHOP_NOW' });
    expect(notes.join(' ')).toMatch(/flexible_spec/);
    expect(Template.safeParse(t).success).toBe(true);
  });

  it('a mapping builds a valid template, money in whole units is converted, and the signature is stable per shape', () => {
    const mapping = { name: { from: 'title' }, 'campaign.objective': { from: 'goal' }, 'campaign.budget.mode': { from: null, value: 'CBO' }, 'campaign.budget.daily_budget_minor': { from: 'budget_usd', unit: 'major' as const }, 'adset.optimization_goal': { from: null, value: 'OFFSITE_CONVERSIONS' }, 'adset.billing_event': { from: null, value: 'IMPRESSIONS' }, 'ad.primary_text': { from: 'creative.body' }, 'ad.headline': { from: 'creative.title' }, 'ad.destination_url': { from: 'creative.url' }, adset_variants: { from: 'audiences' } };
    const r = applyMapping(UNKNOWN_EXPORT, mapping);
    expect(r.problems).toEqual([]);
    expect(r.template).not.toBeNull();
    expect(r.template!.campaign.budget.daily_budget_minor).toBe(4550);
    expect(r.template!.adset_variants.map((v) => v.name)).toEqual(['US - Broad', 'US - Formal Wear']);
    expect(r.template!.adset_count).toBe(2);
    const bad = applyMapping(UNKNOWN_EXPORT, { ...mapping, 'ad.headline': { from: 'creative.nope' } });
    expect(bad.template).toBeNull();
    expect(bad.problems.join(' ')).toMatch(/ad.headline/);
    expect(shapeSignature(UNKNOWN_EXPORT)).toBe(shapeSignature({ ...UNKNOWN_EXPORT, title: 'Other', budget_usd: 9 }));
    expect(shapeSignature(UNKNOWN_EXPORT)).not.toBe(shapeSignature(GRAPH_EXPORT));
  });

  it('unknown format: one writer run proposes a mapping; confirming saves a profile and the next file of that shape costs 0 runs', async () => {
    const proposal = { mapping: [{ target: 'name', from: 'title' }, { target: 'campaign.objective', from: 'goal' }, { target: 'campaign.budget.mode', from: null, value: 'CBO' }, { target: 'campaign.budget.daily_budget_minor', from: 'budget_usd' }, { target: 'adset.optimization_goal', from: null, value: 'OFFSITE_CONVERSIONS' }, { target: 'adset.billing_event', from: null, value: 'IMPRESSIONS' }, { target: 'ad.primary_text', from: 'creative.body' }, { target: 'ad.headline', from: 'creative.title' }, { target: 'ad.destination_url', from: 'creative.url' }, { target: 'adset_variants', from: 'audiences' }], notes: ['budget_usd looked like whole dollars'] };
    const cli = fakeCli({ claude: (c: CliCall) => (c.args[0] === 'auth' ? { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) } : { stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: proposal }) }) });
    const ctx = testContext(undefined, { runCli: cli.run });
    const app = createApp(ctx);
    const post = (p: string, body: unknown) => app.request(p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

    const first = (await (await post('/api/templates', UNKNOWN_EXPORT)).json()) as { kind: string; signature: string; mapping: Record<string, unknown>; problems: string[]; writer: string };
    expect(first.kind).toBe('proposal');
    expect(first.writer).toBe('claude_code');
    expect(first.problems).toEqual(['budget_usd looked like whole dollars']);
    expect(cli.of('claude').filter((c) => c.args[0] === '-p')).toHaveLength(1);
    const prompt = cli.of('claude').find((c) => c.args[0] === '-p')!.args[1]!;
    expect(prompt).toContain('audiences[].label');

    const confirmed = (await (await post('/api/templates/import/confirm', { signature: first.signature, mapping: first.mapping, raw: UNKNOWN_EXPORT })).json()) as { kind: string; format: string; template: { name: string; mode: string }; notes: string[] };
    expect(confirmed).toMatchObject({ kind: 'imported', format: 'profile', template: { name: 'Loafers spring', mode: 'CBO' } });
    expect(confirmed.notes.join(' ')).toMatch(/import profile saved/i);

    // Same shape, different values: no writer run this time.
    const second = (await (await post('/api/templates', { ...UNKNOWN_EXPORT, title: 'Loafers summer', budget_usd: 60 })).json()) as { kind: string; format: string; template: { name: string; campaignBudgetMinor: number } };
    expect(second).toMatchObject({ kind: 'imported', format: 'profile', template: { name: 'Loafers summer', campaignBudgetMinor: 6000 } });
    expect(cli.of('claude').filter((c) => c.args[0] === '-p')).toHaveLength(1);
    expect(ctx.db.select().from(requests).all()).toHaveLength(0);
    await ctx.close();
  });

  it('the template copy is saved on the product with the matching handle, or the handle is reported', () => {
    const ctx = testContext();
    const t = Template.parse(fixture('templates/ashworth-cbo.json'));
    expect(linkTemplateCopy(ctx.db, t)).toEqual({ linked: null, handle: 'ashworth-leather-penny-loafers' });
    const pid = ctx.db.insert(products).values({ origin: 'shopify', state: 'editing_in_shopify', shopifyHandle: 'ashworth-leather-penny-loafers' }).returning({ id: products.id }).get().id;
    expect(linkTemplateCopy(ctx.db, t).linked).toBe(pid);
    linkTemplateCopy(ctx.db, t); // idempotent
    const copies = ctx.db.select().from(productCopy).all();
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ productId: pid, headline: 'Ashworth Leather Penny Loafers', sourceTemplateId: 'tmpl_ee75ef60' });
    void ctx.close();
  });

  it('a product for a template handle is pulled with one query by handle', async () => {
    const byHandle = { data: { productByIdentifier: (fixture('shopify/product.json') as { data: { product: unknown } }).data.product, shop: { currencyCode: 'USD' } } };
    const ff = fakeFetch({ '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')), 'graphql.json': (r: Recorded) => (r.body!.includes('productByIdentifier') ? json(byHandle) : json(fixture('shopify/product.json'))) });
    const ctx = testContext(ff.impl);
    await ctx.secrets.set('shopify_client_id', 'cid');
    await ctx.secrets.set('shopify_client_secret', 'shpss_secret1234567890');
    ctx.settings.set('connections', { shopify: { storeDomain: 'x.myshopify.com' } });
    const app = createApp(ctx);
    const r = (await (await app.request('/api/line/from-handle', { method: 'POST', body: JSON.stringify({ handle: 'linen-oversized-blazer' }), headers: { 'content-type': 'application/json' } })).json()) as { kind: string; productId: number };
    expect(r.kind).toBe('importing');
    await ctx.worker.drain();
    expect(ctx.worker.list()[0]!.status).toBe('done');
    expect(ff.calls.filter((c) => c.url.includes('graphql.json'))).toHaveLength(1);
    expect(JSON.parse(ff.calls.find((c) => c.url.includes('graphql.json'))!.body!).variables).toEqual({ handle: 'linen-oversized-blazer' });
    const p = (await (await app.request(`/api/products/${r.productId}`)).json()) as { state: string; shopifyProductId: string };
    expect(p).toMatchObject({ state: 'from_shopify', shopifyProductId: 'gid://shopify/Product/8001' });
    expect(((await (await app.request('/api/line/from-handle', { method: 'POST', body: JSON.stringify({ handle: 'linen-oversized-blazer' }), headers: { 'content-type': 'application/json' } })).json()) as { kind: string }).kind).toBe('duplicate');
    await ctx.close();
  });
});

const SNAPSHOT = ShopifySnapshot.parse({ id: 'gid://shopify/Product/8001', handle: 'ashworth-leather-penny-loafers', title: 'Ashworth Leather Penny Loafers', status: 'ACTIVE', descriptionHtml: '<p>x</p>', productType: 'Loafers', tags: [], vendor: 'conveyor', onlineStoreUrl: 'https://example-store.com/products/ashworth-leather-penny-loafers', featuredImage: null, images: [], options: [], variants: [{ id: 'v1', title: 'S', sku: null, priceMinor: 8999, compareAtPriceMinor: null, imageId: null }], currency: 'USD', updatedAt: '2026-09-15T10:00:00Z', fetchedAt: new Date().toISOString() });

function graph() {
  let seq = 0;
  const sent: { ops: { name?: string; relative_url: string; body?: string; method: string }[] }[] = [];
  const reads: string[] = [];
  const live = { id: '120208', name: 'CAMP', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '10000', adsets: { data: [{ id: '120209', name: 'CAMP – US - broad 1', status: 'PAUSED', targeting: { flexible_spec: [] }, ads: { data: [{ id: '120210', name: 'ash_4x5_01.jpg', status: 'PAUSED', creative: { id: '120211' } }] } }] } };
  const route = (r: Recorded) => {
    if (r.method === 'GET') {
      reads.push(r.url);
      return json(live);
    }
    if (!r.form?.batch) return json({ success: true });
    const ops = JSON.parse(r.form.batch as string) as { name?: string; relative_url: string; body?: string; method: string }[];
    sent.push({ ops });
    return json(ops.map((op) => (op.relative_url.endsWith('/adimages') ? { code: 200, body: JSON.stringify({ images: { x: { hash: `h${++seq}` } } }) } : op.relative_url.includes('search?type=adinterest') ? { code: 200, body: JSON.stringify({ data: [{ id: '6003290737525', name: 'Formal wear' }] }) } : { code: 200, body: JSON.stringify({ id: `1202${++seq}`, success: true }) })));
  };
  return { route, sent, reads, live };
}

async function launched(g = graph()) {
  const ff = fakeFetch({ 'graph.facebook.com': g.route, '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')), 'graphql.json': () => json(fixture('shopify/product.json')) });
  const ctx = testContext(ff.impl);
  await ctx.secrets.set('meta_access_token', 'EAAMetaSecretToken1234567890');
  ctx.settings.set('connections', { meta: { adAccountId: 'act_1', pageId: '100000000000001', pixelId: '1000000000000001' }, shopify: { storeDomain: 'x.myshopify.com' } });
  const pid = ctx.db.insert(products).values({ origin: 'shopify', state: 'ready_to_launch', shopifyProductId: SNAPSHOT.id, shopifyHandle: SNAPSHOT.handle, title: SNAPSHOT.title, snapshot: SNAPSHOT, snapshotAt: SNAPSHOT.fetchedAt }).returning({ id: products.id }).get().id;
  const batchId = ctx.db.insert(creativeBatches).values({ productId: pid, prompt: 'p', engine: 'codex', status: 'done', formats: ['4:5'], countPerFormat: 3 }).returning({ id: creativeBatches.id }).get().id;
  const dir = path.join(ctx.dataDir, 'c');
  fs.mkdirSync(dir, { recursive: true });
  const cids: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const file = path.join(dir, `ash_4x5_0${i}.jpg`);
    fs.writeFileSync(file, MUG);
    cids.push(ctx.db.insert(creatives).values({ batchId, productId: pid, aspect: '4:5', slot: i, status: 'finished', approval: 'approved', fileName: path.basename(file), finishedPath: file, metadataCheck: 'clean (sharp, exiftool)' }).returning({ id: creatives.id }).get().id);
  }
  const t = storeTemplate(ctx.db, Template.parse(fixture('templates/ashworth-cbo.json')), 'file');
  const app = createApp(ctx);
  const post = (p: string, body: unknown = {}) => app.request(p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const metaRequests = () => ctx.db.select().from(requests).all().filter((r) => r.service === 'meta');
  return { ctx, app, post, pid, templateId: t.id, g, ff, cids, metaRequests };
}

describe('board', () => {
  it('a board-edited structure launches as given, and can be saved as a template file', async () => {
    const t = await launched();
    const preview = (await (await t.app.request(`/api/products/${t.pid}/launch-preview?templateId=${t.templateId}`)).json()) as { structure: { campaignName: string; adSets: { index: number; name: string; ads: unknown[]; interests: unknown[] }[] } };
    const board = { campaignName: 'Board test', adSets: [{ ...preview.structure.adSets[0]!, name: 'Board test – US - Formal Wear', interests: [{ id: '6003290737525', name: 'Formal wear' }], interestKind: 'picked', ads: preview.structure.adSets[0]!.ads.slice(0, 2) }] };
    const p2 = (await (await t.post(`/api/products/${t.pid}/launch-preview`, { templateId: t.templateId, structure: board })).json()) as { operations: number; structure: { adSets: unknown[] } };
    expect(p2.structure.adSets).toHaveLength(1);
    expect(p2.operations).toBe(1 + 1 + 2 + 2);
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId, structure: board });
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list().find((j) => j.type === 'launch')!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const objects = t.g.sent.at(-1)!.ops;
    expect(objects.filter((o) => o.relative_url.endsWith('adsets'))).toHaveLength(1);
    expect(new URLSearchParams(objects[0]!.body).get('name')).toBe('Board test');
    const tg = JSON.parse(new URLSearchParams(objects[1]!.body).get('targeting')!) as { flexible_spec: { interests: { id: string }[] }[] };
    expect(tg.flexible_spec[0]!.interests[0]!.id).toBe('6003290737525');

    const saved = (await (await t.post('/api/templates/board', { templateId: t.templateId, name: 'Ashworth board', structure: board })).json()) as { id: number; name: string; adSetCount: number; fileName: string };
    expect(saved).toMatchObject({ name: 'Ashworth board', adSetCount: 1, fileName: 'Ashworth_board.json' });
    const tj = Template.parse(t.ctx.db.select().from(templates).all().find((r) => r.id === saved.id)!.json);
    expect(tj.adset_variants[0]).toMatchObject({ name: 'US - Formal Wear', interests: [{ id: '6003290737525' }] });
    expect(tj.x_conveyor?.fillRule).toBe('manual');
    await t.ctx.close();
  });

  it('a board that uses an unapproved creative is refused', async () => {
    const t = await launched();
    const board = { campaignName: 'x', adSets: [{ index: 0, name: 'x – US - Broad', budgetMinor: null, interestKind: 'broad', interestLabel: null, interests: [], suggestions: [], countryOverride: null, ageBand: null, ads: [{ creativeId: 999, fileName: 'ghost.jpg', primaryText: 'p', headline: 'h', description: '', destinationUrl: 'u' }] }] };
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId, structure: board });
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list().find((j) => j.type === 'launch')!;
    expect(job.status).toBe('failed');
    expect(job.error!.message).toMatch(/not approved/);
    expect(t.metaRequests()).toHaveLength(0);
    await t.ctx.close();
  });

  it('renaming "US - Interest 1" to a real interest costs at most 1 request, and 0 once cached', async () => {
    const t = await launched();
    const r1 = (await (await t.post('/api/interests/resolve', { name: 'CAMP – US - Interest 1' })).json()) as { kind: string; requests: number };
    expect(r1).toMatchObject({ kind: 'placeholder', requests: 0 });
    const r2 = (await (await t.post('/api/interests/resolve', { name: 'CAMP – US - Formal Wear' })).json()) as { kind: string; requests: number; interests: { id: string }[] };
    expect(r2).toMatchObject({ kind: 'lookup', requests: 1, interests: [{ id: '6003290737525' }] });
    const r3 = (await (await t.post('/api/interests/resolve', { name: 'Other – US - formal wear' })).json()) as { requests: number };
    expect(r3.requests).toBe(0);
    expect(t.metaRequests().filter((r) => r.purpose === 'interest_search')).toHaveLength(1);
    await t.ctx.close();
  });
});

describe('live editing', () => {
  it('read is one request with nested fields; a second read shows the differences', async () => {
    const t = await launched();
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    await t.ctx.worker.drain();
    const camp = t.ctx.db.select().from(campaigns).get()!;
    await t.post(`/api/campaigns/${camp.id}/read`);
    await t.ctx.worker.drain();
    expect(t.g.reads).toHaveLength(1);
    expect(decodeURIComponent(t.g.reads[0]!)).toContain('adsets.limit(100){');
    let live = (await (await t.app.request(`/api/campaigns/${camp.id}/live`)).json()) as { live: { name: string; adSets: { ads: unknown[] }[] } | null; diff: unknown[] };
    expect(live.live!.name).toBe('CAMP');
    expect(live.live!.adSets[0]!.ads).toHaveLength(1);
    expect(live.diff).toEqual([]);

    t.g.live.status = 'ACTIVE';
    t.g.live.adsets.data[0]!.status = 'ACTIVE';
    await t.post(`/api/campaigns/${camp.id}/read`);
    await t.ctx.worker.drain();
    live = (await (await t.app.request(`/api/campaigns/${camp.id}/live`)).json()) as typeof live;
    expect(live.diff).toEqual([
      { path: 'campaign.status', before: 'PAUSED', after: 'ACTIVE' },
      { path: 'adset CAMP – US - broad 1.status', before: 'PAUSED', after: 'ACTIVE' },
    ]);
    await t.ctx.close();
  });

  it('adding an ad set to a live campaign is 2 requests: the read and one batch (images already have hashes)', async () => {
    const t = await launched();
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    await t.ctx.worker.drain();
    const camp = t.ctx.db.select().from(campaigns).get()!;
    const before = t.metaRequests().length;
    await t.post(`/api/campaigns/${camp.id}/read`);
    await t.ctx.worker.drain();
    const live = (await (await t.app.request(`/api/campaigns/${camp.id}/live`)).json()) as { live: { readAt: string } };
    const change = { type: 'add_adset', adSet: { index: 3, name: 'CAMP – US - Formal Wear', budgetMinor: null, interestKind: 'file', interestLabel: null, interests: [{ id: '6003290737525', name: 'Formal wear' }], suggestions: [], countryOverride: null, ageBand: null, ads: [{ creativeId: t.cids[0], fileName: 'ash_4x5_01.jpg', primaryText: 'Body', headline: 'Head', description: '', destinationUrl: 'https://example-store.com/products/x' }] } };

    const plan = (await (await t.post(`/api/campaigns/${camp.id}/edits/preview`, { changes: [change], basedOn: live.live.readAt })).json()) as { warnings: string[]; requests: number };
    expect(plan.warnings.join(' ')).toMatch(/restarts learning/);
    expect(plan.requests).toBe(2);

    // Without acknowledging the learning warning nothing is sent.
    await t.post(`/api/campaigns/${camp.id}/edits`, { changes: [change], basedOn: live.live.readAt });
    await t.ctx.worker.drain();
    expect(t.ctx.worker.list()[0]!.status).toBe('failed');
    expect(t.metaRequests().length - before).toBe(1);

    await t.post(`/api/campaigns/${camp.id}/edits`, { changes: [change], basedOn: live.live.readAt, acknowledgeLearning: true });
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list()[0]!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    expect(t.metaRequests().length - before).toBe(2);
    const ops = t.g.sent.at(-1)!.ops;
    expect(ops.map((o) => o.relative_url.split('/').pop())).toEqual(['adcreatives', 'adsets', 'ads']);
    expect(new URLSearchParams(ops[1]!.body).get('status')).toBe('PAUSED');
    expect(new URLSearchParams(ops[1]!.body).get('campaign_id')).toBe('120208');
    expect(t.ctx.db.select().from(campaignEdits).all()).toHaveLength(1);
    await t.ctx.close();
  });

  it('removals pause, budgets follow the mode, a stale read is refused, and the creative swap updates the ad', async () => {
    const t = await launched();
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    await t.ctx.worker.drain();
    const camp = t.ctx.db.select().from(campaigns).get()!;
    await t.post(`/api/campaigns/${camp.id}/read`);
    await t.ctx.worker.drain();
    const { live } = (await (await t.app.request(`/api/campaigns/${camp.id}/live`)).json()) as { live: { readAt: string } };

    const stale = await t.post(`/api/campaigns/${camp.id}/edits`, { changes: [{ type: 'ad_status', adId: '120210', status: 'PAUSED' }], basedOn: '2020-01-01T00:00:00.000Z' });
    expect(stale.status).toBe(202);
    await t.ctx.worker.drain();
    expect(t.ctx.worker.list()[0]!.error!.message).toMatch(/read again/);

    const changes = [
      { type: 'ad_status', adId: '120210', status: 'PAUSED' },
      { type: 'campaign_budget', dailyBudgetMinor: 11000 },
      { type: 'rename_adset', adSetId: '120209', name: 'CAMP – US - broad renamed' },
      { type: 'replace_ad_creative', adId: '120210', ad: { creativeId: t.cids[1], fileName: 'ash_4x5_02.jpg', primaryText: 'Body', headline: 'Head', description: '', destinationUrl: 'https://example-store.com/products/x' } },
    ];
    await t.post(`/api/campaigns/${camp.id}/edits`, { changes, basedOn: live.readAt, acknowledgeLearning: true });
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list()[0]!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const ops = t.g.sent.at(-1)!.ops;
    expect(ops[0]!.relative_url.endsWith('adcreatives')).toBe(true);
    expect(ops.find((o) => o.relative_url === '120210' && new URLSearchParams(o.body).get('status') === 'PAUSED')).toBeTruthy();
    expect(ops.find((o) => o.relative_url === '120208' && new URLSearchParams(o.body).get('daily_budget') === '11000')).toBeTruthy();
    expect(ops.find((o) => o.relative_url === '120209' && new URLSearchParams(o.body).get('name') === 'CAMP – US - broad renamed')).toBeTruthy();
    expect(ops.find((o) => o.relative_url === '120210' && new URLSearchParams(o.body).get('creative')?.includes('{result=cr1:$.id}'))).toBeTruthy();
    expect(ops.every((o) => o.method !== 'DELETE')).toBe(true);
    await t.ctx.close();
  });

  it('learning warnings cover adds, targeting and budget jumps over 20%', () => {
    const live = { id: '1', name: 'c', status: 'ACTIVE', effectiveStatus: null, dailyBudgetMinor: 10000, lifetimeBudgetMinor: null, adSets: [{ id: 's1', name: 'S1', status: 'ACTIVE', dailyBudgetMinor: 2000, lifetimeBudgetMinor: null, interests: [], ads: [] }], readAt: 'now' };
    expect(learningWarnings([{ type: 'adset_budget', adSetId: 's1', dailyBudgetMinor: 2300 }], live)).toEqual([]);
    expect(learningWarnings([{ type: 'adset_budget', adSetId: 's1', dailyBudgetMinor: 3000 }], live)[0]).toMatch(/over 20%/);
    expect(learningWarnings([{ type: 'adset_interests', adSetId: 's1', interests: [] }], live)[0]).toMatch(/targeting/);
    expect(learningWarnings([{ type: 'campaign_budget', dailyBudgetMinor: 15000 }], live)[0]).toMatch(/over 20%/);
    expect(diffLive(null, live)).toEqual([]);
  });
});
