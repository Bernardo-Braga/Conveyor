import { and, eq } from 'drizzle-orm';
import { ShopifySnapshot, type Aspect, type FillRule, type LaunchAd, type LaunchAdSet, type LaunchStructure, type Template } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { creatives, productCopy, products } from '../db/schema.ts';
import { JobStepError } from '../jobs/types.ts';
import type { BatchOp } from './batch.ts';
import { BATCH_LIMIT, refsOf, splitByDependencies, withSavedIds } from './batch.ts';
import { opError, type MetaClient } from './client.ts';
import { resolveVariantInterests } from './interests.ts';
import { adFields, adSetFields, assertPayloadRules, campaignFields, creativeFields, fillUrlParams, type PayloadNote } from './payloadRules.ts';
import { fillPattern, parseAgeBand, todayTag } from './templates.ts';

type CreativeRow = typeof creatives.$inferSelect;

export interface StructureInput {
  template: Template;
  productId: number;
  fillRule: FillRule;
  readInterestsFromNames: boolean;
  /** The creatives chosen for this launch, in order. `null` (or absent) means every approved one. */
  creativeIds?: number[] | null;
  now?: Date;
}

/** Approved, finished, clean creatives for a product, oldest first. */
export function approvedCreatives(db: Db, productId: number): CreativeRow[] {
  return db
    .select()
    .from(creatives)
    .where(and(eq(creatives.productId, productId), eq(creatives.approval, 'approved'), eq(creatives.status, 'finished')))
    .all()
    .sort((a, b) => a.id - b.id);
}

/**
 * The creatives a launch fills its ads with: the chosen ones in the order they were chosen, or
 * every approved one when nothing was chosen. Unapproved choices are kept so preflight can name
 * them, rather than dropped, which would shrink the ad sets without saying so.
 */
export function launchCreativePool(db: Db, productId: number, chosen?: number[] | null): CreativeRow[] {
  if (!chosen) return approvedCreatives(db, productId);
  const rows = db.select().from(creatives).where(and(eq(creatives.productId, productId), eq(creatives.status, 'finished'))).all();
  return chosen.map((id) => rows.find((r) => r.id === id)).filter((r): r is CreativeRow => !!r);
}

/** The copy for a product: its saved copy if any, else the template's example copy. */
export function copyFor(db: Db, productId: number, t: Template, snapshot: ShopifySnapshot | null): { primaryText: string; headline: string; description: string; destinationUrl: string } {
  const saved = db.select().from(productCopy).where(eq(productCopy.productId, productId)).all().at(-1);
  const destination = snapshot?.onlineStoreUrl ?? (snapshot ? t.ad.destination_url.replace(/\/products\/[^/?#]+/, `/products/${snapshot.handle}`) : t.ad.destination_url);
  return { primaryText: saved?.bodyText ?? t.ad.primary_text, headline: saved?.headline ?? t.ad.headline, description: saved?.description ?? t.ad.description, destinationUrl: destination };
}

/** Fill rules. Returns creative IDs per ad set. */
/**
 * How many different creatives a fill rule actually consumes, which is what the Launch view asks
 * the user to choose: the same set in every ad set needs only one ad set's worth.
 */
export function creativeSlots(rule: FillRule, adSetCount: number, adsPerAdSet: number): number {
  if (rule === 'manual') return 0;
  if (rule === 'rotate') return adSetCount * adsPerAdSet;
  if (rule === 'one_per_adset') return adSetCount;
  return adsPerAdSet; // one_per_ad and by_format reuse the pool in every ad set
}

export function fillCreatives(rule: FillRule, adSetNames: string[], adsPerAdSet: number, pool: { id: number; aspect: Aspect }[]): number[][] {
  if (!pool.length || rule === 'manual') return adSetNames.map(() => []);
  if (rule === 'one_per_ad') return adSetNames.map(() => pool.slice(0, adsPerAdSet).map((c) => c.id));
  if (rule === 'rotate') {
    let k = 0;
    return adSetNames.map(() => Array.from({ length: Math.min(adsPerAdSet, pool.length) }, () => pool[k++ % pool.length]!.id));
  }
  if (rule === 'one_per_adset') return adSetNames.map((_, i) => (pool[i % pool.length] ? [pool[i % pool.length]!.id] : []));
  // by_format: 9:16 into Reels and Stories ad sets, the others elsewhere.
  const vertical = pool.filter((c) => c.aspect === '9:16');
  const rest = pool.filter((c) => c.aspect !== '9:16');
  return adSetNames.map((name) => {
    const wantsVertical = /reel|stor(y|ies)/i.test(name);
    const source = wantsVertical && vertical.length ? vertical : rest.length ? rest : pool;
    return source.slice(0, adsPerAdSet).map((c) => c.id);
  });
}

/**
 * Turns a template plus the product's approved creatives into the structure the board shows
 * and the launcher sends. Local only: interests come from the cache (`findInterests` ran first).
 */
export function buildStructure(db: Db, input: StructureInput): { structure: LaunchStructure; notes: string[]; creativeRows: CreativeRow[] } {
  const { template: t, productId } = input;
  const now = input.now ?? new Date();
  const notes: string[] = [];
  const row = db.select().from(products).where(eq(products.id, productId)).get();
  if (!row) throw new JobStepError('Product not found.');
  const snapshot = row.snapshot ? ShopifySnapshot.parse(row.snapshot) : null;
  const campaignName = fillPattern(t.campaign.name_pattern, { date: todayTag(now), template: t.name, campaign: '' });
  const copy = copyFor(db, productId, t, snapshot);
  const pool = launchCreativePool(db, productId, input.creativeIds);
  if (pool.length < t.ads_per_adset) notes.push(`${pool.length} approved creative(s) for ${t.ads_per_adset} ads per ad set; each ad set gets ${Math.min(pool.length, t.ads_per_adset)}.`);

  const count = t.adset_count;
  if (t.adset_variants.length > count) notes.push(`${t.adset_variants.length - count} surplus variant(s) ignored (adset_count is ${count}).`);
  if (t.adset_variants.length < count) notes.push(`${count - t.adset_variants.length} extra ad set(s) use the shared settings.`);
  const names: string[] = [];
  const partial: Omit<LaunchAdSet, 'ads'>[] = [];
  for (let i = 0; i < count; i++) {
    const v = t.adset_variants[i] ?? { name: `Ad set ${i + 1}`, country: '', age_band: '', interests: [], custom_audiences: [] };
    const resolved = resolveVariantInterests(db, v, input.readInterestsFromNames);
    const band = parseAgeBand(v.age_band ?? '');
    if (!band.ok) notes.push(`${v.name}: ${band.reason}; ignored.`);
    const override = input.fillRule && t.x_conveyor?.variants?.[String(i)]?.budget?.daily_budget_minor;
    const budgetMinor = t.campaign.budget.mode === 'ABO' ? (override ?? t.adset.budget.daily_budget_minor ?? t.adset.budget.lifetime_budget_minor) : null;
    const name = fillPattern(t.adset.name_pattern, { campaign: campaignName, variation: v.name, template: t.name, date: todayTag(now) });
    names.push(name);
    partial.push({ index: i, name, budgetMinor, interestKind: resolved.kind, interestLabel: resolved.label, interests: resolved.interests, suggestions: resolved.suggestions, countryOverride: v.country?.trim() || null, ageBand: band.ok ? band.range : null });
  }

  const fill = t.x_conveyor?.fillRule ?? input.fillRule;
  const assignment = fillCreatives(fill, names, t.ads_per_adset, pool.map((c) => ({ id: c.id, aspect: c.aspect })));
  const adSets: LaunchAdSet[] = partial.map((p, i) => ({
    ...p,
    ads: assignment[i]!.map((creativeId): LaunchAd => {
      const c = pool.find((x) => x.id === creativeId)!;
      return { creativeId, fileName: c.fileName ?? `creative-${creativeId}.jpg`, ...copy };
    }),
  }));
  return { structure: { campaignName, adSets }, notes, creativeRows: pool };
}

export interface PlanInput {
  template: Template;
  structure: LaunchStructure;
  adAccountId: string;
  pageId: string;
  instagramUserId: string | null;
  pixelId: string | null;
  imageHashes: Map<number, string>;
  urlParams: string;
  now: Date;
  keepTimeOfDay: boolean;
}

/** Operation names are stable so a retry can skip the ones that already returned an ID. */
export function planOperations(p: PlanInput): { ops: BatchOp[]; notes: PayloadNote[]; creativeOps: number } {
  const notes: PayloadNote[] = [];
  const t = p.template;
  const act = p.adAccountId;
  const ops: BatchOp[] = [{ method: 'POST', relative_url: `${act}/campaigns`, name: 'campaign', body: campaignFields(t, p.structure.campaignName) }];
  const creativeNames = new Map<string, string>();
  const urlParams = fillUrlParams(p.urlParams, { campaign: p.structure.campaignName, template: t.name, date: todayTag(p.now) });
  p.structure.adSets.forEach((set) => {
    ops.push({ method: 'POST', relative_url: `${act}/adsets`, name: `set${set.index}`, body: adSetFields({ template: t, set, campaignRef: '{result=campaign:$.id}', pixelId: p.pixelId || t.adset.promoted_object.pixel_id || null, now: p.now, keepTimeOfDay: p.keepTimeOfDay, notes }) });
    set.ads.forEach((ad, j) => {
      const hash = p.imageHashes.get(ad.creativeId);
      if (!hash) throw new JobStepError(`Creative ${ad.fileName} has no Meta image hash yet.`, { suggestion: 'Retry from the upload step.' });
      // The same image and copy make one creative, shared by every ad that uses it.
      const key = JSON.stringify([hash, ad.primaryText, ad.headline, ad.description, ad.destinationUrl]);
      let crName = creativeNames.get(key);
      if (!crName) {
        crName = `cr${creativeNames.size + 1}`;
        creativeNames.set(key, crName);
        ops.push({ method: 'POST', relative_url: `${act}/adcreatives`, name: crName, body: creativeFields(ad, p.pageId, p.instagramUserId, hash, urlParams, t.ad.default_cta || 'SHOP_NOW', t.ad.advantage_creative_enhancements) });
      }
      const adName = fillPattern(t.ad.name_pattern, { creative_filename: ad.fileName, campaign: p.structure.campaignName, variation: set.name, template: t.name, date: todayTag(p.now) }) || ad.fileName;
      ops.push({ method: 'POST', relative_url: `${act}/ads`, name: `ad${set.index}_${j}`, body: adFields(adName, `{result=set${set.index}:$.id}`, `{result=${crName}:$.id}`) });
    });
  });
  return { ops, notes, creativeOps: creativeNames.size };
}

/** Operation count and request count shown before launching. */
export function launchCounts(structure: LaunchStructure, uniqueCreatives: number, newImages: number): { operations: number; batches: number; requests: number } {
  const ads = structure.adSets.reduce((n, s) => n + s.ads.length, 0);
  const operations = 1 + structure.adSets.length + uniqueCreatives + ads;
  const batches = Math.ceil(operations / 50);
  return { operations, batches, requests: batches + (newImages > 0 ? Math.ceil(newImages / 50) : 0) };
}

/**
 * Uploads finished JPEGs that have no Meta hash yet, in one batch per 50, with the files attached.
 * Hashes are stored on the creative so nothing is uploaded twice.
 */
export async function uploadImages(client: MetaClient, db: Db, adAccountId: string, rows: CreativeRow[], readFile: (path: string) => Promise<Buffer>, meta: { productId: number; jobId: number | null }): Promise<{ requests: number; uploaded: number; hashes: Map<number, string> }> {
  const hashes = new Map<number, string>();
  const todo: CreativeRow[] = [];
  for (const r of rows) {
    if (r.metaImageHash) hashes.set(r.id, r.metaImageHash);
    else todo.push(r);
  }
  let requests = 0;
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50);
    const files: Record<string, { data: Buffer; filename: string; type: string }> = {};
    const ops: BatchOp[] = [];
    for (const [k, r] of chunk.entries()) {
      if (!r.finishedPath) throw new JobStepError(`Creative ${r.id} has no finished file.`);
      const key = `img${k}`;
      files[key] = { data: await readFile(r.finishedPath), filename: r.fileName ?? `creative-${r.id}.jpg`, type: 'image/jpeg' };
      ops.push({ method: 'POST', relative_url: `${adAccountId}/adimages`, name: key, attached_files: key, body: { name: r.fileName ?? `creative-${r.id}.jpg` } });
    }
    const { results, requestId } = await client.batch(ops, { purpose: 'adimages', ...meta }, files);
    requests += 1;
    results.forEach((res, k) => {
      const r = chunk[k]!;
      const err = opError(res);
      if (err) throw new JobStepError(`Image upload failed for ${r.fileName}: ${err.message ?? 'error'} (code ${err.code ?? '?'})`, { service: 'meta', code: err.code != null ? String(err.code) : null, requestId, suggestion: 'Retry this step; images already uploaded are not sent again.', retryable: true });
      const images = (res.body as { images?: Record<string, { hash?: string }> } | null)?.images ?? {};
      const hash = Object.values(images)[0]?.hash;
      if (!hash) throw new JobStepError(`No image hash returned for ${r.fileName}.`, { service: 'meta', requestId, retryable: true });
      db.update(creatives).set({ metaImageHash: hash }).where(eq(creatives.id, r.id)).run();
      hashes.set(r.id, hash);
    });
  }
  return { requests, uploaded: todo.length, hashes };
}

export interface ObjectBatchOutcome {
  requests: number;
  /** IDs an earlier attempt created but never received, read back from their ads. */
  recovered: string[];
  savedIds: Record<string, string>;
  failed: { name: string; message: string; code: number | null; subcode: number | null }[];
  requestId: string | null;
}

/** The one reference an operation's body holds in `field`, e.g. the ad set an ad is created under. */
function refIn(op: BatchOp | undefined, field: string): string | null {
  const v = op?.body?.[field];
  return v == null ? null : (refsOf({ ...op!, relative_url: '', body: { [field]: v } })[0] ?? null);
}

/**
 * Takes a parent's ID back off a child that already has one. An ad knows its campaign, ad set
 * and creative, so one batch of reads recovers IDs an earlier attempt never received (Meta used
 * to omit them; see `client.batch`). Nothing is created, and a retry then sends only what is
 * genuinely missing.
 */
export async function recoverParentIds(client: MetaClient, ops: BatchOp[], savedIds: Record<string, string>, meta: { productId: number; jobId: number | null }): Promise<{ requests: number; ids: Record<string, string> }> {
  const missing = new Set(ops.filter((o) => o.name && !savedIds[o.name]).map((o) => o.name!));
  const ids: Record<string, string> = {};
  if (!missing.size) return { requests: 0, ids };
  const byName = new Map(ops.filter((o) => o.name).map((o) => [o.name!, o] as const));
  const savedAds = ops.filter((o) => o.name && savedIds[o.name] && /\/ads$/.test(o.relative_url));
  /** The names one ad can give back: its ad set, its creative, and the campaign its ad set names. */
  const parentsOf = (ad: BatchOp): (string | null)[] => {
    const setName = refIn(ad, 'adset_id');
    return [setName, refIn(ad, 'creative'), refIn(byName.get(setName ?? ''), 'campaign_id')];
  };
  // One saved ad per missing parent is enough, and the same ad often covers several of them.
  const sources = new Map<string, BatchOp>();
  for (const name of missing) {
    const child = savedAds.find((o) => parentsOf(o).includes(name));
    if (child) sources.set(child.name!, child);
  }
  if (!sources.size) return { requests: 0, ids };

  const list = [...sources.values()];
  let requests = 0;
  for (let i = 0; i < list.length; i += BATCH_LIMIT) {
    const chunk = list.slice(i, i + BATCH_LIMIT);
    const res = await client.batch(chunk.map((o) => ({ method: 'GET' as const, relative_url: `${savedIds[o.name!]}?fields=campaign_id,adset_id,creative{id}` })), { purpose: 'launch_recover', ...meta });
    requests += 1;
    res.results.forEach((r, j) => {
      if (opError(r)) return;
      const ad = r.body as { campaign_id?: string; adset_id?: string; creative?: { id?: string } } | null;
      const [setName, creativeName, campaignName] = parentsOf(chunk[j]!);
      for (const [name, id] of [[setName, ad?.adset_id], [creativeName, ad?.creative?.id], [campaignName, ad?.campaign_id]] as const) {
        if (name && id && missing.has(name)) ids[name] = id;
      }
    });
  }
  return { requests, ids };
}

/**
 * Sends the object operations in dependency order, 50 per request, saving every returned ID at
 * once. Operations whose ID is already saved are not sent again, so a retry after a mid-batch
 * failure creates nothing twice.
 */
export async function runObjectBatches(client: MetaClient, ops: BatchOp[], mode: 'CBO' | 'ABO', savedIds: Record<string, string>, meta: { productId: number; jobId: number | null }, onSaved: (name: string, id: string) => void): Promise<ObjectBatchOutcome> {
  const saved = { ...savedIds };
  const recovered: string[] = [];
  let recoveryRequests = 0;
  if (Object.keys(saved).length) {
    // A retry: objects the earlier attempt created but whose ID never came back are found again
    // from their ads rather than created a second time.
    const r = await recoverParentIds(client, ops, saved, meta);
    recoveryRequests = r.requests;
    for (const [name, id] of Object.entries(r.ids)) {
      saved[name] = id;
      recovered.push(name);
      onSaved(name, id);
    }
  }
  // References to operations that already returned an ID are replaced before splitting,
  // so a resume never re-sends them and never trips the dependency check.
  const pending = withSavedIds(ops.filter((op) => !(op.name && saved[op.name])), saved);
  let requests = recoveryRequests;
  let requestId: string | null = null;
  const failed: ObjectBatchOutcome['failed'] = [];
  for (const batch of splitByDependencies(pending, 50)) {
    const send = withSavedIds(batch, saved);
    assertPayloadRules(send, mode);
    const res = await client.batch(send, { purpose: 'launch_objects', ...meta });
    requests += 1;
    requestId = res.requestId;
    res.results.forEach((r, i) => {
      const op = batch[i]!;
      const err = opError(r);
      if (err) {
        failed.push({ name: op.name ?? op.relative_url, message: err.error_user_msg ?? err.message ?? 'error', code: err.code ?? null, subcode: err.error_subcode ?? null });
        return;
      }
      const id = (r.body as { id?: string } | null)?.id;
      if (id && op.name) {
        saved[op.name] = id;
        onSaved(op.name, id);
      }
    });
    if (failed.length) break; // later batches would reference missing IDs; the retry sends only what is left
  }
  return { requests, recovered, savedIds: saved, failed, requestId };
}
