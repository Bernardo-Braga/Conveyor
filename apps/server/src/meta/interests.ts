import { inArray } from 'drizzle-orm';
import type { InterestKind, InterestRef, Variant } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { interestCache } from '../db/schema.ts';
import type { MetaClient } from './client.ts';
import type { BatchOp } from './batch.ts';

const BROAD = /^broad(\s*\d+)?$/i;
const PLACEHOLDER = /^interest(\s*\d+)?$/i;

/** One interest per ad set name. */
export function interestFromName(name: string): { kind: 'none' } | { kind: 'broad' } | { kind: 'placeholder'; label: string } | { kind: 'lookup'; label: string } {
  const [prefix, ...rest] = name.split(/\s[-–]\s/);
  void prefix;
  const label = rest.join(' - ').trim();
  if (!rest.length) return { kind: 'none' };
  if (!label || BROAD.test(label)) return { kind: 'broad' };
  if (PLACEHOLDER.test(label)) return { kind: 'placeholder', label };
  return { kind: 'lookup', label };
}

/** The part before the dash; a country code that differs from the template's countries is flagged. */
export function prefixOfName(name: string): string | null {
  const [prefix, ...rest] = name.split(/\s[-–]\s/);
  return rest.length ? (prefix ?? '').trim() : null;
}

export const norm = (label: string) => label.trim().toLowerCase().replace(/\s+/g, ' ');

export interface Resolved {
  kind: InterestKind;
  label: string | null;
  interests: InterestRef[];
  suggestions: InterestRef[];
}

/**
 * What an ad set will target, from the file first, then the name, then the cache.
 * Never makes a request: `findInterests` fills the cache beforehand.
 */
export function resolveVariantInterests(db: Db, variant: Variant, readFromNames = true): Resolved {
  if (variant.interests.length) return { kind: 'file', label: null, interests: variant.interests, suggestions: [] };
  if (!readFromNames) return { kind: 'none', label: null, interests: [], suggestions: [] };
  const fromName = interestFromName(variant.name);
  if (fromName.kind === 'none' || fromName.kind === 'broad') return { kind: fromName.kind, label: null, interests: [], suggestions: [] };
  if (fromName.kind === 'placeholder') return { kind: 'placeholder', label: fromName.label, interests: [], suggestions: [] };
  const cached = db.select().from(interestCache).where(inArray(interestCache.label, [norm(fromName.label)])).get();
  if (cached?.userPick) return { kind: 'picked', label: fromName.label, interests: [cached.userPick as InterestRef], suggestions: [] };
  if (cached?.metaId && cached.metaName) return { kind: 'lookup', label: fromName.label, interests: [{ id: cached.metaId, name: cached.metaName }], suggestions: [] };
  if (cached) return { kind: 'unmatched', label: fromName.label, interests: [], suggestions: (cached.suggestions as InterestRef[] | null) ?? [] };
  return { kind: 'lookup', label: fromName.label, interests: [], suggestions: [] };
}

export function uncachedLabels(db: Db, labels: string[]): string[] {
  const wanted = [...new Set(labels.map(norm))].filter(Boolean);
  if (!wanted.length) return [];
  const have = new Set(db.select({ label: interestCache.label }).from(interestCache).where(inArray(interestCache.label, wanted)).all().map((r) => r.label));
  return wanted.filter((l) => !have.has(l));
}

interface SearchHit {
  id: string;
  name: string;
  audience_size_lower_bound?: number;
  path?: string[];
}

/**
 * Every uncached label goes out in ONE Graph batch of `search?type=adinterest` (0 or 1 request).
 * Only an exact, case-insensitive name match is accepted; otherwise the suggestions are cached
 * for the user to pick from.
 */
export async function findInterests(client: MetaClient, db: Db, labels: string[], meta: { productId?: number | null; jobId?: number | null }): Promise<{ requests: number; matched: string[]; unmatched: string[] }> {
  const misses = uncachedLabels(db, labels);
  if (!misses.length) return { requests: 0, matched: [], unmatched: [] };
  const ops: BatchOp[] = misses.map((l) => ({ method: 'GET', relative_url: `search?type=adinterest&q=${encodeURIComponent(l)}&limit=5`, name: `i${misses.indexOf(l)}` }));
  const { results } = await client.batch(ops, { purpose: 'interest_search', ...meta });
  const matched: string[] = [];
  const unmatched: string[] = [];
  const now = new Date().toISOString();
  misses.forEach((label, i) => {
    const body = results[i]?.body as { data?: SearchHit[] } | null;
    const hits = (body?.data ?? []).map((h) => ({ id: String(h.id), name: h.name }));
    const exact = hits.find((h) => norm(h.name) === label);
    db.insert(interestCache)
      .values({ label, metaId: exact?.id ?? null, metaName: exact?.name ?? null, suggestions: exact ? null : hits, lastCheckedAt: now })
      .onConflictDoUpdate({ target: interestCache.label, set: { metaId: exact?.id ?? null, metaName: exact?.name ?? null, suggestions: exact ? null : hits, lastCheckedAt: now } })
      .run();
    (exact ? matched : unmatched).push(label);
  });
  return { requests: 1, matched, unmatched };
}

/** The user's pick for a label is cached and reused for every later template with that name. */
export function pickInterest(db: Db, label: string, interest: InterestRef): void {
  const l = norm(label);
  db.insert(interestCache)
    .values({ label: l, userPick: interest, lastCheckedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: interestCache.label, set: { userPick: interest } })
    .run();
}

/** Daily validation: cached IDs older than a day are re-checked in one batch (`GET /{id}`). */
export async function validateInterests(client: MetaClient, db: Db, meta: { jobId?: number | null }, now = new Date()): Promise<{ requests: number; checked: number; retired: string[] }> {
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const rows = db.select().from(interestCache).all().filter((r) => (r.metaId || r.userPick) && (!r.lastCheckedAt || r.lastCheckedAt < dayAgo));
  if (!rows.length) return { requests: 0, checked: 0, retired: [] };
  const ids = rows.map((r) => r.metaId ?? (r.userPick as InterestRef).id);
  const ops: BatchOp[] = ids.slice(0, 50).map((id) => ({ method: 'GET', relative_url: `search?type=adinterestvalid&interest_list=${encodeURIComponent(JSON.stringify([id]))}` }));
  const { results } = await client.batch(ops, { purpose: 'interest_validate', ...meta });
  const retired: string[] = [];
  rows.slice(0, 50).forEach((r, i) => {
    const body = results[i]?.body as { data?: { valid?: boolean; name?: string }[] } | null;
    const valid = body?.data?.[0]?.valid !== false;
    if (!valid) retired.push(r.label);
    db.update(interestCache).set({ lastCheckedAt: now.toISOString(), ...(valid ? {} : { metaId: null, metaName: null, userPick: null, suggestions: [] }) }).where(inArray(interestCache.label, [r.label])).run();
  });
  return { requests: 1, checked: Math.min(rows.length, 50), retired };
}
