import fs from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApplyEditsInput, LaunchInput, ShopifySnapshot, Template, type JobError } from '@conveyor/shared';
import { adSets, ads, campaignEdits, campaigns, products } from '../db/schema.ts';
import { opError } from '../meta/client.ts';
import { diffLive, learningWarnings, planEditOps, readLiveCampaign } from '../meta/liveEdit.ts';
import type { MetaClient } from '../meta/client.ts';
import { findInterests, interestFromName, validateInterests } from '../meta/interests.ts';
import { pullInsights } from '../meta/insights.ts';
import { approvedCreatives, buildStructure, launchCounts, planOperations, runObjectBatches, uploadImages } from '../meta/launch.ts';
import { launchBlockers, preflight } from '../meta/preflight.ts';
import { readState, saveState, type LaunchState } from '../meta/repo.ts';
import { getTemplate } from '../meta/templates.ts';
import { markAttention, setState } from '../products/repo.ts';
import type { ShopifyClient } from '../shopify/client.ts';
import { isFresh, readSnapshot, storeSnapshot } from '../shopify/snapshot.ts';
import { JobStepError, type JobDefinition } from './types.ts';

export const LaunchJobInput = LaunchInput.extend({ campaignId: z.number().int().nullable().default(null) });
export type LaunchJobInput = z.infer<typeof LaunchJobInput>;

/**
 * Station 4 (PLAN.md section 9.6). Steps: snapshot (0 or 1) → interests (0 or 1 batch) →
 * preflight (local) → upload (1 batch per 50 new images) → objects (1 batch per 50 operations)
 * → finish. Every ID is saved as it returns; a retry sends only the operations still missing.
 * Every object is created PAUSED. Activation is its own job, run only from a user action.
 */
export function launchJob(deps: { meta: MetaClient; shopify: ShopifyClient }): JobDefinition<LaunchJobInput> {
  return {
    type: 'launch',
    input: LaunchJobInput,
    steps: [
      {
        name: 'snapshot',
        async run(ctx) {
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get();
          if (!row?.shopifyProductId) throw new JobStepError('This product is not in Shopify.');
          if (isFresh(row.snapshotAt)) {
            ctx.log('Shopify snapshot is under 10 minutes old; reused. 0 requests.');
            return { requests: 0 };
          }
          const { snapshot, requestId } = await readSnapshot(deps.shopify, row.shopifyProductId, { productId: row.id, jobId: ctx.jobId });
          storeSnapshot(ctx.db, row.id, snapshot);
          ctx.log(`Read the product back from Shopify (1 query): status ${snapshot.status}.`, 'info', requestId);
          return { requests: 1 };
        },
      },
      {
        name: 'interests',
        async run(ctx) {
          const t = getTemplate(ctx.db, ctx.input.templateId);
          if (!t) throw new JobStepError('Template not found.');
          const setup = ctx.settings.get('adsetup');
          if (!setup.readInterestsFromNames) return { requests: 0 };
          const labels = t.adset_variants.filter((v) => !v.interests.length).map((v) => interestFromName(v.name)).flatMap((r) => (r.kind === 'lookup' ? [r.label] : []));
          const r = await findInterests(deps.meta, ctx.db, labels, { productId: ctx.input.productId, jobId: ctx.jobId });
          ctx.log(r.requests ? `Looked up ${r.matched.length + r.unmatched.length} interest name(s) in one batch: ${r.matched.length} matched, ${r.unmatched.length} need a pick.` : 'Every interest name was already cached. 0 requests.');
          return r;
        },
      },
      {
        name: 'preflight',
        async run(ctx) {
          const t = getTemplate(ctx.db, ctx.input.templateId)!;
          const setup = ctx.settings.get('adsetup');
          const conn = ctx.settings.get('connections').meta;
          const row = ctx.db.select().from(products).where(eq(products.id, ctx.input.productId)).get()!;
          const built = buildStructure(ctx.db, { template: t, productId: row.id, fillRule: setup.fillRule, readInterestsFromNames: setup.readInterestsFromNames });
          const { creativeRows } = built;
          let structure = built.structure;
          if (ctx.input.structure) {
            // A board-edited structure: only approved, finished creatives of this product may appear in it.
            const allowed = new Set(creativeRows.map((c) => c.id));
            const stray = ctx.input.structure.adSets.flatMap((s) => s.ads.filter((a) => !allowed.has(a.creativeId)).map((a) => a.fileName));
            if (stray.length) throw new JobStepError(`The board uses creatives that are not approved for this product: ${stray.join(', ')}.`);
            structure = ctx.input.structure;
            ctx.log('Using the board-edited structure.');
          }
          for (const n of built.notes) ctx.log(n, 'warn');
          const checks = preflight({ template: t, structure, snapshot: row.snapshot ? ShopifySnapshot.parse(row.snapshot) : null, creatives: creativeRows, pageId: conn.pageId, pixelId: conn.pixelId, adAccountId: conn.adAccountId, tokenSet: !!(await ctx.secrets.get('meta_access_token')) });
          const blockers = launchBlockers(checks, ctx.input.acknowledge);
          if (blockers.length) throw new JobStepError(`Launch checks failed: ${blockers.map((b) => b.message).join(' ')}`, { suggestion: 'Fix the items above, or acknowledge the warnings, then launch again.' });

          // The campaign row holds the template copy and the launch state; a retry reuses it.
          let campaignId = ctx.input.campaignId;
          if (!campaignId) {
            const state: LaunchState = { name: structure.campaignName, mode: t.campaign.budget.mode, structure, savedIds: {}, operations: 0, error: null, adAccountId: conn.adAccountId };
            campaignId = ctx.db.insert(campaigns).values({ productId: row.id, templateJson: t, status: 'launching', lastState: state }).returning({ id: campaigns.id }).get().id;
            for (const s of structure.adSets) {
              const setId = ctx.db.insert(adSets).values({ campaignId, name: s.name, budgetMinor: s.budgetMinor, overrides: { countryOverride: s.countryOverride, ageBand: s.ageBand }, interests: s.interests, interestSource: s.interestKind === 'file' ? 'file' : s.interestKind === 'picked' ? 'pick' : s.interests.length ? 'name' : 'none' }).returning({ id: adSets.id }).get().id;
              for (const a of s.ads) ctx.db.insert(ads).values({ adSetId: setId, creativeId: a.creativeId, insights: { name: a.fileName } }).run();
            }
          } else saveState(ctx.db, campaignId, { structure }, { status: 'launching' });
          ctx.log(`${checks.filter((c) => c.level === 'info').length} note(s), ${checks.filter((c) => c.level === 'warn').length} warning(s) acknowledged. ${structure.adSets.length} ad sets, ${structure.adSets.reduce((n, s) => n + s.ads.length, 0)} ads.`);
          return { campaignId, checks };
        },
      },
      {
        name: 'upload',
        async run(ctx) {
          const { campaignId } = ctx.prior.preflight as { campaignId: number };
          const state = readState(ctx.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get()!);
          const t = getTemplate(ctx.db, ctx.input.templateId)!;
          const { creativeRows } = buildStructure(ctx.db, { template: t, productId: ctx.input.productId, fillRule: ctx.settings.get('adsetup').fillRule, readInterestsFromNames: false });
          const used = new Set(state.structure.adSets.flatMap((s) => s.ads.map((a) => a.creativeId)));
          const rows = creativeRows.filter((c) => used.has(c.id));
          const r = await uploadImages(deps.meta, ctx.db, state.adAccountId, rows, (p) => fs.readFile(p), { productId: ctx.input.productId, jobId: ctx.jobId });
          ctx.log(r.uploaded ? `Uploaded ${r.uploaded} image(s) in ${r.requests} batch request(s); hashes saved.` : 'Every image already had a Meta hash. 0 requests.');
          return { requests: r.requests, hashes: Object.fromEntries(r.hashes) };
        },
      },
      {
        name: 'objects',
        async run(ctx) {
          const { campaignId } = ctx.prior.preflight as { campaignId: number };
          const { hashes } = ctx.prior.upload as { hashes: Record<string, string> };
          const t = getTemplate(ctx.db, ctx.input.templateId)!;
          const conn = ctx.settings.get('connections').meta;
          const setup = ctx.settings.get('adsetup');
          const state = readState(ctx.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get()!);
          const { ops, notes } = planOperations({ template: t, structure: state.structure, adAccountId: state.adAccountId, pageId: conn.pageId, instagramUserId: conn.instagramUserId || null, pixelId: conn.pixelId || null, imageHashes: new Map(Object.entries(hashes).map(([k, v]) => [Number(k), v])), urlParams: t.ad.url_params || setup.urlParams, now: new Date(), keepTimeOfDay: setup.keepTimeOfDay });
          for (const n of notes) ctx.log(`${n.scope}${n.index != null ? ` ${n.index + 1}` : ''}: ${n.message}`, 'warn');
          const already = Object.keys(state.savedIds).length;
          if (already) ctx.log(`${already} of ${ops.length} operations already have IDs from an earlier attempt; only the rest are sent.`);
          const counts = launchCounts(state.structure, ops.filter((o) => /adcreatives$/.test(o.relative_url)).length, 0);
          saveState(ctx.db, campaignId, { operations: counts.operations });

          const setRows = ctx.db.select().from(adSets).where(eq(adSets.campaignId, campaignId)).all();
          const onSaved = (name: string, id: string) => {
            saveState(ctx.db, campaignId, { savedIds: { ...readState(ctx.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get()!).savedIds, [name]: id } });
            if (name === 'campaign') ctx.db.update(campaigns).set({ metaCampaignId: id }).where(eq(campaigns.id, campaignId)).run();
            const set = name.match(/^set(\d+)$/);
            if (set) {
              const s = state.structure.adSets[Number(set[1])]!;
              const rowSet = setRows.find((r) => r.name === s.name);
              if (rowSet) ctx.db.update(adSets).set({ metaId: id }).where(eq(adSets.id, rowSet.id)).run();
            }
            const ad = name.match(/^ad(\d+)_(\d+)$/);
            if (ad) {
              const s = state.structure.adSets[Number(ad[1])]!;
              const rowSet = setRows.find((r) => r.name === s.name);
              const creativeId = s.ads[Number(ad[2])]!.creativeId;
              if (rowSet) ctx.db.update(ads).set({ metaAdId: id }).where(and(eq(ads.adSetId, rowSet.id), eq(ads.creativeId, creativeId))).run();
            }
          };
          const out = await runObjectBatches(deps.meta, ops, t.campaign.budget.mode, state.savedIds, { productId: ctx.input.productId, jobId: ctx.jobId }, onSaved);
          ctx.log(`${out.requests} object batch request(s); ${Object.keys(out.savedIds).length} of ${ops.length} operations have IDs.`, 'info', out.requestId);
          if (out.failed.length) {
            const first = out.failed[0]!;
            const msg = `${out.failed.length} operation(s) failed: ${out.failed.map((f) => `${f.name} (code ${f.code ?? '?'}${f.subcode ? ` / ${f.subcode}` : ''}: ${f.message})`).join('; ')}`;
            saveState(ctx.db, campaignId, { error: msg });
            throw new JobStepError(msg, { service: 'meta', code: first.code != null ? String(first.code) : null, subcode: first.subcode != null ? String(first.subcode) : null, requestId: out.requestId, suggestion: 'Fix the cause and retry this step. Objects already created are kept and not sent again.', retryable: true });
          }
          saveState(ctx.db, campaignId, { error: null });
          return { requests: out.requests, operations: ops.length };
        },
      },
      {
        name: 'finish',
        async run(ctx) {
          const { campaignId } = ctx.prior.preflight as { campaignId: number };
          ctx.db.update(campaigns).set({ status: 'paused', lastReadAt: new Date().toISOString() }).where(eq(campaigns.id, campaignId)).run();
          ctx.db.update(adSets).set({ status: 'PAUSED' }).where(eq(adSets.campaignId, campaignId)).run();
          setState(ctx.db, ctx.input.productId, 'paused_in_meta', { failure: null });
          ctx.log('Campaign created in Meta, paused. Activate it from the Launch view when you are ready.');
          return { campaignId };
        },
      },
    ],
    onError(ctx, error: JobError) {
      const campaignId = (ctx.prior.preflight as { campaignId?: number } | undefined)?.campaignId ?? ctx.input.campaignId;
      if (campaignId) ctx.db.update(campaigns).set({ status: 'failed' }).where(eq(campaigns.id, campaignId)).run();
      markAttention(ctx.db, ctx.input.productId, error);
    },
  };
}

export const ActivateInput = z.object({ campaignId: z.number().int(), action: z.enum(['activate', 'pause']) });

/** One request, only from a user action (PLAN.md section 9.6). Nothing else ever sets ACTIVE. */
export function activateJob(deps: { meta: MetaClient }): JobDefinition<z.infer<typeof ActivateInput>> {
  return {
    type: 'activate_campaign',
    input: ActivateInput,
    steps: [
      {
        name: 'status',
        async run(ctx) {
          const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, ctx.input.campaignId)).get();
          if (!row?.metaCampaignId) throw new JobStepError('This campaign has not been created in Meta yet.');
          const status = ctx.input.action === 'activate' ? 'ACTIVE' : 'PAUSED';
          const { requestId } = await deps.meta.post(row.metaCampaignId, { status }, { purpose: ctx.input.action, productId: row.productId, jobId: ctx.jobId });
          ctx.db.update(campaigns).set({ status: status === 'ACTIVE' ? 'active' : 'paused' }).where(eq(campaigns.id, row.id)).run();
          setState(ctx.db, row.productId, status === 'ACTIVE' ? 'live' : 'paused_in_meta', { failure: null });
          ctx.log(`Campaign ${row.metaCampaignId} set to ${status} (1 request).`, 'info', requestId);
          return { status };
        },
      },
    ],
  };
}

export const ReadCampaignInput = z.object({ campaignId: z.number().int() });

/** One request with nested fields; the differences against the last read are kept for the UI. */
export function readCampaignJob(deps: { meta: MetaClient }): JobDefinition<z.infer<typeof ReadCampaignInput>> {
  return {
    type: 'read_campaign',
    input: ReadCampaignInput,
    steps: [
      {
        name: 'read',
        async run(ctx) {
          const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, ctx.input.campaignId)).get();
          if (!row?.metaCampaignId) throw new JobStepError('This campaign has not been created in Meta yet.');
          const state = readState(row);
          const { live, requestId } = await readLiveCampaign(deps.meta, row.metaCampaignId, { productId: row.productId, jobId: ctx.jobId });
          const diff = diffLive(state.live ?? null, live);
          saveState(ctx.db, row.id, { live, lastDiff: diff }, { lastReadAt: live.readAt, status: live.status === 'ACTIVE' ? 'active' : row.status === 'failed' ? 'failed' : 'paused' });
          for (const s of live.adSets) {
            const local = ctx.db.select().from(adSets).where(and(eq(adSets.campaignId, row.id), eq(adSets.metaId, s.id))).get();
            if (local) ctx.db.update(adSets).set({ status: s.status, name: s.name, ...(s.dailyBudgetMinor != null ? { budgetMinor: s.dailyBudgetMinor } : {}) }).where(eq(adSets.id, local.id)).run();
            for (const a of s.ads) ctx.db.update(ads).set({ status: a.status }).where(eq(ads.metaAdId, a.id)).run();
          }
          ctx.log(`Read campaign ${live.id} (1 request): ${live.adSets.length} ad sets, ${live.adSets.reduce((n, s) => n + s.ads.length, 0)} ads, ${diff.length} difference(s) since the last read.`, 'info', requestId);
          return { readAt: live.readAt, differences: diff.length };
        },
      },
    ],
  };
}

/** Apply a change list: 1 upload batch if a new image is involved, then 1 batch (PLAN.md section 9.7). */
export function applyEditsJob(deps: { meta: MetaClient }): JobDefinition<ApplyEditsInput> {
  return {
    type: 'apply_edits',
    input: ApplyEditsInput,
    steps: [
      {
        name: 'check',
        async run(ctx) {
          const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, ctx.input.campaignId)).get();
          if (!row?.metaCampaignId) throw new JobStepError('This campaign has not been created in Meta yet.');
          const state = readState(row);
          if (!state.live) throw new JobStepError('Read the campaign first.', { suggestion: 'Press "Read from Meta" (1 request), then apply.' });
          if (state.live.readAt !== ctx.input.basedOn) throw new JobStepError('The campaign was read again since you started editing.', { suggestion: 'Review the differences shown and apply again.' });
          const warnings = learningWarnings(ctx.input.changes, state.live);
          if (warnings.length && !ctx.input.acknowledgeLearning) throw new JobStepError(`These edits usually restart the learning phase: ${warnings.join(' ')}`, { suggestion: 'Tick "I understand" to apply anyway.' });
          for (const w of warnings) ctx.log(w, 'warn');
          return { warnings };
        },
      },
      {
        name: 'upload',
        async run(ctx) {
          const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, ctx.input.campaignId)).get()!;
          const state = readState(row);
          const needed = new Set(ctx.input.changes.flatMap((c) => (c.type === 'add_adset' ? c.adSet.ads.map((a) => a.creativeId) : c.type === 'add_ad' || c.type === 'replace_ad_creative' ? [c.ad.creativeId] : [])));
          if (!needed.size) return { requests: 0, hashes: {} };
          const rows = approvedCreatives(ctx.db, row.productId).filter((c) => needed.has(c.id));
          if (rows.length !== needed.size) throw new JobStepError('An ad in the change list uses a creative that is not approved for this product.');
          const r = await uploadImages(deps.meta, ctx.db, state.adAccountId, rows, (p) => fs.readFile(p), { productId: row.productId, jobId: ctx.jobId });
          ctx.log(r.uploaded ? `Uploaded ${r.uploaded} new image(s) (${r.requests} request(s)).` : 'Every image already had a Meta hash. 0 requests.');
          return { requests: r.requests, hashes: Object.fromEntries(r.hashes) };
        },
      },
      {
        name: 'apply',
        async run(ctx) {
          const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, ctx.input.campaignId)).get()!;
          const state = readState(row);
          const t = Template.parse(row.templateJson);
          const conn = ctx.settings.get('connections').meta;
          const setup = ctx.settings.get('adsetup');
          const { hashes } = ctx.prior.upload as { hashes: Record<string, string> };
          const { ops, notes } = planEditOps({ template: t, mode: state.mode, live: state.live!, changes: ctx.input.changes, adAccountId: state.adAccountId, pageId: conn.pageId, instagramUserId: conn.instagramUserId || null, pixelId: conn.pixelId || null, imageHashes: new Map(Object.entries(hashes).map(([k, v]) => [Number(k), v])), urlParams: t.ad.url_params || setup.urlParams, now: new Date(), keepTimeOfDay: setup.keepTimeOfDay });
          for (const n of notes) ctx.log(n.message, 'warn');
          const { results, requestId } = await deps.meta.batch(ops.slice(0, 50), { purpose: 'apply_edits', productId: row.productId, jobId: ctx.jobId });
          const failed = results.map((r, i) => ({ r, op: ops[i]! })).filter((x) => opError(x.r));
          ctx.db.insert(campaignEdits).values({ campaignId: row.id, changes: ctx.input.changes, stateBefore: state.live, batchResults: results.map((r) => ({ code: r.code, name: r.name, body: r.body })) }).run();
          ctx.log(`${ops.length} operation(s) in 1 batch; ${results.length - failed.length} succeeded.`, 'info', requestId);
          if (failed.length) {
            const e = opError(failed[0]!.r)!;
            throw new JobStepError(`${failed.length} edit(s) failed: ${failed.map((f) => `${f.op.name}: ${opError(f.r)!.message}`).join('; ')}`, { service: 'meta', code: e.code != null ? String(e.code) : null, subcode: e.error_subcode != null ? String(e.error_subcode) : null, requestId, suggestion: 'Read the campaign again to see what applied, then retry the rest.' });
          }
          // Mirror the simple edits locally; a read refreshes everything else.
          for (const c of ctx.input.changes) {
            if (c.type === 'campaign_status') ctx.db.update(campaigns).set({ status: c.status === 'ACTIVE' ? 'active' : 'paused' }).where(eq(campaigns.id, row.id)).run();
            if (c.type === 'adset_status') ctx.db.update(adSets).set({ status: c.status }).where(and(eq(adSets.campaignId, row.id), eq(adSets.metaId, c.adSetId))).run();
            if (c.type === 'rename_adset') ctx.db.update(adSets).set({ name: c.name }).where(and(eq(adSets.campaignId, row.id), eq(adSets.metaId, c.adSetId))).run();
            if (c.type === 'adset_budget') ctx.db.update(adSets).set({ budgetMinor: c.dailyBudgetMinor }).where(and(eq(adSets.campaignId, row.id), eq(adSets.metaId, c.adSetId))).run();
            if (c.type === 'ad_status') ctx.db.update(ads).set({ status: c.status }).where(eq(ads.metaAdId, c.adId)).run();
          }
          saveState(ctx.db, row.id, { live: null }); // force a fresh read before the next edit
          return { operations: ops.length, requests: 1 };
        },
      },
    ],
  };
}

export function findInterestsJob(deps: { meta: MetaClient }): JobDefinition<{ labels: string[]; productId: number | null }> {
  return {
    type: 'find_interests',
    input: z.object({ labels: z.array(z.string().min(1)).min(1), productId: z.number().int().nullable().default(null) }),
    steps: [{ name: 'lookup', async run(ctx) { const r = await findInterests(deps.meta, ctx.db, ctx.input.labels, { productId: ctx.input.productId, jobId: ctx.jobId }); ctx.log(`${r.requests} request(s): ${r.matched.length} matched, ${r.unmatched.length} need a pick.`); return r; } }],
  };
}

export function validateInterestsJob(deps: { meta: MetaClient }): JobDefinition<Record<string, never>> {
  return {
    type: 'validate_interests',
    input: z.object({}),
    steps: [{ name: 'validate', async run(ctx) { const r = await validateInterests(deps.meta, ctx.db, { jobId: ctx.jobId }); ctx.log(`${r.requests} request(s), ${r.checked} interest(s) checked, ${r.retired.length} retired.`); return r; } }],
  };
}

export function pullInsightsJob(deps: { meta: MetaClient }): JobDefinition<Record<string, never>> {
  return {
    type: 'pull_insights',
    input: z.object({}),
    steps: [
      {
        name: 'insights',
        async run(ctx) {
          const { adAccountId } = ctx.settings.get('connections').meta;
          if (!adAccountId) throw new JobStepError('No ad account ID under Accounts.');
          const r = await pullInsights(deps.meta, ctx.db, adAccountId, { jobId: ctx.jobId });
          ctx.log(`1 insights query at ad level: ${r.rows} row(s), ${r.updated} ad(s) updated.`);
          return r;
        },
      },
    ],
  };
}
