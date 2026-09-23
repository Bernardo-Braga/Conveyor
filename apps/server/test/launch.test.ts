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

type Op = { name?: string; omit_response_on_success?: boolean; method?: string; relative_url: string; body?: string; attached_files?: string };

const refName = (v: string | null): string | null => v?.match(/\{result=([A-Za-z0-9_-]+):/)?.[1] ?? null;

/**
 * A fake Graph endpoint that follows Meta's batch rules: an operation another one depends on
 * has its body omitted (`null`) unless it sends `omit_response_on_success: false`, an operation
 * whose dependency failed is not executed (`null` too), and named operations can be made to fail.
 * `legacyOmit` ignores the flag, reproducing the 17 September 2026 launch that lost 10 IDs.
 */
function graph(opts: { failNames?: string[]; failOnce?: boolean; legacyOmit?: boolean } = {}) {
  let failed = false;
  let seq = 0;
  const sent: { url: string; ops: Op[] }[] = [];
  /** Objects this fake has "created": the ad's own parents, so a read can give them back. */
  const adParents = new Map<string, { campaign_id: string; adset_id: string; creative: { id: string } }>();
  const route = (r: Recorded) => {
    if (!r.form?.batch) return json({ id: 'single' });
    const ops = JSON.parse(r.form.batch as string) as Op[];
    sent.push({ url: r.url, ops });
    const all = ops.map((o) => `${o.relative_url} ${o.body ?? ''}`).join(' ');
    const referenced = new Set([...all.matchAll(/(?:\{|%7B)result(?:=|%3D)([A-Za-z0-9_-]+)/g)].map((m) => m[1]!));
    const ids = new Map<string, string>();
    const broken = new Set<string>();
    const results = ops.map((op) => {
      const params = new URLSearchParams(op.body);
      const deps = [refName(params.get('campaign_id')), refName(params.get('adset_id')), refName((JSON.parse(params.get('creative') ?? 'null') as { creative_id?: string } | null)?.creative_id ?? null)].filter(Boolean) as string[];
      if (deps.some((d) => broken.has(d))) return null; // Meta never runs an operation whose dependency failed
      if (op.relative_url.includes('search?type=adinterest')) return { code: 200, body: JSON.stringify({ data: [{ id: '6003290737525', name: 'Formal wear' }] }) };
      if (op.relative_url.endsWith('/adimages')) return { code: 200, body: JSON.stringify({ images: { [op.attached_files!]: { hash: `hash_${op.attached_files}_${++seq}` } } }) };
      if (op.relative_url.endsWith('/previews')) return { code: 200, body: JSON.stringify({ data: [{ body: '<iframe>preview</iframe>' }] }) };
      const read = op.method === 'GET' && /^\d+\?fields=/.test(op.relative_url) ? adParents.get(op.relative_url.split('?')[0]!) : null;
      if (read) return { code: 200, body: JSON.stringify({ id: op.relative_url.split('?')[0], ...read }) };
      if (opts.failNames?.includes(op.name ?? '') && (!opts.failOnce || !failed)) {
        failed = true;
        if (op.name) broken.add(op.name);
        return { code: 400, body: JSON.stringify(fixture('meta/error-4834011.json')) };
      }
      const id = `12020${++seq}`;
      if (op.name) ids.set(op.name, id);
      if (op.relative_url.endsWith('/ads')) {
        const setId = ids.get(refName(params.get('adset_id')) ?? '') ?? params.get('adset_id')!;
        adParents.set(id, { campaign_id: campaignOf(ops, ids, params), adset_id: setId, creative: { id: ids.get(refName((JSON.parse(params.get('creative') ?? '{}') as { creative_id?: string }).creative_id ?? null) ?? '') ?? '0' } });
      }
      // A named operation that another one depends on has its body omitted unless it opts in.
      if (op.name && referenced.has(op.name) && (opts.legacyOmit || op.omit_response_on_success !== false)) return null;
      return { code: 200, body: JSON.stringify({ id }) };
    });
    return json(results, 200, { 'x-fb-trace-id': `trace${sent.length}` });
  };
  return { route, sent };
}

/** The campaign an ad belongs to, through its ad set operation in the same batch. */
function campaignOf(ops: Op[], ids: Map<string, string>, adParams: URLSearchParams): string {
  const setName = refName(adParams.get('adset_id'));
  const setOp = ops.find((o) => o.name === setName);
  const campaignRef = new URLSearchParams(setOp?.body).get('campaign_id');
  return ids.get(refName(campaignRef) ?? '') ?? campaignRef ?? '0';
}

async function setup(templateFile: string, approved = 6, g = graph()) {
  const ff = fakeFetch({ 'graph.facebook.com': g.route, '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')), 'graphql.json': () => json(fixture('shopify/product.json')) });
  const ctx = testContext(ff.impl);
  await ctx.secrets.set('meta_access_token', 'EAAMetaSecretToken1234567890');
  await ctx.secrets.set('shopify_client_id', 'cid');
  await ctx.secrets.set('shopify_client_secret', 'shpss_secret1234567890');
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
  const post = (p: string, body: unknown = {}, method = 'POST') => app.request(p, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
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

  it('a stale draft snapshot warns instead of blocking, and re-reading from Shopify clears it', async () => {
    const t = await setup('templates/ashworth-cbo.json');
    const { eq } = await import('drizzle-orm');
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    t.ctx.db.update(products).set({ snapshot: { ...SNAPSHOT, status: 'DRAFT', fetchedAt: stale }, snapshotAt: stale }).where(eq(products.id, t.pid)).run();

    const p = (await (await t.app.request(`/api/products/${t.pid}/launch-preview?templateId=${t.templateId}`)).json()) as { canLaunch: boolean; snapshotFresh: boolean; requests: number; checks: { id: string; level: string }[] };
    expect(p.checks.find((c) => c.id === 'product_state')?.level).toBe('warn');
    expect(p.snapshotFresh).toBe(false);
    expect(p.requests).toBe(3); // the stale snapshot adds the read the launch will make
    expect(p.canLaunch).toBe(true);

    expect((await t.post(`/api/products/${t.pid}/refresh-shopify`)).status).toBe(202);
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list().find((j) => j.type === 'pull_product')!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const row = t.ctx.db.select().from(products).where(eq(products.id, t.pid)).get()!;
    expect((row.snapshot as { status: string }).status).toBe('ACTIVE');
    expect(row.state).toBe('ready_to_launch'); // a re-read never sends the product back to "from Shopify"

    const after = (await (await t.app.request(`/api/products/${t.pid}/launch-preview?templateId=${t.templateId}`)).json()) as { canLaunch: boolean; snapshotFresh: boolean; checks: { id: string }[] };
    expect(after.snapshotFresh).toBe(true);
    expect(after.checks.find((c) => c.id === 'product_state')).toBeUndefined();
    expect(after.canLaunch).toBe(true);
    await t.ctx.close();
  });

  it('the launch uses the creatives chosen for the product, in order, not the first approved ones', async () => {
    const t = await setup('templates/ashworth-cbo.json', 9); // 9 approved, 6 slots per ad set
    const before = (await (await t.app.request(`/api/products/${t.pid}/launch-preview?templateId=${t.templateId}`)).json()) as { structure: { adSets: { ads: { creativeId: number }[] }[] } };
    expect(before.structure.adSets[0]!.ads.map((a) => a.creativeId)).toEqual([1, 2, 3, 4, 5, 6]); // the old behaviour: the first six

    const chosen = [9, 8, 7, 6, 5, 4];
    expect((await t.post(`/api/products/${t.pid}/launch-plan`, { templateId: t.templateId, creativeIds: chosen }, 'PUT')).status).toBe(200);
    const plan = (await (await t.app.request(`/api/products/${t.pid}/launch-plan?templateId=${t.templateId}`)).json()) as { creativeIds: number[]; slots: number; fillRule: string; edited: boolean; creatives: { id: number }[] };
    expect(plan.creativeIds).toEqual(chosen);
    expect(plan.slots).toBe(6); // one_per_ad reuses the same six in all three ad sets
    expect(plan.fillRule).toBe('one_per_ad');
    expect(plan.edited).toBe(false); // choosing images is not editing the template
    expect(plan.creatives.slice(0, 6).map((c) => c.id)).toEqual(chosen); // chosen ones first

    const after = (await (await t.app.request(`/api/products/${t.pid}/launch-preview?templateId=${t.templateId}`)).json()) as typeof before;
    expect(after.structure.adSets.every((s) => s.ads.map((a) => a.creativeId).join() === chosen.join())).toBe(true);

    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list().find((j) => j.type === 'launch')!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const { creatives: creativeTable, ads: adsTable } = await import('../src/db/schema.ts');
    const { inArray } = await import('drizzle-orm');
    const used = [...new Set(t.ctx.db.select().from(adsTable).all().map((a) => a.creativeId!))].sort((a, b) => a - b);
    expect(used).toEqual([4, 5, 6, 7, 8, 9]);
    expect(t.ctx.db.select().from(creativeTable).where(inArray(creativeTable.id, [1, 2, 3])).all().every((c) => !c.metaImageHash)).toBe(true); // the unchosen ones were never uploaded
    await t.ctx.close();
  });

  it('a template edited for one product is launched for that product only; the template file keeps its own settings', async () => {
    const t = await setup('templates/ashworth-cbo.json');
    const original = (await (await t.app.request(`/api/templates/${t.templateId}`)).json()) as { json: { campaign: { budget: { daily_budget_minor: number } }; adset_count: number } };
    expect(original.json.campaign.budget.daily_budget_minor).toBe(10000);

    const edited = { ...original.json, adset_count: 2, campaign: { ...original.json.campaign, budget: { ...original.json.campaign.budget, daily_budget_minor: 2500 } } };
    expect((await t.post(`/api/products/${t.pid}/launch-plan`, { templateId: t.templateId, template: edited }, 'PUT')).status).toBe(200);

    const preview = (await (await t.app.request(`/api/products/${t.pid}/launch-preview?templateId=${t.templateId}`)).json()) as { structure: { adSets: unknown[] }; operations: number };
    expect(preview.structure.adSets).toHaveLength(2);
    const stillOriginal = (await (await t.app.request(`/api/templates/${t.templateId}`)).json()) as typeof original;
    expect(stillOriginal.json.campaign.budget.daily_budget_minor).toBe(10000);
    expect(stillOriginal.json.adset_count).toBe(3);

    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list().find((j) => j.type === 'launch')!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const campaign = t.g.sent.flatMap((b) => b.ops).find((o) => o.relative_url.endsWith('/campaigns'))!;
    expect(new URLSearchParams(campaign.body).get('daily_budget')).toBe('2500');
    expect(t.g.sent.flatMap((b) => b.ops).filter((o) => o.relative_url.endsWith('/adsets'))).toHaveLength(2);

    // "Start again from the template" drops the copy and nothing else.
    expect((await t.app.request(`/api/products/${t.pid}/launch-plan`, { method: 'DELETE' })).status).toBe(200);
    const reverted = (await (await t.app.request(`/api/products/${t.pid}/launch-plan?templateId=${t.templateId}`)).json()) as { edited: boolean; template: { adset_count: number } };
    expect(reverted.edited).toBe(false);
    expect(reverted.template.adset_count).toBe(3);
    await t.ctx.close();
  });

  it('the launch settings change this launch only, and are laid over the template when it is sent', async () => {
    const t = await setup('templates/ashworth-cbo.json');
    const start = new Date(Date.now() + 86_400_000).toISOString();
    const overrides = { campaignName: 'Loafers – leather angle', startTime: start, genders: [2], ageMin: 25, ageMax: 45, countries: ['US', 'CA'], advantageAudience: false, budgetMinor: 4500 };
    expect((await t.post(`/api/products/${t.pid}/launch-plan`, { templateId: t.templateId, overrides }, 'PUT')).status).toBe(200);

    const plan = (await (await t.app.request(`/api/products/${t.pid}/launch-plan?templateId=${t.templateId}`)).json()) as { edited: boolean; overrides: { campaignName: string }; defaults: { campaignName: string; budgetMinor: number; genders: number[] } };
    expect(plan.edited).toBe(false); // the launch settings are not an edit of the template
    expect(plan.overrides.campaignName).toBe('Loafers – leather angle');
    expect(plan.defaults.budgetMinor).toBe(10000); // what the template says, for the box's placeholder
    expect(plan.defaults.campaignName).toMatch(/^\d{4}-\d{2}-\d{2}_/);

    const preview = (await (await t.app.request(`/api/products/${t.pid}/launch-preview?templateId=${t.templateId}`)).json()) as { structure: { campaignName: string; adSets: { name: string }[] } };
    expect(preview.structure.campaignName).toBe('Loafers – leather angle');
    expect(preview.structure.adSets[0]!.name.startsWith('Loafers – leather angle')).toBe(true);

    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list().find((j) => j.type === 'launch')!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const ops = t.g.sent.flatMap((b) => b.ops);
    const campaign = new URLSearchParams(ops.find((o) => o.relative_url.endsWith('/campaigns'))!.body);
    expect(campaign.get('name')).toBe('Loafers – leather angle');
    expect(campaign.get('daily_budget')).toBe('4500'); // CBO: the campaign carries it
    const set = new URLSearchParams(ops.find((o) => o.relative_url.endsWith('/adsets'))!.body);
    expect(set.get('start_time')).toBe(String(Math.floor(new Date(start).getTime() / 1000)));
    expect(set.get('daily_budget')).toBeNull(); // still CBO: no ad set budget
    const tg = JSON.parse(set.get('targeting')!) as { genders: number[]; age_min: number; age_max: number; geo_locations: { countries: string[] }; targeting_automation: { advantage_audience: number } };
    expect(tg).toMatchObject({ genders: [2], age_min: 25, age_max: 45, geo_locations: { countries: ['US', 'CA'] }, targeting_automation: { advantage_audience: 0 } });

    // The template file and the folder are untouched by any of it.
    const file = (await (await t.app.request(`/api/templates/${t.templateId}`)).json()) as { json: { campaign: { budget: { daily_budget_minor: number }; name_pattern: string }; adset: { targeting: { genders: number[] } } } };
    expect(file.json.campaign.budget.daily_budget_minor).toBe(10000);
    expect(file.json.campaign.name_pattern).toContain('{{');
    expect(file.json.adset.targeting.genders).toEqual([]);
    await t.ctx.close();
  });

  it('under ABO the launch budget is every ad set\'s, and an empty start time means "when activated"', async () => {
    const t = await setup('templates/whitcombe-abo.json', 5);
    expect((await t.post(`/api/products/${t.pid}/launch-plan`, { templateId: t.templateId, overrides: { budgetMinor: 3000, startTime: '' } }, 'PUT')).status).toBe(200);
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId, acknowledge: ['interest_placeholder', 'interest_unmatched'] });
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list().find((j) => j.type === 'launch')!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const ops = t.g.sent.flatMap((b) => b.ops);
    const sets = ops.filter((o) => o.relative_url.endsWith('/adsets')).map((o) => new URLSearchParams(o.body));
    expect(sets).toHaveLength(5);
    expect(sets.every((b) => b.get('daily_budget') === '3000')).toBe(true);
    expect(sets.every((b) => b.get('start_time') === null)).toBe(true);
    expect(new URLSearchParams(ops.find((o) => o.relative_url.endsWith('/campaigns'))!.body).get('daily_budget')).toBeNull();
    await t.ctx.close();
  });

  it('"start again from the template" keeps this launch\'s settings and chosen images', async () => {
    const t = await setup('templates/ashworth-cbo.json');
    const original = (await (await t.app.request(`/api/templates/${t.templateId}`)).json()) as { json: Record<string, unknown> };
    await t.post(`/api/products/${t.pid}/launch-plan`, { templateId: t.templateId, template: { ...original.json, adset_count: 2 }, creativeIds: [2, 3], overrides: { campaignName: 'Keep me' } }, 'PUT');
    expect((await t.app.request(`/api/products/${t.pid}/launch-plan`, { method: 'DELETE' })).status).toBe(200);

    const plan = (await (await t.app.request(`/api/products/${t.pid}/launch-plan?templateId=${t.templateId}`)).json()) as { edited: boolean; overrides: { campaignName: string }; creativeIds: number[]; template: { adset_count: number } };
    expect(plan.edited).toBe(false);
    expect(plan.template.adset_count).toBe(3); // back to the template file
    expect(plan.overrides.campaignName).toBe('Keep me');
    expect(plan.creativeIds).toEqual([2, 3]);
    await t.ctx.close();
  });

  it('preflight blocks unapproved or unclean creatives and empty ad sets', () => {
    const t = Template.parse(fixture('templates/ashworth-cbo.json'));
    const structure = { campaignName: 'c', adSets: [{ index: 0, name: 'a', budgetMinor: null, interestKind: 'broad' as const, interestLabel: null, interests: [], suggestions: [], countryOverride: null, ageBand: null, ads: [{ creativeId: 1, fileName: 'f', primaryText: 'p', headline: 'h', description: '', destinationUrl: 'u' }] }, { index: 1, name: 'b', budgetMinor: null, interestKind: 'broad' as const, interestLabel: null, interests: [], suggestions: [], countryOverride: null, ageBand: null, ads: [] }] };
    const checks = preflight({ template: t, structure, snapshot: SNAPSHOT, snapshotFresh: true, creatives: [{ id: 1, metadataCheck: 'metadata left: XMP', approval: 'pending', status: 'finished' }], pageId: '1', pixelId: '2', adAccountId: 'act_1', tokenSet: true });
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
    expect(camp[0]!.completed).toBe(21); // everything but set1 and the 6 ads under it, which Meta never ran
    expect(camp[0]!.lastError).toMatch(/set1/);

    const created = (name: string) => g.sent.flatMap((b) => b.ops).filter((o) => o.name === name).length;
    const res = await t.post(`/api/campaigns/${camp[0]!.id}/resume`);
    expect(res.status).toBe(202);
    await t.ctx.worker.drain();
    const second = t.ctx.worker.list().find((j) => j.type === 'launch' && j.id !== job.id)!;
    expect(second.status, JSON.stringify(second.error)).toBe('done');
    // The second run sent only set1 and the ads that never ran, with the saved campaign ID substituted.
    const lastBatch = g.sent.at(-1)!.ops;
    expect(lastBatch.map((o) => o.name)).toEqual(['set1', 'ad1_0', 'ad1_1', 'ad1_2', 'ad1_3', 'ad1_4', 'ad1_5']);
    expect(new URLSearchParams(lastBatch[0]!.body).get('campaign_id')).toMatch(/^12020/);
    expect(created('campaign')).toBe(1);
    expect(created('ad0_0')).toBe(1);
    expect(created('set1')).toBe(2);
    expect(t.metaRequests().filter((r) => r.purpose === 'launch_recover')).toHaveLength(0); // no parent ID was lost
    camp = (await (await t.app.request(`/api/products/${t.pid}/campaigns`)).json()) as typeof camp;
    expect(camp).toHaveLength(1);
    expect(camp[0]).toMatchObject({ status: 'paused', completed: 28 });
    // Images were not uploaded again on the resume.
    expect(t.metaRequests().filter((r) => r.purpose === 'adimages')).toHaveLength(1);
    await t.ctx.close();
  });

  it('every named operation asks Meta not to omit its response, so no parent ID is lost', async () => {
    const t = await setup('templates/ashworth-cbo.json');
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    await t.ctx.worker.drain();
    const named = t.g.sent.flatMap((b) => b.ops).filter((o) => o.name);
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((o) => o.omit_response_on_success === false)).toBe(true);
    const camp = (await (await t.app.request(`/api/products/${t.pid}/campaigns`)).json()) as { completed: number; metaCampaignId: string | null }[];
    expect(camp[0]!.completed).toBe(28);
    expect(camp[0]!.metaCampaignId).toMatch(/^12020/);
    await t.ctx.close();
  });

  it('when Meta omitted the parents (17 September 2026), the resume reads their IDs off the ads instead of creating a second campaign', async () => {
    const g = graph({ legacyOmit: true }); // Meta ignores the flag: campaign, ad sets and creatives come back null
    const t = await setup('templates/ashworth-cbo.json', 6, g);
    await t.post(`/api/products/${t.pid}/launch`, { templateId: t.templateId });
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list().find((j) => j.type === 'launch')!;
    expect(job.status).toBe('failed');
    expect(job.error?.message).toMatch(/campaign \(code 0/);
    let camp = (await (await t.app.request(`/api/products/${t.pid}/campaigns`)).json()) as { id: number; status: string; completed: number; metaCampaignId: string | null }[];
    expect(camp[0]!.completed).toBe(18); // only the 18 ads, exactly what the user saw

    const res = await t.post(`/api/campaigns/${camp[0]!.id}/resume`);
    expect(res.status).toBe(202);
    await t.ctx.worker.drain();
    const second = t.ctx.worker.list().find((j) => j.type === 'launch' && j.id !== job.id)!;
    expect(second.status, JSON.stringify(second.error)).toBe('done');
    // One batch of reads, and not a single object created twice.
    const reads = t.g.sent.at(-1)!.ops;
    expect(reads.every((o) => o.method === 'GET' && /\?fields=campaign_id,adset_id,creative/.test(o.relative_url))).toBe(true);
    expect(t.metaRequests().filter((r) => r.purpose === 'launch_recover')).toHaveLength(1);
    const created = (name: string) => t.g.sent.flatMap((b) => b.ops).filter((o) => o.name === name).length;
    for (const name of ['campaign', 'set0', 'set1', 'set2', 'cr1', 'cr6', 'ad0_0']) expect(created(name), name).toBe(1);
    camp = (await (await t.app.request(`/api/products/${t.pid}/campaigns`)).json()) as typeof camp;
    expect(camp).toHaveLength(1);
    expect(camp[0]).toMatchObject({ status: 'paused', completed: 28 });
    expect(camp[0]!.metaCampaignId).toMatch(/^12020/);
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
