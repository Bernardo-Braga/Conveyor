import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShopifySnapshot, Template } from '@conveyor/shared';
import { createApp } from '../src/app.ts';
import { adSets, ads, campaigns, creatives, creativeBatches, products, requests } from '../src/db/schema.ts';
import { fillCreatives, launchCounts } from '../src/meta/launch.ts';
import { preflight } from '../src/meta/preflight.ts';
import { storeTemplate } from '../src/meta/templates.ts';
import { FIXTURES, fakeFetch, fixture, json, testContext, type Recorded } from './helpers.ts';

const MUG = fs.readFileSync(path.join(FIXTURES, 'images', 'codex-mug.png'));
const SNAPSHOT = ShopifySnapshot.parse({
  id: 'gid://shopify/Product/8001', handle: 'ashworth-leather-penny-loafers', title: 'Ashworth Leather Penny Loafers', status: 'ACTIVE', descriptionHtml: '<p>x</p>', productType: 'Loafers', tags: [], vendor: 'conveyor',
  onlineStoreUrl: 'https://example-store.com/products/ashworth-leather-penny-loafers', featuredImage: null, images: [], options: [], variants: [{ id: 'v1', title: 'S', sku: null, priceMinor: 8999, compareAtPriceMinor: null, imageId: null }], currency: 'USD', updatedAt: '2026-09-15T10:00:00Z', fetchedAt: new Date().toISOString(),
});

/** A fake Graph endpoint: returns IDs for every batch operation, or fails the named ones. */
function graph(opts: { failNames?: string[]; failOnce?: boolean } = {}) {
  let failed = false;
  let seq = 0;
  const sent: { url: string; ops: { name?: string; relative_url: string; body?: string; attached_files?: string }[] }[] = [];
  const route = (r: Recorded) => {
    if (!r.form?.batch) return json({ id: 'single' });
    const ops = JSON.parse(r.form.batch as string) as { name?: string; relative_url: string; body?: string; attached_files?: string }[];
    sent.push({ url: r.url, ops });
    const results = ops.map((op) => {
      if (op.relative_url.includes('search?type=adinterest')) return { code: 200, body: JSON.stringify({ data: [{ id: '6003290737525', name: 'Formal wear' }] }) };
      if (op.relative_url.endsWith('/adimages')) return { code: 200, body: JSON.stringify({ images: { [op.attached_files!]: { hash: `hash_${op.attached_files}_${++seq}` } } }) };
      if (op.relative_url.endsWith('/previews')) return { code: 200, body: JSON.stringify({ data: [{ body: '<iframe>preview</iframe>' }] }) };
      if (opts.failNames?.includes(op.name ?? '') && (!opts.failOnce || !failed)) {
        failed = true;
        return { code: 400, body: JSON.stringify(fixture('meta/error-4834011.json')) };
      }
      return { code: 200, body: JSON.stringify({ id: `12020${++seq}` }) };
    });
    return json(results, 200, { 'x-fb-trace-id': `trace${sent.length}` });
  };
  return { route, sent };
}

async function setup(templateFile: string, approved = 6, g = graph()) {
  const ff = fakeFetch({ 'graph.facebook.com': g.route, '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')), 'graphql.json': () => json(fixture('shopify/product.json')) });
  const ctx = testContext(ff.impl);
  await ctx.secrets.set('meta_access_token', 'EAAMetaSecretToken1234567890');
  ctx.settings.set('connections', { meta: { adAccountId: 'act_1234567890', pageId: '100000000000001', instagramUserId: '', pixelId: '1000000000000001' }, shopify: { storeDomain: 'x.myshopify.com' } });
  const pid = ctx.db.insert(products).values({ origin: 'shopify', state: 'ready_to_launch', shopifyProductId: SNAPSHOT.id, shopifyHandle: SNAPSHOT.handle, title: SNAPSHOT.title, snapshot: SNAPSHOT, snapshotAt: SNAPSHOT.fetchedAt }).returning({ id: products.id }).get().id;
  const batchId = ctx.db.insert(creativeBatches).values({ productId: pid, prompt: 'p', engine: 'codex', status: 'done', formats: ['4:5'], countPerFormat: approved }).returning({ id: creativeBatches.id }).get().id;
  const dir = path.join(ctx.dataDir, 'creatives');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= approved; i++) {
    const file = path.join(dir, `ashworth_4x5_0${i}.jpg`);
    fs.writeFileSync(file, MUG);
    ctx.db.insert(creatives).values({ batchId, productId: pid, aspect: '4:5', slot: i, status: 'finished', approval: 'approved', fileName: path.basename(file), finishedPath: file, metadataCheck: 'clean (sharp, exiftool)' }).run();
  }
  const t = storeTemplate(ctx.db, Template.parse(fixture(templateFile)), 'file');
  ctx.settings.set('adsetup', { defaultTemplateId: t.id });
  const app = createApp(ctx);
  const post = (p: string, body: unknown = {}) => app.request(p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const metaRequests = () => ctx.db.select().from(requests).all().filter((r) => r.service === 'meta');
  return { ctx, app, post, pid, templateId: t.id, g, ff, metaRequests };
}

describe('fill rules and counts', () => {
  const pool = [1, 2, 3, 4].map((id) => ({ id, aspect: (id === 4 ? '9:16' : '4:5') as '4:5' | '9:16' }));
  it('one_per_ad puts the same creatives in every ad set; rotate spreads; one_per_adset differs; by_format sends 9:16 to reels', () => {
    expect(fillCreatives('one_per_ad', ['a', 'b'], 3, pool)).toEqual([[1, 2, 3], [1, 2, 3]]);
    expect(fillCreatives('rotate', ['a', 'b'], 3, pool)).toEqual([[1, 2, 3], [4, 1, 2]]);
    expect(fillCreatives('one_per_adset', ['a', 'b', 'c'], 3, pool)).toEqual([[1], [2], [3]]);
    expect(fillCreatives('by_format', ['US - Reels', 'US - Feed'], 2, pool)).toEqual([[4], [1, 2]]);
    expect(fillCreatives('manual', ['a'], 3, pool)).toEqual([[]]);
  });
  it('Ashworth is 28 operations in one batch, Whitcombe 36', () => {
    const a = { campaignName: 'x', adSets: [1, 2, 3].map((i) => ({ index: i, name: `s${i}`, budgetMinor: null, interestKind: 'broad' as const, interestLabel: null, interests: [], suggestions: [], countryOverride: null, ageBand: null, ads: Array.from({ length: 6 }, (_, j) => ({ creativeId: j + 1, fileName: `f${j}`, primaryText: 'p', headline: 'h', description: '', destinationUrl: 'u' })) })) };
    expect(launchCounts(a, 6, 6)).toEqual({ operations: 28, batches: 1, requests: 2 });
    const w = { ...a, adSets: [1, 2, 3, 4, 5].map((i) => ({ ...a.adSets[0]!, index: i, ads: a.adSets[0]!.ads.slice(0, 5) })) };
    expect(launchCounts(w, 5, 0)).toEqual({ operations: 36, batches: 1, requests: 1 });
  });
});

describe('launch preview and preflight', () => {
  it('shows the structure, counts and checks without any request; a draft product blocks', async () => {
    const t = await setup('templates/ashworth-cbo.json');
    const res = await t.app.request(`/api/products/${t.pid}/launch-preview?templateId=${t.templateId}`);
    const p = (await res.json()) as { mode: string; operations: number; imageUploads: number; requests: number; canLaunch: boolean; checks: { id: string; level: string }[]; structure: { adSets: { name: string; interestKind: string; interests: { id: string }[]; ads: unknown[] }[] } };
    expect(p.mode).toBe('CBO');
    expect(p.structure.adSets).toHaveLength(3);
    expect(p.structure.adSets.every((s) => s.ads.length === 6)).toBe(true);
    expect(p.structure.adSets[2]).toMatchObject({ interestKind: 'file', interests: [{ id: '6003290737525' }] });
    expect(p.operations).toBe(28);
    expect(p.imageUploads).toBe(6);
    expect(p.requests).toBe(2);
    expect(p.canLaunch).toBe(true);
    expect(p.checks.map((c) => c.id)).toContain('start_time');
    expect(t.metaRequests()).toHaveLength(0);

    t.ctx.db.update(products).set({ snapshot: { ...SNAPSHOT, status: 'DRAFT' } }).where((await import('drizzle-orm')).eq(products.id, t.pid)).run();
    const blocked = (await (await t.app.request(`/api/products/${t.pid}/launch-preview?templateId=${t.templateId}`)).json()) as { canLaunch: boolean; checks: { id: string; level: string }[] };
    expect(blocked.canLaunch).toBe(false);
    expect(blocked.checks.find((c) => c.id === 'product_state')?.level).toBe('block');
    await t.ctx.close();
  });

  it('Whitcombe: placeholders are acknowledgeable warnings, the mode mismatch is noted, and the launch is 36 operations', async () => {
    const t = await setup('templates/whitcombe-abo.json', 5);
    const p = (await (await t.app.request(`/api/products/${t.pid}/launch-preview?templateId=${t.templateId}`)).json()) as { mode: string; operations: number; canLaunch: boolean; checks: { id: string; level: string; acknowledgeable: boolean }[]; structure: { adSets: { interestKind: string; budgetMinor: number | null }[] } };
    expect(p.mode).toBe('ABO');
    expect(p.operations).toBe(36);
    expect(p.structure.adSets.map((s) => s.interestKind)).toEqual(['broad', 'placeholder', 'placeholder', 'placeholder', 'placeholder']);
    expect(p.structure.adSets.every((s) => s.budgetMinor === 2000)).toBe(true);
    expect(p.checks.find((c) => c.id === 'interest_placeholder')).toMatchObject({ level: 'warn', acknowledgeable: true });
    expect(p.checks.find((c) => c.id === 'mode_mismatch')).toBeTruthy();
    expect(p.canLaunch).toBe(false);
    const ack = (await (await t.app.request(`/api/products/${t.pid}/launch-preview?templateId=${t.templateId}&acknowledge=interest_placeholder`)).json()) as { canLaunch: boolean };
    expect(ack.canLaunch).toBe(true);
    await t.ctx.close();
  });

  it('preflight blocks unapproved or unclean creatives and empty ad sets', () => {
    const t = Template.parse(fixture('templates/ashworth-cbo.json'));
    const structure = { campaignName: 'c', adSets: [{ index: 0, name: 'a', budgetMinor: null, interestKind: 'broad' as const, interestLabel: null, interests: [], suggestions: [], countryOverride: null, ageBand: null, ads: [{ creativeId: 1, fileName: 'f', primaryText: 'p', headline: 'h', description: '', destinationUrl: 'u' }] }, { index: 1, name: 'b', budgetMinor: null, interestKind: 'broad' as const, interestLabel: null, interests: [], suggestions: [], countryOverride: null, ageBand: null, ads: [] }] };
    const checks = preflight({ template: t, structure, snapshot: SNAPSHOT, creatives: [{ id: 1, metadataCheck: 'metadata left: XMP', approval: 'pending', status: 'finished' }], pageId: '1', pixelId: '2', adAccountId: 'act_1', tokenSet: true });
    const ids = checks.filter((c) => c.level === 'block').map((c) => c.id).sort();
    expect(ids).toEqual(['approved_only', 'clean_jpegs', 'empty_adset']);
  });
});

describe('launching', () => {
  it('Ashworth: 1 upload batch + 1 object batch, everything PAUSED, IDs saved, product paused in Meta', async () => {
    const t = await setup('templates/ashworth-cbo.json');
    const res = await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    expect(res.status).toBe(202);
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list().find((j) => j.type === 'launch')!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    expect(job.completedSteps).toEqual(['snapshot', 'interests', 'preflight', 'upload', 'objects', 'finish']);
    expect(t.metaRequests().map((r) => r.purpose)).toEqual(['adimages', 'launch_objects']);
    expect(t.g.sent[0]!.ops).toHaveLength(6);
    expect(t.g.sent[0]!.ops.every((o) => o.relative_url === 'act_1234567890/adimages' && o.attached_files)).toBe(true);
    const objects = t.g.sent[1]!.ops;
    expect(objects).toHaveLength(28);
    const kinds = objects.map((o) => o.relative_url.split('/')[1]);
    expect(kinds.filter((k) => k === 'campaigns')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'adsets')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'adcreatives')).toHaveLength(6);
    expect(kinds.filter((k) => k === 'ads')).toHaveLength(18);
    for (const op of objects) {
      const body = new URLSearchParams(op.body ?? '');
      if (!op.relative_url.endsWith('adcreatives')) expect(body.get('status')).toBe('PAUSED');
      if (op.relative_url.endsWith('campaigns')) {
        expect(body.get('daily_budget')).toBe('10000');
        expect(body.get('is_adset_budget_sharing_enabled')).toBeNull();
      }
      if (op.relative_url.endsWith('adsets')) {
        expect(body.get('daily_budget')).toBeNull();
        expect(body.get('campaign_id')).toBe('{result=campaign:$.id}');
        const tg = JSON.parse(body.get('targeting')!) as { targeting_automation: { advantage_audience: number }; age_max?: number; flexible_spec?: unknown[] };
        // Broad ad sets keep Advantage+ audience on; the Formal wear one runs with it off, since the two cannot be combined.
        if (tg.flexible_spec) expect(tg.targeting_automation.advantage_audience).toBe(0);
        else {
          expect(tg.targeting_automation.advantage_audience).toBe(1);
          expect(tg.age_max).toBeUndefined();
        }
      }
      if (op.relative_url.endsWith('adcreatives')) {
        const spec = JSON.parse(body.get('object_story_spec')!) as { page_id: string; link_data: { image_hash: string; call_to_action: { type: string } } };
        expect(spec.page_id).toBe('100000000000001');
        expect(spec.link_data.image_hash).toMatch(/^hash_img/);
        expect(spec.link_data.call_to_action.type).toBe('SHOP_NOW');
      }
    }
    const camp = (await (await t.app.request(`/api/products/${t.pid}/campaigns`)).json()) as { status: string; metaCampaignId: string; operations: number; completed: number; adSets: { metaId: string; ads: { metaAdId: string }[] }[] }[];
    expect(camp[0]).toMatchObject({ status: 'paused', operations: 28, completed: 28 });
    expect(camp[0]!.metaCampaignId).toMatch(/^12020/);
    expect(camp[0]!.adSets.every((s) => s.metaId && s.ads.every((a) => a.metaAdId))).toBe(true);
    expect(((await (await t.app.request(`/api/products/${t.pid}`)).json()) as { state: string }).state).toBe('paused_in_meta');
    expect(t.ctx.db.select().from(creatives).all().every((c) => c.metaImageHash)).toBe(true);
    expect(JSON.stringify(t.metaRequests())).not.toContain('MetaSecret');
    await t.ctx.close();
  });

  it('Whitcombe: 36 operations, campaign sends sharing false and no budget, ad sets 2000 each; placeholders launch broad after acknowledgement', async () => {
    const t = await setup('templates/whitcombe-abo.json', 5);
    // The fixture's start time (17 Sep 2026) is now in the past; pin a future one so the "kept" branch is exercised.
    const FUTURE = '2030-01-15T10:00:00.000Z';
    const stored = Template.parse(fixture('templates/whitcombe-abo.json'));
    stored.adset.schedule.start_time = FUTURE;
    storeTemplate(t.ctx.db, stored, 'file');
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId, acknowledge: ['interest_placeholder'] });
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list().find((j) => j.type === 'launch')!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const objects = t.g.sent.at(-1)!.ops;
    expect(objects).toHaveLength(36);
    const campaign = new URLSearchParams(objects[0]!.body);
    expect(campaign.get('is_adset_budget_sharing_enabled')).toBe('false');
    expect(campaign.get('daily_budget')).toBeNull();
    const sets = objects.filter((o) => o.relative_url.endsWith('adsets')).map((o) => new URLSearchParams(o.body));
    expect(sets).toHaveLength(5);
    expect(sets.every((s) => s.get('daily_budget') === '2000' && s.get('bid_strategy') === 'LOWEST_COST_WITHOUT_CAP')).toBe(true);
    expect(sets.every((s) => Number(s.get('start_time')) === Math.floor(new Date(FUTURE).getTime() / 1000))).toBe(true);
    await t.ctx.close();
  });

  it('a mid-batch failure keeps every created ID; the resume sends only the missing operations, so nothing is duplicated', async () => {
    const g = graph({ failNames: ['set1'], failOnce: true });
    const t = await setup('templates/ashworth-cbo.json', 6, g);
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list().find((j) => j.type === 'launch')!;
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ step: 'objects', service: 'meta', code: '100', subcode: '4834011', retryable: true });
    let camp = (await (await t.app.request(`/api/products/${t.pid}/campaigns`)).json()) as { id: number; status: string; completed: number; lastError: string }[];
    expect(camp[0]!.status).toBe('failed');
    expect(camp[0]!.completed).toBe(27); // everything but set1 returned an ID and was saved
    expect(camp[0]!.lastError).toMatch(/set1/);

    const created = (name: string) => g.sent.flatMap((b) => b.ops).filter((o) => o.name === name).length;
    const res = await t.post(`/api/campaigns/${camp[0]!.id}/resume`);
    expect(res.status).toBe(202);
    await t.ctx.worker.drain();
    const second = t.ctx.worker.list().find((j) => j.type === 'launch' && j.id !== job.id)!;
    expect(second.status, JSON.stringify(second.error)).toBe('done');
    // The second run sent exactly one object operation, with the saved campaign ID substituted.
    const lastBatch = g.sent.at(-1)!.ops;
    expect(lastBatch).toHaveLength(1);
    expect(lastBatch[0]!.name).toBe('set1');
    expect(new URLSearchParams(lastBatch[0]!.body).get('campaign_id')).toMatch(/^12020/);
    expect(created('campaign')).toBe(1);
    expect(created('ad0_0')).toBe(1);
    expect(created('set1')).toBe(2);
    camp = (await (await t.app.request(`/api/products/${t.pid}/campaigns`)).json()) as typeof camp;
    expect(camp).toHaveLength(1);
    expect(camp[0]).toMatchObject({ status: 'paused', completed: 28 });
    // Images were not uploaded again on the resume.
    expect(t.metaRequests().filter((r) => r.purpose === 'adimages')).toHaveLength(1);
    await t.ctx.close();
  });

  it('activation is one request from the button and nothing in the launch ever sends ACTIVE', async () => {
    const t = await setup('templates/ashworth-cbo.json');
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    await t.ctx.worker.drain();
    const bodies = t.g.sent.flatMap((b) => b.ops.map((o) => o.body ?? ''));
    expect(bodies.some((b) => /status=ACTIVE/.test(b))).toBe(false);
    const camp = (await (await t.app.request(`/api/products/${t.pid}/campaigns`)).json()) as { id: number }[];
    const before = t.metaRequests().length;
    await t.post(`/api/campaigns/${camp[0]!.id}/activate`);
    await t.ctx.worker.drain();
    const after = t.metaRequests();
    expect(after.length - before).toBe(1);
    expect(after.at(-1)).toMatchObject({ purpose: 'activate', method: 'POST' });
    expect(t.ff.calls.at(-1)!.body).toBe('status=ACTIVE');
    expect(((await (await t.app.request(`/api/products/${t.pid}`)).json()) as { state: string }).state).toBe('live');
    expect(t.ctx.db.select().from(campaigns).get()!.status).toBe('active');
    await t.ctx.close();
  });

  it('insights: one account-level query at ad level lands on the ads', async () => {
    const t = await setup('templates/ashworth-cbo.json');
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    await t.ctx.worker.drain();
    const firstAd = t.ctx.db.select().from(ads).get()!;
    const ff = t.ff;
    ff.calls.length = 0;
    const insightsFixture = fixture('meta/insights.json') as { data: { ad_id: string }[] };
    insightsFixture.data[0]!.ad_id = firstAd.metaAdId!;
    // swap the graph route for insights
    const ctx2 = t.ctx;
    const orig = ctx2.ledger;
    void orig;
    const { pullInsights } = await import('../src/meta/insights.ts');
    const { MetaClient } = await import('../src/meta/client.ts');
    const ff2 = fakeFetch({ '/insights': () => json(insightsFixture) });
    const { LedgerClient } = await import('../src/http/ledgerClient.ts');
    const client = new MetaClient({ ledger: new LedgerClient({ db: ctx2.db, fetchImpl: ff2.impl }), secrets: ctx2.secrets });
    const r = await pullInsights(client, ctx2.db, 'act_1234567890', { jobId: null });
    expect(r).toEqual({ requests: 1, updated: 1, rows: 1 });
    expect(ff2.calls[0]!.url).toContain('level=ad');
    expect(ff2.calls[0]!.url).toContain('date_preset=maximum');
    const updated = t.ctx.db.select().from(ads).all().find((a) => a.id === firstAd.id)!;
    expect(updated.insights).toMatchObject({ spendMinor: 1234, purchases: 2, purchaseRoas: 3.2, clicks: 41 });
    await t.ctx.close();
  });

  it('adSets rows record how each interest was found', async () => {
    const t = await setup('templates/ashworth-cbo.json');
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    await t.ctx.worker.drain();
    expect(t.ctx.db.select().from(adSets).all().map((s) => s.interestSource)).toEqual(['none', 'none', 'file']);
    await t.ctx.close();
  });
});
