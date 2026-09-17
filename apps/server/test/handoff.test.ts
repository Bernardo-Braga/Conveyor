import { describe, expect, it } from 'vitest';
import { Template, type LaunchAdSet } from '@conveyor/shared';
import { createApp } from '../src/app.ts';
import { creativeBatches, creatives, products, requests } from '../src/db/schema.ts';
import { MetaClient } from '../src/meta/client.ts';
import { describeMetaError, explainMetaError } from '../src/meta/errors.ts';
import { adSetFields, assertPayloadRules, campaignFields, creativeFields, enhancementSpec, fillUrlParams, targetingFields, type PayloadNote } from '../src/meta/payloadRules.ts';
import { preflight } from '../src/meta/preflight.ts';
import { storeTemplate } from '../src/meta/templates.ts';
import { fakeFetch, fixture, json, testContext } from './helpers.ts';

const ashworth = () => Template.parse(fixture('templates/ashworth-cbo.json'));
const NOW = new Date('2026-09-16T12:00:00Z');
const set = (index: number, name: string, extra: Partial<LaunchAdSet> = {}): LaunchAdSet => ({ index, name, budgetMinor: null, interestKind: 'broad', interestLabel: null, interests: [], suggestions: [], countryOverride: null, ageBand: null, ads: [], ...extra });
const ad = { creativeId: 1, fileName: 'f.jpg', primaryText: 'p', headline: 'h', description: '', destinationUrl: 'https://example-store.com/products/x' };

describe('lessons from the other tool', () => {
  it('bug 5: creative enhancements are set feature by feature, never the deprecated bundle', () => {
    const off = creativeFields(ad, '1', null, 'hash', '', 'SHOP_NOW', false);
    const spec = (off.degrees_of_freedom_spec as { creative_features_spec: Record<string, { enroll_status: string }> }).creative_features_spec;
    expect(spec).not.toHaveProperty('standard_enhancements');
    expect(spec.image_touchups!.enroll_status).toBe('OPT_OUT');
    expect(spec.image_background_gen!.enroll_status).toBe('OPT_OUT');
    const on = enhancementSpec(true);
    expect(on.image_touchups!.enroll_status).toBe('OPT_IN');
    expect(on.image_uncrop!.enroll_status).toBe('OPT_OUT'); // generative features stay off
    expect(() => assertPayloadRules([{ method: 'POST', relative_url: 'act_1/adcreatives', name: 'c', body: { degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_OUT' } } } } }], 'CBO')).toThrow(/3858504/);
  });

  it('bugs 2 and 7: an ad set with an interest runs with Advantage+ audience off; a broad one keeps it on', () => {
    const notes: PayloadNote[] = [];
    const base = ashworth().adset.targeting; // advantage_audience: true in the file
    const withInterest = targetingFields({ base, countryOverride: null, ageBand: null, interests: [{ id: '6003290737525', name: 'Formal wear' }] }, notes, 2);
    expect(withInterest.targeting_automation).toEqual({ advantage_audience: 0 });
    expect(withInterest.flexible_spec).toEqual([{ interests: [{ id: '6003290737525', name: 'Formal wear' }] }]);
    expect(withInterest).toMatchObject({ age_min: 18, age_max: 65 });
    expect(notes.some((n) => /cannot be combined/.test(n.message))).toBe(true);
    const broad = targetingFields({ base, countryOverride: null, ageBand: null, interests: [] }, [], 0);
    expect(broad.targeting_automation).toEqual({ advantage_audience: 1 });
    expect(broad).not.toHaveProperty('flexible_spec');
    expect(broad).not.toHaveProperty('exclusions');
    expect(broad.geo_locations).toEqual({ countries: ['US'] });
    expect(broad).not.toHaveProperty('genders');
  });

  it('bug 6: url parameters are token-filled and encoded; the destination URL is not touched', () => {
    expect(fillUrlParams('utm_source=meta&utm_campaign={{campaign}}', { campaign: 'Amalfi 7/14 | 1.4' })).toBe('utm_source=meta&utm_campaign=Amalfi%207%2F14%20%7C%201.4');
    const c = creativeFields(ad, '1', null, 'h', fillUrlParams('utm_campaign={{campaign}}', { campaign: '2026-09-17_Ashworth (CBO) 1.6' }), 'SHOP_NOW', false);
    expect(c.url_tags).toBe('utm_campaign=2026-09-17_Ashworth%20(CBO)%201.6');
    expect((c.object_story_spec as { link_data: { link: string } }).link_data.link).toBe(ad.destinationUrl);
  });

  it('bug 3: errors render message and error_user_msg, and the known codes are explained', () => {
    const text = describeMetaError({ message: 'Invalid parameter', code: 100, error_subcode: 1885183, error_user_title: 'App in development mode', error_user_msg: 'Ads creative post was created by an app that is in development mode.', fbtrace_id: 'AbC' }, 400, null);
    expect(text).toContain('Invalid parameter — App in development mode — Ads creative post was created by an app that is in development mode.');
    expect(text).toContain('code 100 / subcode 1885183');
    expect(explainMetaError(100, 1885183)).toMatch(/Development mode/);
    expect(explainMetaError(100, 3858504)).toMatch(/standard_enhancements/);
    expect(explainMetaError(1, undefined)).toMatch(/targeting/);
    expect(explainMetaError(613, undefined)).toMatch(/rate limit/);
  });

  it('a lifetime budget without an end time is refused at both levels', () => {
    const t = ashworth();
    t.campaign.budget.daily_budget_minor = null;
    t.campaign.budget.lifetime_budget_minor = 50000;
    expect(() => campaignFields(t, 'x')).toThrow(/end time/);
    t.adset.schedule.end_time = '2030-01-01T00:00:00.000Z';
    const c = campaignFields(t, 'x');
    expect(c).toMatchObject({ lifetime_budget: 50000, stop_time: Math.floor(new Date('2030-01-01T00:00:00.000Z').getTime() / 1000) });
    const w = Template.parse(fixture('templates/whitcombe-abo.json'));
    w.adset.budget.daily_budget_minor = null;
    w.adset.budget.lifetime_budget_minor = 9000;
    expect(() => adSetFields({ template: w, set: set(0, 'US - Broad'), campaignRef: 'c', pixelId: null, now: NOW, keepTimeOfDay: false, notes: [] })).toThrow(/end time/);
  });

  it('preflight: conversion goals without a pixel block; odd billing events warn; special categories are noted', () => {
    const t = ashworth();
    t.adset.promoted_object.pixel_id = null;
    const structure = { campaignName: 'c', adSets: [set(0, 'a', { ads: [ad] })] };
    const snapshot = { id: 'gid://shopify/Product/1', handle: 'x', title: 'x', status: 'ACTIVE', descriptionHtml: '', productType: '', tags: [], vendor: '', onlineStoreUrl: 'https://x/products/x', featuredImage: null, images: [], options: [], variants: [], currency: 'USD', updatedAt: 'u', fetchedAt: 'f' };
    const checks = preflight({ template: t, structure, snapshot, creatives: [{ id: 1, metadataCheck: 'clean', approval: 'approved', status: 'finished' }], pageId: '1', pixelId: '', adAccountId: 'act_1', tokenSet: true });
    expect(checks.find((c) => c.id === 'pixel_missing')?.level).toBe('block');
    t.adset.billing_event = 'LINK_CLICKS';
    t.campaign.special_ad_categories = ['HOUSING'];
    const c2 = preflight({ template: t, structure, snapshot, creatives: [{ id: 1, metadataCheck: 'clean', approval: 'approved', status: 'finished' }], pageId: '1', pixelId: '138', adAccountId: 'act_1', tokenSet: true });
    expect(c2.find((c) => c.id === 'pixel_missing')).toBeUndefined();
    expect(c2.find((c) => c.id === 'billing_event')?.level).toBe('warn');
    expect(c2.find((c) => c.id === 'special_ad_categories')?.level).toBe('info');
  });

  it('appsecret_proof travels as a parameter when an app secret is saved, never otherwise, and never in the ledger', async () => {
    const ff = fakeFetch({ 'graph.facebook.com': () => json({ id: 'me' }) });
    const ctx = testContext(ff.impl);
    await ctx.secrets.set('meta_access_token', 'EAAtoken0000000000000000000');
    const client = new MetaClient({ ledger: ctx.ledger, secrets: ctx.secrets });
    await client.get('me', {}, { purpose: 't' });
    expect(ff.calls[0]!.url).not.toContain('appsecret_proof');
    await ctx.secrets.set('meta_app_secret', 'shhh');
    await client.get('me', {}, { purpose: 't' });
    expect(ff.calls[1]!.url).toMatch(/appsecret_proof=[a-f0-9]{64}/);
    await client.post('act_1/campaigns', { name: 'x' }, { purpose: 't' });
    expect(ff.calls[2]!.body).toMatch(/appsecret_proof=[a-f0-9]{64}/);
    const ledger = JSON.stringify(ctx.db.select().from(requests).all());
    expect(ledger).not.toContain('appsecret_proof');
    expect(ledger).not.toContain('shhh');
    await ctx.close();
  });

  it('"Check targeting with Meta" is one batch of delivery estimates per unique targeting, nothing created', async () => {
    const seen: string[] = [];
    const ff = fakeFetch({
      'graph.facebook.com': (r) => {
        const ops = JSON.parse(r.form!.batch as string) as { relative_url: string }[];
        seen.push(...ops.map((o) => o.relative_url));
        return json(ops.map((o, i) => (i === 1 ? { code: 400, body: JSON.stringify({ error: { message: 'Invalid parameter', code: 100, error_subcode: 1487079, error_user_msg: 'Interest id 999 is not valid' } }) } : { code: 200, body: JSON.stringify({ data: [{ estimate_mau_lower_bound: 1200000, estimate_mau_upper_bound: 1500000 }] }) })));
      },
    });
    const ctx = testContext(ff.impl);
    await ctx.secrets.set('meta_access_token', 'EAAtoken0000000000000000000');
    ctx.settings.set('connections', { meta: { adAccountId: 'act_1', pageId: '1', pixelId: '138' } });
    const pid = ctx.db.insert(products).values({ origin: 'shopify', state: 'ready_to_launch', shopifyProductId: 'gid://shopify/Product/1', shopifyHandle: 'x' }).returning({ id: products.id }).get().id;
    const b = ctx.db.insert(creativeBatches).values({ productId: pid, prompt: 'p', engine: 'codex', status: 'done', formats: ['4:5'], countPerFormat: 1 }).returning({ id: creativeBatches.id }).get().id;
    ctx.db.insert(creatives).values({ batchId: b, productId: pid, aspect: '4:5', slot: 1, status: 'finished', approval: 'approved', fileName: 'x_4x5_01.jpg', finishedPath: '/tmp/x.jpg', metadataCheck: 'clean' }).run();
    const t = storeTemplate(ctx.db, ashworth(), 'file');
    const app = createApp(ctx);
    const res = (await (await app.request(`/api/products/${pid}/launch-validate`, { method: 'POST', body: JSON.stringify({ templateId: t.id }), headers: { 'content-type': 'application/json' } })).json()) as { requests: number; checks: { adSet: string; ok: boolean; message: string | null; estimate: { users_lower: number } | null }[] };
    expect(res.requests).toBe(1);
    // Ashworth: two broad ad sets share one targeting, the Formal wear one differs → 2 unique specs, 3 checks.
    expect(seen).toHaveLength(2);
    expect(seen.every((u) => u.startsWith('act_1/delivery_estimate?optimization_goal=OFFSITE_CONVERSIONS&targeting_spec='))).toBe(true);
    expect(res.checks).toHaveLength(3);
    expect(res.checks.filter((c) => c.ok)).toHaveLength(2);
    expect(res.checks.find((c) => !c.ok)!.message).toContain('Interest id 999 is not valid');
    expect(res.checks[0]!.estimate).toEqual({ users_lower: 1200000, users_upper: 1500000 });
    expect(ff.calls.every((c) => !/campaigns|adsets|ads$/.test(c.url))).toBe(true);
    await ctx.close();
  });
});
