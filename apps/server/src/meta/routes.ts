import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { ApplyEditsInput, BoardSaveInput, ImportConfirm, InterestPick, LaunchInput, ShopifySnapshot, TemplateDuplicate, TemplateSave, type ImportOutcome, type LaunchPreview } from '@conveyor/shared';
import { applyMapping, detectFormat, fromGraphExport, getProfile, linkTemplateCopy, proposeMapping, saveProfile, shapeSignature } from './importer.ts';
import type { AppContext } from '../context.ts';
import { campaigns, products, templates } from '../db/schema.ts';
import { findInterests, pickInterest, resolveVariantInterests } from './interests.ts';
import { approvedCreatives, buildStructure, launchCounts } from './launch.ts';
import { launchBlockers, preflight } from './preflight.ts';
import { editRequestCount, learningWarnings } from './liveEdit.ts';
import { validateTargeting } from './validateTargeting.ts';
import { campaignView, listCampaigns, readState } from './repo.ts';
import { duplicateTemplate, seedTemplates, syncTemplates, templatesDir, trashTemplate, writeTemplateFile } from './templateFiles.ts';
import { exportForOtherTool, getTemplate, listTemplates, parseTemplate } from './templates.ts';

export function metaRoutes(ctx: AppContext) {
  const r = new Hono();
  const defaultId = () => ctx.settings.get('adsetup').defaultTemplateId;

  // Templates live as files in <data>/templates/. The list syncs the folder first (0 requests).
  const seedDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'templates');
  const sync = () => {
    seedTemplates(ctx.dataDir, seedDir);
    return syncTemplates(ctx.db, ctx.dataDir);
  };
  r.get('/templates', (c) => {
    const s = sync();
    return c.json({ templates: listTemplates(ctx.db, defaultId()), folder: { dir: templatesDir(ctx.dataDir), files: fs.readdirSync(templatesDir(ctx.dataDir)).filter((f) => f.endsWith('.json')).length }, sync: s });
  });
  r.get('/templates/:id', (c) => {
    const id = Number(c.req.param('id'));
    const t = getTemplate(ctx.db, id);
    if (!t) return c.json({ error: 'Not found' }, 404);
    return c.json({ view: listTemplates(ctx.db, defaultId()).find((x) => x.id === id), json: t });
  });
  const finishImport = (t: Parameters<typeof writeTemplateFile>[2], format: 'template' | 'graph' | 'profile', notes: string[]): ImportOutcome => {
    const { row } = writeTemplateFile(ctx.db, ctx.dataDir, t, null, 'import');
    if (!defaultId()) ctx.settings.set('adsetup', { ...ctx.settings.get('adsetup'), defaultTemplateId: row.id });
    const link = linkTemplateCopy(ctx.db, t);
    if (link.linked) notes.push(`Ad copy saved on the product with handle ${link.handle}.`);
    else if (link.handle) notes.push(`The copy belongs to the product "${link.handle}", which is not on the Line. Add it with one Shopify query from the Line.`);
    return { kind: 'imported', format, template: listTemplates(ctx.db, defaultId()).find((x) => x.id === row.id)!, notes };
  };

  /**
   * Import (PLAN.md section 9.2): the other tool's format is written straight to the folder; plain
   * Meta API fields are converted; anything else gets a proposed mapping from one writer run,
   * which becomes an import profile once confirmed, so later files of that shape cost nothing.
   */
  r.post('/templates', async (c) => {
    const raw = await c.req.json();
    const format = detectFormat(raw);
    if (format === 'template') return c.json(finishImport(parseTemplate(raw), 'template', []), 201);
    if (format === 'graph') {
      const { template, notes } = fromGraphExport(raw);
      return c.json(finishImport(template, 'graph', notes), 201);
    }
    const signature = shapeSignature(raw);
    const profile = getProfile(ctx.db, signature);
    if (profile?.confirmed) {
      const applied = applyMapping(raw, profile.mapping as Parameters<typeof applyMapping>[1]);
      if (applied.template) return c.json(finishImport(applied.template, 'profile', ['Mapped with a saved import profile. 0 requests.']), 201);
    }
    const preferred = ctx.settings.get('import').listing.writer === 'codex' ? 'codex' : 'claude_code';
    try {
      const dir = path.join(ctx.dataDir, 'workers', `import-${signature.slice(0, 8)}`);
      const { mapping, notes, writer } = await proposeMapping(raw, dir, preferred, ctx.writerRun ? { run: ctx.writerRun } : {});
      const applied = applyMapping(raw, mapping);
      saveProfile(ctx.db, signature, mapping, false);
      return c.json<ImportOutcome>({ kind: 'proposal', signature, mapping, preview: applied.preview, problems: [...applied.problems, ...notes], writer });
    } catch (err) {
      return c.json<ImportOutcome>({ kind: 'unsupported', message: `Could not work out this file's format: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
  /** The user confirmed (and maybe edited) a proposed mapping: saved as a profile, file written. */
  r.post('/templates/import/confirm', async (c) => {
    const { signature, mapping, raw } = ImportConfirm.parse(await c.req.json());
    const applied = applyMapping(raw, mapping);
    if (!applied.template) return c.json({ error: `The mapping does not produce a valid template: ${applied.problems.join('; ')}`, problems: applied.problems, preview: applied.preview }, 400);
    saveProfile(ctx.db, signature, mapping, true);
    return c.json(finishImport(applied.template, 'profile', ['Import profile saved; files of this shape now import with 0 requests.']), 201);
  });
  /** "Save this board as a template": a new file carrying the board under x_conveyor. */
  r.post('/templates/board', async (c) => {
    const { templateId, name, structure } = BoardSaveInput.parse(await c.req.json());
    const base = getTemplate(ctx.db, templateId);
    if (!base) return c.json({ error: 'Template not found' }, 404);
    const variants = structure.adSets.map((s, i) => ({ ...(base.adset_variants[i] ?? { country: '', age_band: '', custom_audiences: [] }), name: s.name.replace(/^.*?\s[–-]\s/, '') || s.name, country: s.countryOverride ?? '', age_band: s.ageBand ? `${s.ageBand[0]}-${s.ageBand[1]}` : '', interests: s.interests }));
    const extras = { ...(base.x_conveyor ?? {}), fillRule: 'manual' as const, variants: Object.fromEntries(structure.adSets.map((s, i) => [String(i), { ...(s.budgetMinor != null ? { budget: { ...base.adset.budget, daily_budget_minor: s.budgetMinor } } : {}) }])), board: { adSets: structure.adSets.map((s) => ({ name: s.name, creativeIds: s.ads.map((a) => a.creativeId) })) } };
    const t = parseTemplate({ ...base, id: `tmpl_${Math.random().toString(16).slice(2, 10)}`, name, version: 1, adset_count: structure.adSets.length, ads_per_adset: Math.max(1, ...structure.adSets.map((s) => s.ads.length)), adset_variants: variants, x_conveyor: extras });
    const { row } = writeTemplateFile(ctx.db, ctx.dataDir, t, null, 'board');
    return c.json(listTemplates(ctx.db, defaultId()).find((x) => x.id === row.id), 201);
  });
  /** Save from the Templates tab: validated, then written back to the same file. */
  r.put('/templates/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const row = ctx.db.select().from(templates).where(eq(templates.id, id)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    const { json: raw } = TemplateSave.parse(await c.req.json());
    const t = parseTemplate({ ...raw, id: row.templateId });
    const { row: saved } = writeTemplateFile(ctx.db, ctx.dataDir, t, row.filePath, 'tab');
    return c.json({ view: listTemplates(ctx.db, defaultId()).find((x) => x.id === saved.id), json: getTemplate(ctx.db, saved.id) });
  });
  r.post('/templates/:id/duplicate', async (c) => {
    const t = getTemplate(ctx.db, Number(c.req.param('id')));
    if (!t) return c.json({ error: 'Not found' }, 404);
    const { name } = TemplateDuplicate.parse((await c.req.json().catch(() => ({}))) as object);
    const copy = duplicateTemplate(t, name);
    const { row } = writeTemplateFile(ctx.db, ctx.dataDir, copy, null, 'tab');
    return c.json(listTemplates(ctx.db, defaultId()).find((x) => x.id === row.id), 201);
  });
  r.post('/templates/:id/default', (c) => {
    const id = Number(c.req.param('id'));
    if (!getTemplate(ctx.db, id)) return c.json({ error: 'Not found' }, 404);
    ctx.settings.set('adsetup', { ...ctx.settings.get('adsetup'), defaultTemplateId: id });
    return c.json(listTemplates(ctx.db, id));
  });
  /** "Export for my other tool" omits x_conveyor; "Backup export" keeps it. */
  r.get('/templates/:id/export', (c) => {
    const t = getTemplate(ctx.db, Number(c.req.param('id')));
    if (!t) return c.json({ error: 'Not found' }, 404);
    const backup = c.req.query('backup') === '1';
    const body = backup ? t : exportForOtherTool(t);
    c.header('content-disposition', `attachment; filename="${t.name.replace(/[^\w.-]+/g, '_')}${backup ? '.backup' : ''}.json"`);
    return c.json(body);
  });
  /** The file moves to templates/trash/; nothing is destroyed. */
  r.delete('/templates/:id', (c) => {
    const moved = trashTemplate(ctx.db, ctx.dataDir, Number(c.req.param('id')));
    return c.json({ ok: true, movedTo: moved });
  });

  // Interests
  r.post('/interests/find', async (c) => {
    const { labels, productId } = z.object({ labels: z.array(z.string().min(1)).min(1), productId: z.number().int().nullable().default(null) }).parse(await c.req.json());
    return c.json(ctx.worker.enqueue('find_interests', { labels, productId }, productId), 202);
  });
  /**
   * Resolve one ad set name (board rename): from the file or cache with 0 requests; an uncached
   * lookup label costs one batch request, right now, because the user just asked for it.
   */
  r.post('/interests/resolve', async (c) => {
    const { name, productId } = z.object({ name: z.string().min(1), productId: z.number().int().nullable().default(null) }).parse(await c.req.json());
    const variant = { name: name.replace(/^.*?\s[–-]\s(?=.*\s[–-]\s)/, ''), country: '', age_band: '', interests: [], custom_audiences: [] };
    let resolved = resolveVariantInterests(ctx.db, variant, ctx.settings.get('adsetup').readInterestsFromNames);
    let requests = 0;
    if (resolved.kind === 'lookup' && !resolved.interests.length && resolved.label) {
      requests = (await findInterests(ctx.meta, ctx.db, [resolved.label], { productId })).requests;
      resolved = resolveVariantInterests(ctx.db, variant, true);
    }
    return c.json({ ...resolved, requests });
  });
  r.post('/interests/pick', async (c) => {
    const { label, interest } = InterestPick.parse(await c.req.json());
    pickInterest(ctx.db, label, interest);
    return c.json({ ok: true });
  });

  /** Everything the Launch view shows before sending: structure, checks, operation and request counts. Local. */
  r.get('/products/:id/launch-preview', async (c) => {
    const productId = Number(c.req.param('id'));
    const templateId = Number(c.req.query('templateId') ?? defaultId() ?? 0);
    const acknowledge = (c.req.query('acknowledge') ?? '').split(',').filter(Boolean);
    const t = getTemplate(ctx.db, templateId);
    if (!t) return c.json({ error: 'Pick a template first.' }, 400);
    const row = ctx.db.select().from(products).where(eq(products.id, productId)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    const setup = ctx.settings.get('adsetup');
    const conn = ctx.settings.get('connections').meta;
    const { structure, notes, creativeRows } = buildStructure(ctx.db, { template: t, productId, fillRule: setup.fillRule, readInterestsFromNames: setup.readInterestsFromNames });
    const checks = preflight({ template: t, structure, snapshot: row.snapshot ? ShopifySnapshot.parse(row.snapshot) : null, creatives: creativeRows, pageId: conn.pageId, pixelId: conn.pixelId, adAccountId: conn.adAccountId, tokenSet: !!(await ctx.secrets.get('meta_access_token')) });
    const used = new Set(structure.adSets.flatMap((s) => s.ads.map((a) => a.creativeId)));
    const uniqueCreatives = new Set(structure.adSets.flatMap((s) => s.ads.map((a) => `${a.creativeId}|${a.primaryText}|${a.headline}`))).size;
    const newImages = approvedCreatives(ctx.db, productId).filter((cr) => used.has(cr.id) && !cr.metaImageHash).length;
    const counts = launchCounts(structure, uniqueCreatives, newImages);
    const preview: LaunchPreview = { productId, templateId, mode: t.campaign.budget.mode, structure, operations: counts.operations, imageUploads: newImages, requests: counts.requests + (row.snapshotAt && Date.now() - new Date(row.snapshotAt).getTime() < 600_000 ? 0 : 1), checks, canLaunch: launchBlockers(checks, acknowledge).length === 0, notes };
    return c.json(preview);
  });

  /** Creates everything PAUSED. A board-edited structure may be sent along. */
  r.post('/products/:id/launch', async (c) => {
    const productId = Number(c.req.param('id'));
    const body = LaunchInput.parse({ ...((await c.req.json().catch(() => ({}))) as object), productId });
    return c.json(ctx.worker.enqueue('launch', { ...body, campaignId: null }, productId), 202);
  });
  /** Preview for a board-edited structure: checks and counts without launching. */
  r.post('/products/:id/launch-preview', async (c) => {
    const productId = Number(c.req.param('id'));
    const body = LaunchInput.parse({ ...((await c.req.json().catch(() => ({}))) as object), productId });
    const t = getTemplate(ctx.db, body.templateId);
    const row = ctx.db.select().from(products).where(eq(products.id, productId)).get();
    if (!t || !row) return c.json({ error: 'Not found' }, 404);
    const conn = ctx.settings.get('connections').meta;
    const setup = ctx.settings.get('adsetup');
    const built = buildStructure(ctx.db, { template: t, productId, fillRule: setup.fillRule, readInterestsFromNames: setup.readInterestsFromNames });
    const structure = body.structure ?? built.structure;
    const checks = preflight({ template: t, structure, snapshot: row.snapshot ? ShopifySnapshot.parse(row.snapshot) : null, creatives: built.creativeRows, pageId: conn.pageId, pixelId: conn.pixelId, adAccountId: conn.adAccountId, tokenSet: !!(await ctx.secrets.get('meta_access_token')) });
    const used = new Set(structure.adSets.flatMap((s) => s.ads.map((a) => a.creativeId)));
    const uniqueCreatives = new Set(structure.adSets.flatMap((s) => s.ads.map((a) => `${a.creativeId}|${a.primaryText}|${a.headline}`))).size;
    const newImages = built.creativeRows.filter((cr) => used.has(cr.id) && !cr.metaImageHash).length;
    const counts = launchCounts(structure, uniqueCreatives, newImages);
    const preview: LaunchPreview = { productId, templateId: t ? body.templateId : 0, mode: t.campaign.budget.mode, structure, operations: counts.operations, imageUploads: newImages, requests: counts.requests, checks, canLaunch: launchBlockers(checks, body.acknowledge).length === 0, notes: built.notes };
    return c.json(preview);
  });

  /** "Check targeting with Meta": one batch of delivery_estimate reads, nothing created. */
  r.post('/products/:id/launch-validate', async (c) => {
    const productId = Number(c.req.param('id'));
    const body = LaunchInput.parse({ ...((await c.req.json().catch(() => ({}))) as object), productId });
    const t = getTemplate(ctx.db, body.templateId);
    if (!t) return c.json({ error: 'Template not found' }, 404);
    const conn = ctx.settings.get('connections').meta;
    const setup = ctx.settings.get('adsetup');
    const structure = body.structure ?? buildStructure(ctx.db, { template: t, productId, fillRule: setup.fillRule, readInterestsFromNames: setup.readInterestsFromNames }).structure;
    const out = await validateTargeting(ctx.meta, { template: t, structure, adAccountId: conn.adAccountId, pixelId: conn.pixelId || null, now: new Date(), keepTimeOfDay: setup.keepTimeOfDay, productId });
    return c.json(out);
  });

  // Live editing (PLAN.md section 9.7): one read, a change list, one batch.
  r.post('/campaigns/:id/read', (c) => {
    const id = Number(c.req.param('id'));
    const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, id)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(ctx.worker.enqueue('read_campaign', { campaignId: id }, row.productId), 202);
  });
  r.get('/campaigns/:id/live', (c) => {
    const id = Number(c.req.param('id'));
    const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, id)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    const state = readState(row);
    return c.json({ live: state.live ?? null, diff: state.lastDiff ?? [], mode: state.mode, campaign: campaignView(ctx.db, id) });
  });
  r.post('/campaigns/:id/edits', async (c) => {
    const id = Number(c.req.param('id'));
    const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, id)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    const body = ApplyEditsInput.parse({ ...((await c.req.json()) as object), campaignId: id });
    return c.json(ctx.worker.enqueue('apply_edits', body, row.productId), 202);
  });
  /** Warnings and request count for a change list, before applying. Local. */
  r.post('/campaigns/:id/edits/preview', async (c) => {
    const id = Number(c.req.param('id'));
    const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, id)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    const state = readState(row);
    if (!state.live) return c.json({ error: 'Read the campaign first.' }, 400);
    const body = ApplyEditsInput.parse({ ...((await c.req.json()) as object), campaignId: id });
    const warnings = learningWarnings(body.changes, state.live);
    const needed = new Set(body.changes.flatMap((ch) => (ch.type === 'add_adset' ? ch.adSet.ads.map((a) => a.creativeId) : ch.type === 'add_ad' || ch.type === 'replace_ad_creative' ? [ch.ad.creativeId] : [])));
    const newImages = approvedCreatives(ctx.db, row.productId).filter((cr) => needed.has(cr.id) && !cr.metaImageHash).length;
    const opCount = body.changes.reduce((n, ch) => n + (ch.type === 'add_adset' ? 1 + ch.adSet.ads.length + ch.adSet.ads.length : ch.type === 'add_ad' ? 2 : 1), 0);
    return c.json({ warnings, requests: editRequestCount(opCount, newImages), operations: opCount });
  });

  r.get('/products/:id/campaigns', (c) => c.json(listCampaigns(ctx.db, Number(c.req.param('id')))));
  r.get('/campaigns/:id', (c) => {
    const v = campaignView(ctx.db, Number(c.req.param('id')));
    return v ? c.json(v) : c.json({ error: 'Not found' }, 404);
  });
  /** Resume a failed launch: only operations without an ID are sent. */
  r.post('/campaigns/:id/resume', (c) => {
    const id = Number(c.req.param('id'));
    const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, id)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    const t = ctx.db.select().from(templates).where(eq(templates.json, row.templateJson)).get();
    const templateId = t?.id ?? ctx.db.select({ id: templates.id }).from(templates).get()?.id;
    if (!templateId) return c.json({ error: 'The template for this campaign is gone.' }, 400);
    return c.json(ctx.worker.enqueue('launch', { productId: row.productId, templateId, acknowledge: ['interest_placeholder', 'interest_unmatched', 'pixel_missing', 'product_published', 'ad_format'], campaignId: id }, row.productId), 202);
  });
  /** The one place anything is ever set ACTIVE, and only from the button. */
  r.post('/campaigns/:id/activate', (c) => {
    const id = Number(c.req.param('id'));
    const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, id)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(ctx.worker.enqueue('activate_campaign', { campaignId: id, action: 'activate' }, row.productId), 202);
  });
  r.post('/campaigns/:id/pause', (c) => {
    const id = Number(c.req.param('id'));
    const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, id)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(ctx.worker.enqueue('activate_campaign', { campaignId: id, action: 'pause' }, row.productId), 202);
  });
  /** "Preview placements": one batch of generatepreviews, on request. */
  r.post('/campaigns/:id/previews', async (c) => {
    const id = Number(c.req.param('id'));
    const row = ctx.db.select().from(campaigns).where(eq(campaigns.id, id)).get();
    if (!row) return c.json({ error: 'Not found' }, 404);
    const state = readState(row);
    const creativeIds = Object.entries(state.savedIds).filter(([k]) => k.startsWith('cr')).map(([, v]) => v);
    if (!creativeIds.length) return c.json({ error: 'No creatives in Meta yet.' }, 400);
    const format = z.enum(['MOBILE_FEED_STANDARD', 'INSTAGRAM_STANDARD', 'INSTAGRAM_REELS', 'FACEBOOK_REELS_MOBILE', 'INSTAGRAM_STORY']).catch('MOBILE_FEED_STANDARD').parse(c.req.query('format'));
    const { results } = await ctx.meta.batch(creativeIds.slice(0, 50).map((cid) => ({ method: 'GET' as const, relative_url: `${cid}/previews?ad_format=${format}` })), { purpose: 'previews', productId: row.productId });
    return c.json(results.map((res, i) => ({ creativeId: creativeIds[i], html: (res.body as { data?: { body?: string }[] } | null)?.data?.[0]?.body ?? null, code: res.code })));
  });
  r.post('/insights/refresh', (c) => c.json(ctx.worker.enqueue('pull_insights', {}, null), 202));

  return r;
}
