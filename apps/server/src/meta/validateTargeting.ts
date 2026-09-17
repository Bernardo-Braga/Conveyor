import type { LaunchStructure, Template } from '@conveyor/shared';
import type { BatchOp } from './batch.ts';
import { opError, type MetaClient } from './client.ts';
import { adSetFields, type PayloadNote } from './payloadRules.ts';

export interface TargetingCheck {
  adSet: string;
  ok: boolean;
  message: string | null;
  code: number | null;
  subcode: number | null;
  estimate: { users_lower?: number; users_upper?: number } | null;
}

/**
 * Server-side targeting validation with nothing created (the other tool's section 5):
 * `GET act_<id>/delivery_estimate` runs the same checks as ad set creation (unknown ids, bad
 * countries, malformed spec, age bounds). Every unique targeting goes in one batch, so this
 * is one request for the whole structure.
 */
export async function validateTargeting(client: MetaClient, args: { template: Template; structure: LaunchStructure; adAccountId: string; pixelId: string | null; now: Date; keepTimeOfDay: boolean; productId: number | null }): Promise<{ requests: number; checks: TargetingCheck[] }> {
  const notes: PayloadNote[] = [];
  const unique = new Map<string, { names: string[]; targeting: unknown }>();
  for (const set of args.structure.adSets) {
    const fields = adSetFields({ template: args.template, set, campaignRef: 'x', pixelId: args.pixelId, now: args.now, keepTimeOfDay: args.keepTimeOfDay, notes });
    const key = JSON.stringify(fields.targeting);
    const entry = unique.get(key) ?? { names: [], targeting: fields.targeting };
    entry.names.push(set.name);
    unique.set(key, entry);
  }
  const entries = [...unique.values()];
  if (!entries.length) return { requests: 0, checks: [] };
  const goal = args.template.adset.optimization_goal;
  const ops: BatchOp[] = entries.slice(0, 50).map((e, i) => ({ method: 'GET', relative_url: `${args.adAccountId}/delivery_estimate?optimization_goal=${encodeURIComponent(goal)}&targeting_spec=${encodeURIComponent(JSON.stringify(e.targeting))}`, name: `t${i}` }));
  const { results } = await client.batch(ops, { purpose: 'delivery_estimate', productId: args.productId });
  const checks: TargetingCheck[] = [];
  entries.forEach((e, i) => {
    const r = results[i]!;
    const err = opError(r);
    const data = (r.body as { data?: { estimate_dau?: number; estimate_mau_lower_bound?: number; estimate_mau_upper_bound?: number }[] } | null)?.data?.[0];
    for (const name of e.names) {
      checks.push({
        adSet: name,
        ok: !err,
        message: err ? [err.message, err.error_user_msg].filter(Boolean).join(' — ') : null,
        code: err?.code ?? null,
        subcode: err?.error_subcode ?? null,
        estimate: data ? { ...(data.estimate_mau_lower_bound != null ? { users_lower: data.estimate_mau_lower_bound } : {}), ...(data.estimate_mau_upper_bound != null ? { users_upper: data.estimate_mau_upper_bound } : {}) } : null,
      });
    }
  });
  return { requests: 1, checks };
}
