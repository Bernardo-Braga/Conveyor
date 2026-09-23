import { and, eq } from 'drizzle-orm';
import { LaunchOverrides, Template, overriddenFields } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { creatives, productLaunch } from '../db/schema.ts';
import { applyOverrides } from './overrides.ts';
import { getTemplate } from './templates.ts';

type CreativeRow = typeof creatives.$inferSelect;

export interface LaunchPlan {
  /** The `templates` row this plan was taken from. */
  templateId: number;
  /** The template as it will be launched: the stored copy when there is one, otherwise the file's. */
  template: Template;
  /** This launch's own campaign name, schedule, targeting and budget; laid over the template at launch. */
  overrides: LaunchOverrides;
  /** Creative IDs in the order they fill the ads. */
  creativeIds: number[];
  /** True when the product has its own edited copy, so the Launch view can offer "revert". */
  edited: boolean;
  updatedAt: string | null;
}

/** Every finished creative of a product, newest batch last: what the Launch view offers to choose from. */
export function finishedCreatives(db: Db, productId: number): CreativeRow[] {
  return db
    .select()
    .from(creatives)
    .where(and(eq(creatives.productId, productId), eq(creatives.status, 'finished')))
    .all()
    .sort((a, b) => a.id - b.id);
}

/** The default choice for a product with no plan yet: every approved creative, oldest first. */
export function defaultCreativeIds(db: Db, productId: number): number[] {
  return finishedCreatives(db, productId).filter((c) => c.approval === 'approved').map((c) => c.id);
}

function planRow(db: Db, productId: number) {
  return db.select().from(productLaunch).where(eq(productLaunch.productId, productId)).get();
}

/**
 * The plan a launch uses. A stored template copy and a stored choice of creatives only apply to
 * the template they were taken from, so picking a different template in the Launch view starts
 * from that template's own settings. The launch settings are the product's, not the template's,
 * and follow it whichever template it is launched with.
 */
export function getPlan(db: Db, productId: number, templateId: number): LaunchPlan | null {
  const row = planRow(db, productId);
  const forThisTemplate = row?.templateId === templateId ? row : null;
  const copy = forThisTemplate?.template ? Template.safeParse(forThisTemplate.template) : null;
  const template = copy?.success ? copy.data : getTemplate(db, templateId);
  if (!template) return null;
  const stored = (forThisTemplate?.creativeIds as number[] | null) ?? null;
  return {
    templateId,
    template,
    overrides: LaunchOverrides.parse(row?.overrides ?? {}),
    creativeIds: stored ?? defaultCreativeIds(db, productId),
    edited: !!copy?.success,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** The template a product launches with: its own copy or the file's, with its launch settings applied. */
export function templateForProduct(db: Db, productId: number, templateId: number): Template | null {
  const plan = getPlan(db, productId, templateId);
  return plan ? applyOverrides(plan.template, plan.overrides) : null;
}

/** The creatives a product launches with, in the plan's order. `null` means "every approved one". */
export function planCreativeIds(db: Db, productId: number, templateId: number): number[] | null {
  const row = planRow(db, productId);
  return row && row.templateId === templateId ? ((row.creativeIds as number[] | null) ?? null) : null;
}

/**
 * Add creatives to the product's saved launch plan, keeping the order already chosen and
 * appending the new ones. A saved plan is an explicit list, so a creative made afterwards is not
 * in it and would never launch; importing a Shopify photo is the user choosing it, so it joins
 * the list here. Returns the new list, or null when there is no saved list — then the default is
 * every approved creative, which already includes it.
 */
export function addToPlan(db: Db, productId: number, ids: number[]): number[] | null {
  const row = planRow(db, productId);
  const current = (row?.creativeIds as number[] | null) ?? null;
  if (!row || !current) return null;
  const next = [...current, ...ids.filter((id) => !current.includes(id))];
  if (next.length !== current.length) db.update(productLaunch).set({ creativeIds: next, updatedAt: new Date().toISOString() }).where(eq(productLaunch.productId, productId)).run();
  return next;
}

export interface PlanPatch {
  /** The product's own copy of the template; `null` drops the copy and follows the template file. */
  template?: Template | null;
  /** The chosen creatives; `null` means every approved one. */
  creativeIds?: number[] | null;
  overrides?: LaunchOverrides;
}

/** Saves one part of the plan. Anything left out of the patch keeps the value it already had. */
export function savePlan(db: Db, productId: number, templateId: number, patch: PlanPatch): void {
  const row = planRow(db, productId);
  // A different template means a different copy and a different choice of creatives; the launch
  // settings are the product's own and stay.
  const sameTemplate = row?.templateId === templateId;
  const values = {
    productId,
    templateId,
    template: (patch.template !== undefined ? patch.template : sameTemplate ? (row?.template as Template | null) : null) ?? null,
    creativeIds: (patch.creativeIds !== undefined ? patch.creativeIds : sameTemplate ? (row?.creativeIds as number[] | null) : null) ?? null,
    overrides: patch.overrides ?? LaunchOverrides.parse(row?.overrides ?? {}),
    updatedAt: new Date().toISOString(),
  };
  db.insert(productLaunch).values(values).onConflictDoUpdate({ target: productLaunch.productId, set: values }).run();
}

/**
 * "Start again from the template": the product's copy of the template is dropped, not the
 * template file, and not the launch settings or the chosen creatives, which are the product's
 * own. A row with nothing left in it goes.
 */
export function clearPlan(db: Db, productId: number): void {
  const row = planRow(db, productId);
  if (!row) return;
  const keeps = row.creativeIds != null || overriddenFields(LaunchOverrides.parse(row.overrides ?? {})).length > 0;
  if (keeps) db.update(productLaunch).set({ template: null, updatedAt: new Date().toISOString() }).where(eq(productLaunch.productId, productId)).run();
  else db.delete(productLaunch).where(eq(productLaunch.productId, productId)).run();
}
