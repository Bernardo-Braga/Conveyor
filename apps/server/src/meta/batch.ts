/** One operation in a Graph batch request (PLAN.md section 9.6). */
export interface BatchOp {
  method: 'GET' | 'POST' | 'DELETE';
  relative_url: string;
  /** Sent URL-encoded; nested values are JSON-encoded, as the Graph API expects. */
  body?: Record<string, unknown>;
  /** Lets later operations reference this one as `{result=name:$.id}`. */
  name?: string;
  attached_files?: string;
}

export interface BatchResult {
  code: number;
  body: unknown;
  name: string | undefined;
}

export const BATCH_LIMIT = 50;
const REF = /\{result=([A-Za-z0-9_-]+):\$\.[^}]+\}/g;

export function encodeBody(body: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    p.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return p.toString();
}

/** Names this operation depends on, from `{result=name:$.…}` references anywhere in it. */
export function refsOf(op: BatchOp): string[] {
  const text = `${op.relative_url} ${op.body ? JSON.stringify(op.body) : ''}`;
  return [...new Set([...text.matchAll(REF)].map((m) => m[1]!))];
}

/**
 * Splits operations into batches of at most `limit`, in dependency order, never splitting an
 * operation from a reference it needs unless that reference was already resolved in an
 * earlier batch (its ID is then substituted before sending).
 */
export function splitByDependencies(ops: BatchOp[], limit = BATCH_LIMIT): BatchOp[][] {
  const batches: BatchOp[][] = [];
  let current: BatchOp[] = [];
  const done = new Set<string>();
  for (const op of ops) {
    const needs = refsOf(op).filter((r) => !done.has(r));
    const inCurrent = new Set(current.map((o) => o.name).filter(Boolean) as string[]);
    const unmet = needs.filter((r) => !inCurrent.has(r));
    if (unmet.length) throw new Error(`Operation ${op.name ?? op.relative_url} references ${unmet.join(', ')} before it exists`);
    if (current.length >= limit) {
      for (const o of current) if (o.name) done.add(o.name);
      batches.push(current);
      current = [];
    }
    current.push(op);
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Replaces references to operations from earlier batches with their saved IDs. */
export function withSavedIds(ops: BatchOp[], ids: Record<string, string>): BatchOp[] {
  const swap = (s: string) => s.replace(REF, (m, name: string) => ids[name] ?? m);
  return ops.map((op) => ({
    ...op,
    relative_url: swap(op.relative_url),
    ...(op.body ? { body: JSON.parse(swap(JSON.stringify(op.body))) as Record<string, unknown> } : {}),
  }));
}

/** Parses the array the Graph API returns for a batch. `null` entries mean a timed-out operation. */
export function parseBatchResults(raw: unknown, ops: BatchOp[]): BatchResult[] {
  if (!Array.isArray(raw)) throw new Error('Batch response was not an array');
  return raw.map((r, i) => {
    const name = ops[i]?.name;
    if (r == null) return { code: 0, body: null, name };
    const item = r as { code?: number; body?: string };
    let body: unknown;
    try {
      body = item.body ? JSON.parse(item.body) : null;
    } catch {
      body = item.body ?? null;
    }
    return { code: item.code ?? 0, body, name };
  });
}
