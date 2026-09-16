import type { ParsedLink } from '@conveyor/shared';
import type { LedgerClient } from '../http/ledgerClient.ts';

/** RapidAPI DataHub hosts, one per platform. One key covers both. */
export const HOSTS = {
  aliexpress: 'aliexpress-datahub.p.rapidapi.com',
  '1688': '1688-datahub.p.rapidapi.com',
} as const;

const SHORT_HOSTS = /^(a|s\.click|star)\.aliexpress\.[a-z.]+$/;

/**
 * Platform and item ID from a link, worked out locally (PLAN.md section 6).
 * Returns null for anything Conveyor does not understand, so nothing is fetched.
 */
export function parseLink(raw: string): ParsedLink | null {
  const u = toUrl(raw);
  if (!u) return null;
  if (/(^|\.)aliexpress\.[a-z.]+$/.test(u.hostname)) {
    const id = u.pathname.match(/\/(?:item|i)\/(?:[^/]+\/)?(\d{6,})(?:\.html)?/)?.[1] ?? u.searchParams.get('productId') ?? u.searchParams.get('productIds');
    return id ? { platform: 'aliexpress', itemId: id } : null;
  }
  if (/(^|\.)1688\.com$/.test(u.hostname)) {
    const id = u.pathname.match(/\/offer\/(\d{6,})(?:\.html)?/)?.[1] ?? u.searchParams.get('offerId');
    return id ? { platform: '1688', itemId: id } : null;
  }
  return null;
}

/** `a.aliexpress.com/_abc` and similar need one redirect request, which does not touch RapidAPI. */
export function isShortLink(raw: string): boolean {
  const u = toUrl(raw);
  return !!u && SHORT_HOSTS.test(u.hostname) && parseLink(raw) === null;
}

export function looksLikeUrl(raw: string): boolean {
  return /^(https?:\/\/|www\.|[a-z0-9-]+\.(aliexpress|1688)\.)/i.test(raw.trim()) || /\b(aliexpress\.[a-z]+|1688\.com)\//i.test(raw);
}

export async function resolveShortLink(ledger: LedgerClient, raw: string, jobId: number | null = null): Promise<string | null> {
  const u = toUrl(raw);
  if (!u) return null;
  const res = await ledger.fetch({ service: 'other', purpose: 'short_link', jobId }, u, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' } }, { timeoutMs: 15_000 });
  await res.body?.cancel().catch(() => undefined);
  return res.url || null;
}

function toUrl(raw: string): URL | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/\//, '')}`;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}
