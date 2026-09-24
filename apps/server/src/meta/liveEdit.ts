import { LiveCampaign, type BudgetMode, type InterestRef, type LaunchAd, type LaunchAdSet, type LiveChange, type LiveDiff, type Template } from '@conveyor/shared';
import type { BatchOp } from './batch.ts';
import type { MetaClient } from './client.ts';
import { adFields, adSetFields, assertPayloadRules, creativeFields, fillUrlParams, type PayloadNote } from './payloadRules.ts';
import { fillPattern, todayTag } from './templates.ts';

const READ_FIELDS = 'id,name,status,configured_status,effective_status,daily_budget,lifetime_budget,adsets.limit(100){id,name,status,effective_status,daily_budget,lifetime_budget,targeting{flexible_spec},ads.limit(100){id,name,status,effective_status,creative{id}}}';

interface RawRead {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  adsets?: { data: { id: string; name: string; status: string; daily_budget?: string; lifetime_budget?: string; targeting?: { flexible_spec?: { interests?: { id: string; name: string }[] }[] }; ads?: { data: { id: string; name: string; status: string; creative?: { id: string } }[] } }[] };
}

/** One request with nested fields. */
export async function readLiveCampaign(client: MetaClient, metaCampaignId: string, meta: { productId: number | null; jobId: number | null }): Promise<{ live: LiveCampaign; requestId: string | null }> {
  const { data, requestId } = await client.get<RawRead>(metaCampaignId, { fields: READ_FIELDS }, { purpose: 'read_campaign', ...meta });
  const minor = (v?: string) => (v == null ? null : Number.parseInt(v, 10));
  const live = LiveCampaign.parse({
    id: data.id,
    name: data.name,
    status: data.status,
    effectiveStatus: data.effective_status ?? null,
    dailyBudgetMinor: minor(data.daily_budget),
    lifetimeBudgetMinor: minor(data.lifetime_budget),
    adSets: (data.adsets?.data ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      dailyBudgetMinor: minor(s.daily_budget),
      lifetimeBudgetMinor: minor(s.lifetime_budget),
      interests: (s.targeting?.flexible_spec ?? []).flatMap((g) => g.interests ?? []).map((i) => ({ id: String(i.id), name: i.name })),
      ads: (s.ads?.data ?? []).map((a) => ({ id: a.id, name: a.name, status: a.status, creativeId: a.creative?.id ?? null })),
    })),
    readAt: new Date().toISOString(),
  });
  return { live, requestId };
}

/** What changed in Meta since the last read, shown before applying (step 1, second sentence). */
export function diffLive(before: LiveCampaign | null, after: LiveCampaign): LiveDiff[] {
  if (!before) return [];
  const out: LiveDiff[] = [];
  const cmp = (path: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, before: a, after: b });
  };
  cmp('campaign.name', before.name, after.name);
  cmp('campaign.status', before.status, after.status);
  cmp('campaign.dailyBudgetMinor', before.dailyBudgetMinor, after.dailyBudgetMinor);
  const seen = new Set<string>();
  for (const s of after.adSets) {
    seen.add(s.id);
    const b = before.adSets.find((x) => x.id === s.id);
    if (!b) {
      out.push({ path: `adset ${s.name}`, before: null, after: 'added in Meta' });
      continue;
    }
    cmp(`adset ${s.name}.name`, b.name, s.name);
    cmp(`adset ${s.name}.status`, b.status, s.status);
    cmp(`adset ${s.name}.dailyBudgetMinor`, b.dailyBudgetMinor, s.dailyBudgetMinor);
    cmp(`adset ${s.name}.interests`, b.interests.map((i) => i.id).sort(), s.interests.map((i) => i.id).sort());
    for (const a of s.ads) {
      const ba = b.ads.find((x) => x.id === a.id);
      if (!ba) out.push({ path: `ad ${a.name}`, before: null, after: 'added in Meta' });
      else cmp(`ad ${a.name}.status`, ba.status, a.status);
    }
    for (const ba of b.ads) if (!s.ads.some((x) => x.id === ba.id)) out.push({ path: `ad ${ba.name}`, before: 'present', after: 'gone from Meta' });
  }
  for (const b of before.adSets) if (!seen.has(b.id)) out.push({ path: `adset ${b.name}`, before: 'present', after: 'gone from Meta' });
  return out;
}

/** Edits that usually restart the learning phase: adding ads, changing targeting, budget changes over 20%. */
export function learningWarnings(changes: LiveChange[], live: LiveCampaign): string[] {
  const w: string[] = [];
  for (const c of changes) {
    if (c.type === 'add_ad' || c.type === 'add_adset' || c.type === 'replace_ad_creative') w.push(`${c.type === 'add_adset' ? `New ad set ${c.adSet.name}` : c.type === 'add_ad' ? `New ad in ${live.adSets.find((s) => s.id === c.adSetId)?.name ?? c.adSetId}` : 'Replacing an ad\'s creative'} restarts learning for that ad set.`);
    if (c.type === 'adset_interests') w.push(`Changing targeting on ${live.adSets.find((s) => s.id === c.adSetId)?.name ?? c.adSetId} restarts its learning phase.`);
    if (c.type === 'adset_budget') {
      const cur = live.adSets.find((s) => s.id === c.adSetId)?.dailyBudgetMinor;
      if (cur && Math.abs(c.dailyBudgetMinor - cur) / cur > 0.2) w.push(`Budget change on ${live.adSets.find((s) => s.id === c.adSetId)?.name} is over 20% (${cur} → ${c.dailyBudgetMinor}), which usually restarts learning.`);
    }
    if (c.type === 'campaign_budget' && live.dailyBudgetMinor && Math.abs(c.dailyBudgetMinor - live.dailyBudgetMinor) / live.dailyBudgetMinor > 0.2) w.push(`Campaign budget change is over 20% (${live.dailyBudgetMinor} → ${c.dailyBudgetMinor}), which usually restarts learning.`);
  }
  return w;
}

export interface EditPlanInput {
  template: Template;
  mode: BudgetMode;
  live: LiveCampaign;
  changes: LiveChange[];
  adAccountId: string;
  pageId: string;
  instagramUserId: string | null;
  pixelId: string | null;
  /** creativeId (Conveyor) → Meta image hash, for new ads. */
  imageHashes: Map<number, string>;
  urlParams: string;
  now: Date;
  keepTimeOfDay: boolean;
}

/**
 * The change list as one batch. Removals pause; nothing is deleted
 * or archived. Sharing is never touched. New objects are created PAUSED and pass the payload rules.
 */
export function planEditOps(p: EditPlanInput): { ops: BatchOp[]; notes: PayloadNote[]; newCreatives: number } {
  const ops: BatchOp[] = [];
  const notes: PayloadNote[] = [];
  const act = p.adAccountId;
  const t = p.template;
  const campaignName = p.live.name;
  const urlParams = fillUrlParams(p.urlParams, { campaign: campaignName, template: t.name, date: todayTag(p.now) });
  const creativeNames = new Map<string, string>();
  const creativeFor = (ad: LaunchAd): string => {
    const hash = p.imageHashes.get(ad.creativeId);
    if (!hash) throw new Error(`Creative ${ad.fileName} has no Meta image hash.`);
    const key = JSON.stringify([hash, ad.primaryText, ad.headline, ad.description, ad.destinationUrl]);
    let name = creativeNames.get(key);
    if (!name) {
      name = `cr${creativeNames.size + 1}`;
      creativeNames.set(key, name);
      ops.push({ method: 'POST', relative_url: `${act}/adcreatives`, name, body: creativeFields(ad, p.pageId, p.instagramUserId, hash, urlParams, t.ad.default_cta || 'SHOP_NOW', t.ad.advantage_creative_enhancements) });
    }
    return `{result=${name}:$.id}`;
  };
  let n = 0;
  for (const c of p.changes) {
    switch (c.type) {
      case 'rename_campaign':
        ops.push({ method: 'POST', relative_url: p.live.id, name: `e${n++}`, body: { name: c.name } });
        break;
      case 'campaign_status':
        ops.push({ method: 'POST', relative_url: p.live.id, name: `e${n++}`, body: { status: c.status } });
        break;
      case 'campaign_budget':
        if (p.mode !== 'CBO') throw new Error('The campaign budget can only be changed under CBO.');
        ops.push({ method: 'POST', relative_url: p.live.id, name: `e${n++}`, body: { daily_budget: c.dailyBudgetMinor } });
        break;
      case 'adset_status':
        ops.push({ method: 'POST', relative_url: c.adSetId, name: `e${n++}`, body: { status: c.status } });
        break;
      case 'adset_budget':
        if (p.mode !== 'ABO') throw new Error('Ad set budgets can only be changed under ABO.');
        ops.push({ method: 'POST', relative_url: c.adSetId, name: `e${n++}`, body: { daily_budget: c.dailyBudgetMinor } });
        break;
      case 'rename_adset':
        ops.push({ method: 'POST', relative_url: c.adSetId, name: `e${n++}`, body: { name: c.name } });
        break;
      case 'adset_interests': {
        // Targeting is replaced whole, from the template plus the new interests, so the rules apply.
        const set: LaunchAdSet = { index: 0, name: c.adSetId, budgetMinor: null, interestKind: 'picked', interestLabel: null, interests: c.interests as InterestRef[], suggestions: [], countryOverride: null, ageBand: null, ads: [] };
        const fields = adSetFields({ template: t, set, campaignRef: p.live.id, pixelId: p.pixelId, now: p.now, keepTimeOfDay: p.keepTimeOfDay, notes });
        ops.push({ method: 'POST', relative_url: c.adSetId, name: `e${n++}`, body: { targeting: fields.targeting } });
        break;
      }
      case 'ad_status':
        ops.push({ method: 'POST', relative_url: c.adId, name: `e${n++}`, body: { status: c.status } });
        break;
      case 'add_adset': {
        const setName = `newset${n++}`;
        ops.push({ method: 'POST', relative_url: `${act}/adsets`, name: setName, body: adSetFields({ template: t, set: c.adSet, campaignRef: p.live.id, pixelId: p.pixelId, now: p.now, keepTimeOfDay: p.keepTimeOfDay, notes }) });
        c.adSet.ads.forEach((ad, j) => ops.push({ method: 'POST', relative_url: `${act}/ads`, name: `${setName}_ad${j}`, body: adFields(fillPattern(t.ad.name_pattern, { creative_filename: ad.fileName, campaign: campaignName, variation: c.adSet.name }) || ad.fileName, `{result=${setName}:$.id}`, creativeFor(ad)) }));
        break;
      }
      case 'add_ad':
        ops.push({ method: 'POST', relative_url: `${act}/ads`, name: `newad${n++}`, body: adFields(fillPattern(t.ad.name_pattern, { creative_filename: c.ad.fileName, campaign: campaignName }) || c.ad.fileName, c.adSetId, creativeFor(c.ad)) });
        break;
      case 'replace_ad_creative':
        // A new creative, then the ad updated to use it (the Confirm in section 9.7).
        ops.push({ method: 'POST', relative_url: c.adId, name: `e${n++}`, body: { creative: { creative_id: creativeFor(c.ad) } } });
        break;
    }
  }
  // Creatives must exist before the ads that reference them: move them to the front.
  const creatives = ops.filter((o) => o.relative_url.endsWith('/adcreatives'));
  const rest = ops.filter((o) => !o.relative_url.endsWith('/adcreatives'));
  const ordered = [...creatives, ...rest];
  assertPayloadRules(ordered, p.mode);
  return { ops: ordered, notes, newCreatives: creatives.length };
}

/** 1 read + 1 batch, plus an upload batch when a new ad uses an image Meta has not seen. */
export function editRequestCount(ops: number, newImages: number): number {
  return 1 + Math.ceil(Math.max(ops, 1) / 50) + (newImages ? Math.ceil(newImages / 50) : 0);
}
