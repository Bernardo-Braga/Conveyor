import { describe, expect, it } from 'vitest';
import { Template, type LaunchAdSet } from '@conveyor/shared';
import type { BatchOp } from '../src/meta/batch.ts';
import { adFields, adSetFields, assertPayloadRules, campaignFields, creativeFields, placementFields, startTimeFields, targetingFields, type PayloadNote } from '../src/meta/payloadRules.ts';
import { fixture } from './helpers.ts';

const ashworth = () => Template.parse(fixture('templates/ashworth-cbo.json'));
const whitcombe = () => Template.parse(fixture('templates/whitcombe-abo.json'));
const NOW = new Date('2026-09-16T12:00:00Z');

function set(index: number, name: string, extra: Partial<LaunchAdSet> = {}): LaunchAdSet {
  return { index, name, budgetMinor: null, interestKind: 'broad', interestLabel: null, interests: [], suggestions: [], countryOverride: null, ageBand: null, ads: [], ...extra };
}

/** Builds the campaign + ad sets the way the launcher does, so the same rules are exercised. */
function opsFor(t: ReturnType<typeof ashworth>, sets: LaunchAdSet[], notes: PayloadNote[] = []): BatchOp[] {
  const ops: BatchOp[] = [{ method: 'POST', relative_url: 'act_1/campaigns', name: 'campaign', body: campaignFields(t, 'Test campaign') }];
  sets.forEach((s) => ops.push({ method: 'POST', relative_url: 'act_1/adsets', name: `set${s.index}`, body: adSetFields({ template: t, set: s, campaignRef: '{result=campaign:$.id}', pixelId: '1000000000000001', now: NOW, keepTimeOfDay: false, notes }) }));
  return ops;
}

describe('both templates parse as exported', () => {
  it('Ashworth is CBO with 3 × 6, Whitcombe is ABO with 5 × 5 and a trimmed name', () => {
    const a = ashworth();
    expect(a.campaign.budget.mode).toBe('CBO');
    expect([a.adset_count, a.ads_per_adset]).toEqual([3, 6]);
    const w = whitcombe();
    expect(w.campaign.budget.mode).toBe('ABO');
    expect([w.adset_count, w.ads_per_adset]).toEqual([5, 5]);
    expect(w.name).toBe('Whitcombe (CBO) 1.6');
    // passthrough: every original key survives
    const raw = fixture('templates/whitcombe-abo.json') as Record<string, unknown>;
    expect(Object.keys(w).sort()).toEqual(Object.keys(raw).sort());
  });
});

describe('Ashworth (CBO)', () => {
  it('campaign carries daily_budget 10000 and the bid strategy, no sharing field; ad sets carry no budget', () => {
    const t = ashworth();
    const sets = t.adset_variants.map((v, i) => set(i, v.name));
    const ops = opsFor(t, sets);
    const campaign = ops[0]!.body!;
    expect(campaign).toMatchObject({ daily_budget: 10000, bid_strategy: 'LOWEST_COST_WITHOUT_CAP', status: 'PAUSED', objective: 'OUTCOME_SALES', special_ad_categories: [] });
    expect(campaign).not.toHaveProperty('is_adset_budget_sharing_enabled');
    for (const op of ops.slice(1)) {
      expect(op.body).not.toHaveProperty('daily_budget');
      expect(op.body).not.toHaveProperty('lifetime_budget');
      expect(op.body).not.toHaveProperty('bid_strategy');
      expect(op.body!.status).toBe('PAUSED');
    }
    expect(() => assertPayloadRules(ops, 'CBO')).not.toThrow();
  });

  it('past start_time becomes start when launched; Advantage+ audience is explicit with no age_max; placements send no positions', () => {
    const t = ashworth();
    const notes: PayloadNote[] = [];
    const ops = opsFor(t, [set(0, 'US - broad 1')], notes);
    const body = ops[1]!.body!;
    expect(body).not.toHaveProperty('start_time');
    expect(notes.some((n) => /in the past/.test(n.message))).toBe(true);
    const tg = body.targeting as Record<string, unknown>;
    expect(tg.targeting_automation).toEqual({ advantage_audience: 1 });
    expect(tg.age_min).toBe(18);
    expect(tg).not.toHaveProperty('age_max');
    expect(tg).not.toHaveProperty('age_range');
    expect(tg).not.toHaveProperty('facebook_positions');
    expect(tg).not.toHaveProperty('publisher_platforms');
    expect(tg).not.toHaveProperty('flexible_spec'); // the empty group was removed
    expect(tg).not.toHaveProperty('exclusions'); // { interests: [], behaviors: [] } in the file is noise
    expect(tg).not.toHaveProperty('excluded_geo_locations');
    expect(tg.geo_locations).toEqual({ countries: ['US'] }); // empty regions/cities/zips lists dropped
    expect(tg).not.toHaveProperty('advantage_audience');
    expect(tg).not.toHaveProperty('placements');
    expect(body.promoted_object).toEqual({ pixel_id: '1000000000000001', custom_event_type: 'PURCHASE' });
    expect(body.attribution_spec).toHaveLength(2);
  });

  it('an interest from the file goes into flexible_spec unchanged', () => {
    const t = ashworth();
    const v = t.adset_variants[2]!;
    const ops = opsFor(t, [set(2, v.name, { interestKind: 'file', interests: v.interests })]);
    const tg = ops[1]!.body!.targeting as { flexible_spec: unknown[]; targeting_automation: { advantage_audience: number } };
    expect(tg.flexible_spec).toEqual([{ interests: [{ id: '6003290737525', name: 'Formal wear' }] }]);
    expect(tg.targeting_automation.advantage_audience).toBe(0); // an include audience and Advantage+ audience cannot be combined
  });
});

describe('Whitcombe (ABO)', () => {
  it('campaign has is_adset_budget_sharing_enabled: false and no budget; 5 ad sets at daily_budget 2000 with a bid strategy', () => {
    const t = whitcombe();
    const sets = t.adset_variants.map((v, i) => set(i, v.name));
    const ops = opsFor(t, sets);
    const campaign = ops[0]!.body!;
    expect(campaign.is_adset_budget_sharing_enabled).toBe(false);
    expect(campaign).not.toHaveProperty('daily_budget');
    expect(campaign).not.toHaveProperty('lifetime_budget');
    expect(campaign).not.toHaveProperty('bid_strategy');
    expect(ops.slice(1)).toHaveLength(5);
    for (const op of ops.slice(1)) expect(op.body).toMatchObject({ daily_budget: 2000, bid_strategy: 'LOWEST_COST_WITHOUT_CAP', status: 'PAUSED' });
    expect(() => assertPayloadRules(ops, 'ABO')).not.toThrow();
  });

  it('future start_time is kept as a unix timestamp; gender with Advantage+ audience is flagged as a suggestion', () => {
    const t = whitcombe();
    const notes: PayloadNote[] = [];
    const ops = opsFor(t, [set(0, 'US - Broad')], notes);
    expect(ops[1]!.body!.start_time).toBe(Math.floor(new Date('2026-09-17T10:00:00.000Z').getTime() / 1000));
    const tg = ops[1]!.body!.targeting as Record<string, unknown>;
    expect(tg.genders).toEqual([1]);
    expect(notes.some((n) => /only a suggestion/.test(n.message))).toBe(true);
  });

  it('a per-variant ABO budget override replaces the daily budget', () => {
    const t = whitcombe();
    const ops = opsFor(t, [set(0, 'US - Broad', { budgetMinor: 3500 })]);
    expect(ops[1]!.body!.daily_budget).toBe(3500);
  });
});

describe('failure cases (must fail)', () => {
  it('ABO with a missing sharing field fails', () => {
    const t = whitcombe();
    const ops = opsFor(t, [set(0, 'US - Broad')]);
    delete ops[0]!.body!.is_adset_budget_sharing_enabled;
    expect(() => assertPayloadRules(ops, 'ABO')).toThrow(/is_adset_budget_sharing_enabled: false/);
  });
  it('ABO with sharing true fails, and so does CBO with it', () => {
    const w = opsFor(whitcombe(), [set(0, 'US - Broad')]);
    w[0]!.body!.is_adset_budget_sharing_enabled = true;
    expect(() => assertPayloadRules(w, 'ABO')).toThrow(/never be true/);
    const a = opsFor(ashworth(), [set(0, 'US - broad')]);
    a[0]!.body!.is_adset_budget_sharing_enabled = true;
    expect(() => assertPayloadRules(a, 'CBO')).toThrow(/never be true/);
  });
  it('a CBO ad set with a budget, an ABO campaign with a budget, an ACTIVE object, an implicit advantage_audience and a removed placement all fail', () => {
    const a = opsFor(ashworth(), [set(0, 'US - broad')]);
    a[1]!.body!.daily_budget = 2000;
    expect(() => assertPayloadRules(a, 'CBO')).toThrow(/must not carry a budget/);

    const w = opsFor(whitcombe(), [set(0, 'US - Broad')]);
    w[0]!.body!.daily_budget = 10000;
    expect(() => assertPayloadRules(w, 'ABO')).toThrow(/must not carry a budget/);

    const s = opsFor(ashworth(), [set(0, 'US - broad')]);
    s[1]!.body!.status = 'ACTIVE';
    expect(() => assertPayloadRules(s, 'CBO')).toThrow(/not PAUSED/);

    const t = opsFor(ashworth(), [set(0, 'US - broad')]);
    delete (t[1]!.body!.targeting as Record<string, unknown>).targeting_automation;
    expect(() => assertPayloadRules(t, 'CBO')).toThrow(/advantage_audience must be explicit/);

    const p = opsFor(ashworth(), [set(0, 'US - broad')]);
    (p[1]!.body!.targeting as Record<string, unknown>).instagram_positions = ['explore'];
    expect(() => assertPayloadRules(p, 'CBO')).toThrow(/removed placement/);

    const m = opsFor(ashworth(), [set(0, 'US - broad')]);
    (m[1]!.body!.targeting as Record<string, unknown>).age_max = 65;
    expect(() => assertPayloadRules(m, 'CBO')).toThrow(/age_max must not be sent/);
  });
});

describe('targeting details', () => {
  it('manual placements drop video_feeds and explore with a note, and map reels to facebook_reels', () => {
    const notes: PayloadNote[] = [];
    const out = placementFields(ashworth().adset.targeting.placements.mode === 'advantage' ? { ...ashworth().adset.targeting.placements, mode: 'manual' } : ashworth().adset.targeting.placements, notes, 0);
    expect(out.facebook_positions).toEqual(['feed', 'facebook_reels', 'story', 'search', 'right_hand_column', 'marketplace']);
    expect(out.instagram_positions).toEqual(['stream', 'reels', 'explore_home', 'profile_feed', 'story']);
    expect(out.publisher_platforms).toEqual(['facebook', 'instagram']);
    expect(notes.map((n) => n.message).join(' ')).toMatch(/video_feeds/);
    expect(notes.map((n) => n.message).join(' ')).toMatch(/explore\b/);
  });

  it('a variant age band with Advantage+ audience becomes age_min (clamped) plus an age_range suggestion; without it, age_min and age_max', () => {
    const notes: PayloadNote[] = [];
    const base = ashworth().adset.targeting;
    const adv = targetingFields({ base, countryOverride: 'GB', ageBand: [30, 44], interests: [] }, notes, 0);
    expect(adv.age_min).toBe(25);
    expect(adv.age_range).toEqual([30, 44]);
    expect(adv).not.toHaveProperty('age_max');
    expect((adv.geo_locations as { countries: string[] }).countries).toEqual(['GB']);
    const off = targetingFields({ base: { ...base, advantage_audience: false }, countryOverride: null, ageBand: [30, 44], interests: [] }, notes, 0);
    expect(off).toMatchObject({ age_min: 30, age_max: 44, targeting_automation: { advantage_audience: 0 } });
  });

  it('keepTimeOfDay uses the next occurrence of a past start time', () => {
    const notes: PayloadNote[] = [];
    const out = startTimeFields({ start_time: '2026-09-04T10:00:00.000Z', end_time: null }, NOW, true, notes, 0);
    expect(new Date((out.start_time as number) * 1000).toISOString()).toBe('2026-09-17T10:00:00.000Z');
  });

  it('bid strategies that need a bid amount or ROAS floor fail without one', () => {
    const t = whitcombe();
    t.adset.budget.bid_strategy = 'COST_CAP';
    expect(() => opsFor(t, [set(0, 'US - Broad')])).toThrow(/needs a bid amount/);
    t.adset.budget.bid_strategy = 'LOWEST_COST_WITH_MIN_ROAS';
    expect(() => opsFor(t, [set(0, 'US - Broad')])).toThrow(/needs a ROAS floor/);
  });
});

describe('creatives and ads', () => {
  it('object_story_spec with page, instagram, link_data, SHOP_NOW, url params, enhancements off; ads are PAUSED', () => {
    const ad = { creativeId: 1, fileName: 'linen_4x5_01.jpg', primaryText: 'Body', headline: 'Head', description: '', destinationUrl: 'https://example-store.com/products/x' };
    const c = creativeFields(ad, '100000000000001', '17841400000000', 'abc123', 'utm_source=meta&utm_campaign=Test', 'SHOP_NOW', false);
    expect(c.object_story_spec).toMatchObject({ page_id: '100000000000001', instagram_user_id: '17841400000000', link_data: { image_hash: 'abc123', link: ad.destinationUrl, message: 'Body', name: 'Head', call_to_action: { type: 'SHOP_NOW' } } });
    expect((c.object_story_spec as { link_data: Record<string, unknown> }).link_data).not.toHaveProperty('description');
    expect(c.url_tags).toBe('utm_source=meta&utm_campaign=Test');
    const features = (c.degrees_of_freedom_spec as { creative_features_spec: Record<string, { enroll_status: string }> }).creative_features_spec;
    expect(features).not.toHaveProperty('standard_enhancements');
    expect(Object.values(features).every((f) => f.enroll_status === 'OPT_OUT')).toBe(true);
    expect(adFields('linen_4x5_01.jpg', '{result=set0:$.id}', '{result=cr1:$.id}')).toEqual({ name: 'linen_4x5_01.jpg', adset_id: '{result=set0:$.id}', creative: { creative_id: '{result=cr1:$.id}' }, status: 'PAUSED' });
  });
});
