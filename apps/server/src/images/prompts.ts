import { and, desc, eq } from 'drizzle-orm';
import { BUILTIN_PROMPT_VARIABLES, DEFAULT_PROMPT_BODY, PROMPT_9x16_RULE, PROMPT_FIXED_RULES, PromptTemplateInput, PromptTemplateView, ReferenceRule, type Aspect, type ListingDraft, type ShopifySnapshot } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { promptTemplates } from '../db/schema.ts';

const VAR = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Every `{{name}}` in a body, built-in or custom, in order of first appearance. */
export function promptVariables(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(VAR)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

export function customVariables(body: string): string[] {
  return promptVariables(body).filter((v) => !(BUILTIN_PROMPT_VARIABLES as readonly string[]).includes(v));
}

/** Built-in values come from the Shopify snapshot (the source of truth) and the saved listing. */
export function builtinValues(snapshot: ShopifySnapshot, draft: ListingDraft | null, brand: string, aspect: Aspect): Record<string, string> {
  const price = snapshot.variants.length ? Math.min(...snapshot.variants.map((v) => v.priceMinor)) : null;
  const highlights = draft?.highlights ?? [];
  return {
    title: snapshot.title,
    highlight_1: highlights[0] ?? '',
    highlight_2: highlights[1] ?? '',
    highlight_3: highlights[2] ?? '',
    price: price == null ? '' : `${(price / 100).toFixed(2)} ${snapshot.currency}`,
    brand,
    product_type: snapshot.productType || draft?.productType || '',
    aspect,
  };
}

/** Fills a body, appends the fixed rules, and reports variables that had no value. */
export function fillPrompt(body: string, values: Record<string, string>, aspect: Aspect): { prompt: string; missing: string[] } {
  const missing: string[] = [];
  const filled = body.replace(VAR, (_, name: string) => {
    const v = values[name];
    if (v === undefined || v === '') {
      missing.push(name);
      return '';
    }
    return v;
  });
  const parts = [filled.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), PROMPT_FIXED_RULES];
  if (aspect === '9:16') parts.push(PROMPT_9x16_RULE);
  return { prompt: parts.join('\n\n'), missing: [...new Set(missing)] };
}

type Row = typeof promptTemplates.$inferSelect;

export function toTemplateView(r: Row): PromptTemplateView {
  return PromptTemplateView.parse({
    id: r.id,
    name: r.name,
    version: r.version,
    body: r.body,
    variables: promptVariables(r.body),
    formats: r.formats,
    countPerFormat: r.countPerFormat,
    referenceRule: ReferenceRule.catch('first_3_shopify_images').parse(r.referenceRule),
    isDefault: r.isDefault,
    createdAt: r.createdAt,
  });
}

/** The latest version of each named template. */
export function listTemplates(db: Db): PromptTemplateView[] {
  const rows = db.select().from(promptTemplates).orderBy(desc(promptTemplates.version), desc(promptTemplates.id)).all();
  const latest = new Map<string, Row>();
  for (const r of rows) if (!latest.has(r.name)) latest.set(r.name, r);
  return [...latest.values()].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)).map(toTemplateView);
}

export function getTemplate(db: Db, id: number): Row | null {
  return db.select().from(promptTemplates).where(eq(promptTemplates.id, id)).get() ?? null;
}

export function defaultTemplate(db: Db): Row {
  ensureDefaultTemplate(db);
  const row = db.select().from(promptTemplates).where(eq(promptTemplates.isDefault, true)).orderBy(desc(promptTemplates.version)).get();
  if (!row) throw new Error('No default prompt template');
  return row;
}

/** Saving a template always writes a new version; older versions stay for the batches that used them. */
export function saveTemplate(db: Db, input: PromptTemplateInput, previousId: number | null = null): PromptTemplateView {
  const parsed = PromptTemplateInput.parse(input);
  const prev = previousId ? getTemplate(db, previousId) : null;
  const version = prev ? prev.version + 1 : (db.select({ v: promptTemplates.version }).from(promptTemplates).where(eq(promptTemplates.name, parsed.name)).orderBy(desc(promptTemplates.version)).get()?.v ?? 0) + 1;
  const isDefault = parsed.isDefault || (prev?.isDefault ?? false);
  if (isDefault) db.update(promptTemplates).set({ isDefault: false }).run();
  const row = db
    .insert(promptTemplates)
    .values({ name: prev?.name ?? parsed.name, version, body: parsed.body, variables: promptVariables(parsed.body), formats: parsed.formats, countPerFormat: parsed.countPerFormat, referenceRule: parsed.referenceRule, isDefault })
    .returning()
    .get();
  return toTemplateView(row);
}

export function setDefaultTemplate(db: Db, id: number): PromptTemplateView {
  const row = getTemplate(db, id);
  if (!row) throw new Error('Template not found');
  db.update(promptTemplates).set({ isDefault: false }).run();
  db.update(promptTemplates).set({ isDefault: true }).where(and(eq(promptTemplates.name, row.name), eq(promptTemplates.version, row.version))).run();
  return toTemplateView(getTemplate(db, id)!);
}

export function ensureDefaultTemplate(db: Db): void {
  const any = db.select({ id: promptTemplates.id }).from(promptTemplates).limit(1).get();
  if (any) return;
  db.insert(promptTemplates).values({ name: 'Clean product shot', version: 1, body: DEFAULT_PROMPT_BODY, variables: promptVariables(DEFAULT_PROMPT_BODY), formats: ['1:1', '4:5', '9:16'], countPerFormat: 4, referenceRule: 'first_3_shopify_images', isDefault: true }).run();
}
