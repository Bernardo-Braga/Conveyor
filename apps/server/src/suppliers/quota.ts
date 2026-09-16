import { eq } from 'drizzle-orm';
import type { Platform, QuotaView } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { supplierQuota } from '../db/schema.ts';

const REMAINING = 'x-ratelimit-requests-remaining';
const RESET = 'x-ratelimit-requests-reset';

/** Reads quota for free from RapidAPI response headers and applies the pause threshold. */
export class QuotaStore {
  constructor(private readonly db: Db) {}

  get(platform: Platform): { remaining: number | null; resetAt: string | null; updatedAt: string | null } {
    const row = this.db.select().from(supplierQuota).where(eq(supplierQuota.platform, platform)).get();
    return row ? { remaining: row.remaining, resetAt: row.resetAt, updatedAt: row.updatedAt } : { remaining: null, resetAt: null, updatedAt: null };
  }

  /** Only these two headers are read. Nothing else from the response is looked at here. */
  updateFromHeaders(platform: Platform, headers: Headers, now = new Date()): void {
    const rem = Number.parseInt(headers.get(REMAINING) ?? '', 10);
    if (!Number.isFinite(rem)) return;
    const resetSec = Number.parseInt(headers.get(RESET) ?? '', 10);
    const resetAt = Number.isFinite(resetSec) ? new Date(now.getTime() + resetSec * 1000).toISOString() : null;
    const updatedAt = now.toISOString();
    this.db
      .insert(supplierQuota)
      .values({ platform, remaining: rem, resetAt, updatedAt })
      .onConflictDoUpdate({ target: supplierQuota.platform, set: { remaining: rem, resetAt, updatedAt } })
      .run();
  }

  /** Stop when the last known remaining count is below the threshold and the window has not reset. */
  guard(platform: Platform, threshold: number, now = new Date()): { ok: true } | { ok: false; reason: string } {
    const q = this.get(platform);
    if (q.remaining == null) return { ok: true };
    if (q.resetAt && new Date(q.resetAt).getTime() <= now.getTime()) return { ok: true };
    if (q.remaining < threshold) {
      const when = q.resetAt ? ` It resets ${new Date(q.resetAt).toLocaleString('en-GB')}.` : '';
      return { ok: false, reason: `RapidAPI quota for ${platform} is ${q.remaining}, below the pause threshold of ${threshold}.${when} Raise the threshold under Settings, Import, or wait.` };
    }
    return { ok: true };
  }

  view(platform: Platform, threshold: number): QuotaView {
    const q = this.get(platform);
    return { platform, ...q, threshold, paused: !this.guard(platform, threshold).ok };
  }
}
