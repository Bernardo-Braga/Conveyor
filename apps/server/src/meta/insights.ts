import { eq } from 'drizzle-orm';
import { INSIGHTS_DATE_PRESET, INSIGHT_FIELDS, PURCHASE_ACTION_TYPES } from '../../../../config/insights.ts';
import type { Db } from '../db/index.ts';
import { ads } from '../db/schema.ts';
import type { MetaClient } from './client.ts';

interface InsightRow {
  ad_id: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  actions?: { action_type: string; value: string }[];
  purchase_roas?: { action_type: string; value: string }[];
  date_start?: string;
  date_stop?: string;
}

export interface AdInsights {
  spendMinor: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpcMinor: number | null;
  purchases: number;
  purchaseRoas: number | null;
  from: string | null;
  to: string | null;
  fetchedAt: string;
}

export function summarise(r: InsightRow, fetchedAt: string): AdInsights {
  const purchases = (r.actions ?? []).filter((a) => (PURCHASE_ACTION_TYPES as readonly string[]).includes(a.action_type)).reduce((n, a) => Math.max(n, Number(a.value) || 0), 0);
  const roas = (r.purchase_roas ?? [])[0]?.value;
  return {
    spendMinor: Math.round(Number(r.spend ?? 0) * 100),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    ctr: r.ctr != null ? Number(r.ctr) : null,
    cpcMinor: r.cpc != null ? Math.round(Number(r.cpc) * 100) : null,
    purchases,
    purchaseRoas: roas != null ? Number(roas) : null,
    from: r.date_start ?? null,
    to: r.date_stop ?? null,
    fetchedAt,
  };
}

/** One account-level insights query at ad level; results land on each ad row. */
export async function pullInsights(client: MetaClient, db: Db, adAccountId: string, meta: { jobId: number | null }): Promise<{ requests: number; updated: number; rows: number }> {
  const { data } = await client.get<{ data?: InsightRow[] }>(`${adAccountId}/insights`, { level: 'ad', fields: INSIGHT_FIELDS.join(','), date_preset: INSIGHTS_DATE_PRESET, limit: 500 }, { purpose: 'insights', ...meta });
  const fetchedAt = new Date().toISOString();
  const known = new Map(db.select({ id: ads.id, metaAdId: ads.metaAdId }).from(ads).all().filter((a) => a.metaAdId).map((a) => [a.metaAdId!, a.id]));
  let updated = 0;
  for (const r of data.data ?? []) {
    const id = known.get(r.ad_id);
    if (!id) continue;
    db.update(ads).set({ insights: summarise(r, fetchedAt) }).where(eq(ads.id, id)).run();
    updated += 1;
  }
  return { requests: 1, updated, rows: data.data?.length ?? 0 };
}
