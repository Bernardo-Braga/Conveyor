import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { InterestPick, LaunchInput, ShopifySnapshot, TemplateDuplicate, TemplateSave, type LaunchPreview } from '@conveyor/shared';
import type { AppContext } from '../context.ts';
import { campaigns, products, templates } from '../db/schema.ts';
import { pickInterest } from './interests.ts';
import { approvedCreatives, buildStructure, launchCounts } from './launch.ts';
import { launchBlockers, preflight } from './preflight.ts';
import { campaignView, listCampaigns, readState } from './repo.ts';
import { duplicateTemplate, seedTemplates, syncTemplates, templatesDir, trashTemplate, writeTemplateFile } from './templateFiles.ts';
import { exportForOtherTool, getTemplate, listTemplates, looksLikeTemplate, parseTemplate } from './templates.ts';

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
  /** Import a file's contents: it is written into the folder and indexed. 0 requests. */
  r.post('/templates', async (c) => {
    const raw = await c.req.json();
    if (!looksLikeTemplate(raw)) return c.json({ error: 'This is not a template from the other tool (no adset_variants, ads_per_adset and campaign.budget.mode). Other formats arrive in phase 7.' }, 400);
    const t = parseTemplate(raw);
    const { row } = writeTemplateFile(ctx.db, ctx.dataDir, t, null, 'import');
    if (!defaultId()) ctx.settings.set('adsetup', { ...ctx.settings.get('adsetup'), defaultTemplateId: row.id });
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

  /** Creates everything PAUSED. */
  r.post('/products/:id/launch', async (c) => {
    const productId = Number(c.req.param('id'));
    const body = LaunchInput.parse({ ...((await c.req.json().catch(() => ({}))) as object), productId });
    return c.json(ctx.worker.enqueue('launch', { ...body, campaignId: null }, productId), 202);
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
