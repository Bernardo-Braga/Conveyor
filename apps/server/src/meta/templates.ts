import { desc, eq } from 'drizzle-orm';
import { Template, TemplateView, type Variant } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { templates } from '../db/schema.ts';
import { dropTokenKeys } from '../http/redact.ts';

/** Parses the other tool's JSON. Access tokens anywhere in the file are dropped first. */
export function parseTemplate(raw: unknown): Template {
  return Template.parse(dropTokenKeys(raw));
}

/** Is this the other tool's format? (PLAN.md section 9.2, detection step 1.) */
export function looksLikeTemplate(raw: unknown): boolean {
  const o = raw as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && Array.isArray(o.adset_variants) && 'ads_per_adset' in o && typeof (o.campaign as { budget?: { mode?: unknown } } | undefined)?.budget?.mode === 'string';
}

type Row = typeof templates.$inferSelect;

export function toTemplateView(r: Row, defaultId: number | null): TemplateView {
  const t = Template.parse(r.json);
  return TemplateView.parse({
    id: r.id,
    templateId: r.templateId,
    name: t.name,
    version: t.version,
    mode: t.campaign.budget.mode,
    adSetCount: t.adset_count,
    adsPerAdSet: t.ads_per_adset,
    variantNames: t.adset_variants.map((v) => v.name),
    source: r.source,
    isDefault: r.id === defaultId,
    fileName: r.filePath ? r.filePath.split('/').pop()! : null,
    filePath: r.filePath,
    fileMissing: r.fileMissing,
    campaignBudgetMinor: t.campaign.budget.mode === 'CBO' ? (t.campaign.budget.daily_budget_minor ?? t.campaign.budget.lifetime_budget_minor) : null,
    adSetBudgetMinor: t.campaign.budget.mode === 'ABO' ? (t.adset.budget.daily_budget_minor ?? t.adset.budget.lifetime_budget_minor) : null,
    objective: t.campaign.objective,
    updatedAt: r.updatedAt,
  });
}

/** Re-importing the same `id` updates the stored template (CLAUDE.md hard rule 8). */
export function storeTemplate(db: Db, t: Template, source: string): Row {
  const now = new Date().toISOString();
  const existing = db.select().from(templates).where(eq(templates.templateId, t.id)).get();
  if (existing) {
    return db.update(templates).set({ name: t.name, version: t.version, source, json: t, updatedAt: now }).where(eq(templates.id, existing.id)).returning().get()!;
  }
  return db.insert(templates).values({ templateId: t.id, name: t.name, version: t.version, source, json: t }).returning().get();
}

export function listTemplates(db: Db, defaultId: number | null): TemplateView[] {
  return db.select().from(templates).orderBy(desc(templates.updatedAt)).all().map((r) => toTemplateView(r, defaultId));
}

export function getTemplate(db: Db, id: number): Template | null {
  const r = db.select().from(templates).where(eq(templates.id, id)).get();
  return r ? Template.parse(r.json) : null;
}

/** Everything the other tool keeps, minus `x_conveyor`. Must round-trip every original field. */
export function exportForOtherTool(t: Template): Record<string, unknown> {
  const { x_conveyor: _x, ...rest } = t as Template & { x_conveyor?: unknown };
  return rest;
}

/** Name patterns, PLAN.md section 9.1. */
export function fillPattern(pattern: string, vars: { date?: string; template?: string; campaign?: string; variation?: string; creative_filename?: string }): string {
  return pattern.replace(/\{\{\s*(date|template|campaign|variation|creative_filename)\s*\}\}/g, (_, k: string) => vars[k as keyof typeof vars] ?? '').replace(/\s+/g, ' ').trim();
}

export function todayTag(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Variant `age_band` is `min-max` (for example `25-44`); anything else is flagged. */
export function parseAgeBand(band: string): { ok: true; range: [number, number] | null } | { ok: false; reason: string } {
  const s = band.trim();
  if (!s) return { ok: true, range: null };
  const m = s.match(/^(\d{2})\s*[-–]\s*(\d{2})$/);
  if (!m) return { ok: false, reason: `age_band "${band}" is not min-max` };
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (min < 13 || max > 65 || min > max) return { ok: false, reason: `age_band "${band}" is out of range` };
  return { ok: true, range: [min, max] };
}

export function variantAt(t: Template, i: number): Variant | null {
  return t.adset_variants[i] ?? null;
}
