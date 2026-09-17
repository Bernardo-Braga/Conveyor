import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { templates } from '../src/db/schema.ts';
import { duplicateTemplate, seedTemplates, syncTemplates, templatesDir, trashTemplate, writeTemplateFile } from '../src/meta/templateFiles.ts';
import { parseTemplate } from '../src/meta/templates.ts';
import { FIXTURES, fixture, testContext } from './helpers.ts';

describe('templates folder', () => {
  it('seeds from the bundled files once, syncs adds/updates/missing, and skips junk', () => {
    const ctx = testContext();
    const dir = templatesDir(ctx.dataDir);
    expect(seedTemplates(ctx.dataDir, path.join(FIXTURES, 'templates'))).toEqual(['ashworth-cbo.json', 'whitcombe-abo.json']);
    expect(seedTemplates(ctx.dataDir, path.join(FIXTURES, 'templates'))).toEqual([]); // not twice
    const first = syncTemplates(ctx.db, ctx.dataDir);
    expect(first.added).toEqual(['ashworth-cbo.json', 'whitcombe-abo.json']);
    expect(syncTemplates(ctx.db, ctx.dataDir)).toEqual({ added: [], updated: [], missing: [], skipped: [] });

    // Edit a file on disk: the folder wins.
    const wPath = path.join(dir, 'whitcombe-abo.json');
    const w = JSON.parse(fs.readFileSync(wPath, 'utf8')) as { version: number; adset: { budget: { daily_budget_minor: number } } };
    w.version = 13;
    w.adset.budget.daily_budget_minor = 2500;
    fs.writeFileSync(wPath, JSON.stringify(w));
    fs.utimesSync(wPath, new Date(), new Date(Date.now() + 5000));
    expect(syncTemplates(ctx.db, ctx.dataDir).updated).toEqual(['whitcombe-abo.json']);
    const row = ctx.db.select().from(templates).all().find((r) => r.templateId === 'tmpl_e938d972')!;
    expect(row.version).toBe(13);
    expect((row.json as { adset: { budget: { daily_budget_minor: number } } }).adset.budget.daily_budget_minor).toBe(2500);

    // Junk and foreign files are skipped, not imported.
    fs.writeFileSync(path.join(dir, 'notes.json'), '{"hello":1}');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{');
    const s = syncTemplates(ctx.db, ctx.dataDir);
    expect(s.skipped.map((x) => x.file).sort()).toEqual(['broken.json', 'notes.json']);

    // A removed file marks the row, which stays usable.
    fs.unlinkSync(wPath);
    expect(syncTemplates(ctx.db, ctx.dataDir).missing).toEqual(['whitcombe-abo.json']);
    expect(ctx.db.select().from(templates).all().find((r) => r.templateId === 'tmpl_e938d972')!.fileMissing).toBe(true);
    void ctx.close();
  });

  it('writing saves the file without tokens, duplicating makes a new id and file, trash moves the file', () => {
    const ctx = testContext();
    const t = parseTemplate({ ...(fixture('templates/ashworth-cbo.json') as Record<string, unknown>), access_token: 'EAAdrop' });
    const { path: p1, row } = writeTemplateFile(ctx.db, ctx.dataDir, t, null);
    expect(path.basename(p1)).toBe('Ashworth_CBO_1.6.json');
    expect(fs.readFileSync(p1, 'utf8')).not.toContain('EAAdrop');
    expect(JSON.parse(fs.readFileSync(p1, 'utf8')).adset_variants).toHaveLength(3);
    const again = writeTemplateFile(ctx.db, ctx.dataDir, { ...t, version: 11 }, row.filePath);
    expect(again.path).toBe(p1);
    expect(again.row.id).toBe(row.id);
    expect(again.row.version).toBe(11);

    const copy = duplicateTemplate(t, 'Ashworth variant');
    expect(copy.id).not.toBe(t.id);
    expect(copy.version).toBe(1);
    const dup = writeTemplateFile(ctx.db, ctx.dataDir, copy, null);
    expect(path.basename(dup.path)).toBe('Ashworth_variant.json');
    expect(ctx.db.select().from(templates).all()).toHaveLength(2);

    const moved = trashTemplate(ctx.db, ctx.dataDir, dup.row.id);
    expect(moved).toContain('/trash/');
    expect(fs.existsSync(moved!)).toBe(true);
    expect(fs.existsSync(dup.path)).toBe(false);
    expect(ctx.db.select().from(templates).all()).toHaveLength(1);
    void ctx.close();
  });

  it('routes: list syncs the folder, save writes back to the same file keeping the id, duplicate and delete work', async () => {
    const ctx = testContext();
    const app = createApp(ctx);
    const list = (await (await app.request('/api/templates')).json()) as { templates: { id: number; name: string; fileName: string; mode: string }[]; folder: { dir: string; files: number }; sync: { added: string[] } };
    expect(list.templates.map((t) => t.fileName).sort()).toEqual(['ashworth-cbo.json', 'whitcombe-abo.json']);
    expect(list.folder.files).toBe(2);
    expect(list.sync.added).toHaveLength(2);
    const ash = list.templates.find((t) => t.mode === 'CBO')!;

    const one = (await (await app.request(`/api/templates/${ash.id}`)).json()) as { view: { fileName: string }; json: Record<string, unknown> };
    expect(one.json.id).toBe('tmpl_ee75ef60');
    const edited = { ...one.json, id: 'tampered', name: 'Ashworth edited', campaign: { ...(one.json.campaign as Record<string, unknown>), budget: { ...((one.json.campaign as { budget: Record<string, unknown> }).budget), daily_budget_minor: 12000 } } };
    const saved = (await (await app.request(`/api/templates/${ash.id}`, { method: 'PUT', body: JSON.stringify({ json: edited }), headers: { 'content-type': 'application/json' } })).json()) as { view: { name: string; campaignBudgetMinor: number; fileName: string }; json: { id: string } };
    expect(saved.view).toMatchObject({ name: 'Ashworth edited', campaignBudgetMinor: 12000, fileName: 'ashworth-cbo.json' });
    expect(saved.json.id).toBe('tmpl_ee75ef60'); // the id cannot be changed from the tab
    const onDisk = JSON.parse(fs.readFileSync(path.join(templatesDir(ctx.dataDir), 'ashworth-cbo.json'), 'utf8')) as { name: string; campaign: { budget: { daily_budget_minor: number } } };
    expect(onDisk.campaign.budget.daily_budget_minor).toBe(12000);

    const bad = await app.request(`/api/templates/${ash.id}`, { method: 'PUT', body: JSON.stringify({ json: { ...one.json, adset_variants: 'nope' } }), headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);

    const dup = (await (await app.request(`/api/templates/${ash.id}/duplicate`, { method: 'POST', body: JSON.stringify({ name: 'Ashworth test' }), headers: { 'content-type': 'application/json' } })).json()) as { id: number; fileName: string; name: string };
    expect(dup.fileName).toBe('Ashworth_test.json');
    const del = (await (await app.request(`/api/templates/${dup.id}`, { method: 'DELETE' })).json()) as { movedTo: string };
    expect(del.movedTo).toContain('trash');
    expect(((await (await app.request('/api/templates')).json()) as { templates: unknown[] }).templates).toHaveLength(2);
    await ctx.close();
  });
});
