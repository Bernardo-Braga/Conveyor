import { desc, eq, inArray } from 'drizzle-orm';
import { CampaignView, type BudgetMode, type InterestRef, type LaunchStructure, type LiveCampaign, type LiveDiff } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { adSets, ads, campaigns } from '../db/schema.ts';

/** What the campaign row keeps beside the template copy, so a retry resumes and nothing is created twice. */
export interface LaunchState {
  name: string;
  mode: BudgetMode;
  structure: LaunchStructure;
  savedIds: Record<string, string>;
  operations: number;
  error: string | null;
  adAccountId: string;
  /** The last state read from Meta, and what differed from the read before it. */
  live?: LiveCampaign | null;
  lastDiff?: LiveDiff[];
}

export function readState(row: typeof campaigns.$inferSelect): LaunchState {
  return row.lastState as LaunchState;
}

export function saveState(db: Db, id: number, patch: Partial<LaunchState>, extra: Partial<typeof campaigns.$inferInsert> = {}): LaunchState {
  const row = db.select().from(campaigns).where(eq(campaigns.id, id)).get()!;
  const next = { ...readState(row), ...patch };
  db.update(campaigns).set({ lastState: next, ...extra }).where(eq(campaigns.id, id)).run();
  return next;
}

export function campaignView(db: Db, id: number): CampaignView | null {
  const row = db.select().from(campaigns).where(eq(campaigns.id, id)).get();
  if (!row) return null;
  const state = readState(row);
  const sets = db.select().from(adSets).where(eq(adSets.campaignId, id)).all();
  const adRows = sets.length ? db.select().from(ads).where(inArray(ads.adSetId, sets.map((s) => s.id))).all() : [];
  const completed = Object.keys(state.savedIds ?? {}).length;
  return CampaignView.parse({
    id: row.id,
    productId: row.productId,
    name: state.name,
    mode: state.mode,
    status: row.status,
    metaCampaignId: row.metaCampaignId,
    adSets: sets.map((s) => ({
      id: s.id,
      name: s.name,
      budgetMinor: s.budgetMinor,
      interests: (s.interests as InterestRef[] | null) ?? [],
      metaId: s.metaId,
      status: s.status,
      ads: adRows.filter((a) => a.adSetId === s.id).map((a) => ({ id: a.id, name: ((a.insights as { name?: string } | null)?.name ?? '') || `ad ${a.id}`, creativeId: a.creativeId, metaAdId: a.metaAdId, metaCreativeId: a.metaCreativeId, status: a.status, insights: (a.insights as Record<string, unknown> | null) ?? null })),
    })),
    operations: state.operations,
    completed,
    lastError: state.error,
    lastReadAt: row.lastReadAt,
    createdAt: row.createdAt,
  });
}

export function listCampaigns(db: Db, productId: number): CampaignView[] {
  return db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.productId, productId)).orderBy(desc(campaigns.id)).all().map((r) => campaignView(db, r.id)!);
}
