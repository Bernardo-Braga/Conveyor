import { describe, expect, it } from 'vitest';
import { LedgerClient } from '../src/http/ledgerClient.ts';
import { requests } from '../src/db/schema.ts';
import { EventBus } from '../src/events/bus.ts';
import { openDb } from '../src/db/index.ts';
import { fakeFetch, json } from './helpers.ts';

function setup(routes: Parameters<typeof fakeFetch>[0]) {
  const { db } = openDb(':memory:');
  const bus = new EventBus();
  const ff = fakeFetch(routes);
  const ledger = new LedgerClient({ db, bus, fetchImpl: ff.impl, sleep: async () => undefined, secretsForRedaction: async () => ['supersecretkey'] });
  return { db, bus, ledger, calls: ff.calls, rows: () => db.select().from(requests).all() };
}

describe('LedgerClient', () => {
  it('records service, purpose, product, job, status, duration and quota, never headers or bodies', async () => {
    const t = setup({
      'rapidapi.com': () => json({ result: {} }, 200, { 'x-ratelimit-requests-remaining': '412', 'x-ratelimit-requests-reset': '3600', 'x-request-id': 'rid-1' }),
    });
    const res = await t.ledger.fetch(
      { service: 'rapidapi', purpose: 'item_detail', productId: 7, jobId: 3 },
      'https://aliexpress-datahub.p.rapidapi.com/item_detail?itemId=100500&key=supersecretkey',
      { headers: { 'x-rapidapi-key': 'supersecretkey' } },
    );
    expect(res.status).toBe(200);
    const rows = t.rows();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r).toMatchObject({ service: 'rapidapi', purpose: 'item_detail', productId: 7, jobId: 3, method: 'GET', status: 200, ok: true, quotaRemaining: 412, requestId: 'rid-1' });
    expect(r.url).toBe('https://aliexpress-datahub.p.rapidapi.com/item_detail');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.quotaResetAt).toMatch(/^\d{4}-/);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('supersecretkey');
    expect(serialized).not.toContain('x-rapidapi-key');
    expect(Object.keys(r)).not.toContain('headers');
    expect(Object.keys(r)).not.toContain('body');
  });

  it('does not retry by default, and returns 4xx responses as final', async () => {
    let n = 0;
    const t = setup({ 'example.com': () => (n++, json({ error: 'nope' }, 404)) });
    const res = await t.ledger.fetch({ service: 'other', purpose: 't' }, 'https://example.com/x');
    expect(res.status).toBe(404);
    expect(n).toBe(1);
    expect(t.rows()[0]).toMatchObject({ ok: false, status: 404, error: 'HTTP 404' });
  });

  it('retries once for 5xx and 429 when asked, recording every attempt', async () => {
    let n = 0;
    const t = setup({ 'example.com': () => (n++ === 0 ? json({}, 503) : json({ ok: 1 })) });
    const res = await t.ledger.fetch({ service: 'other', purpose: 't' }, 'https://example.com/x', {}, { retries: 1 });
    expect(res.status).toBe(200);
    expect(n).toBe(2);
    expect(t.rows().map((r) => r.status)).toEqual([503, 200]);

    let m = 0;
    const t2 = setup({ 'example.com': () => (m++, json({}, 400)) });
    await t2.ledger.fetch({ service: 'other', purpose: 't' }, 'https://example.com/x', {}, { retries: 1 });
    expect(m).toBe(1);
  });

  it('records network failures with redacted text and throws after the last attempt', async () => {
    const t = setup({});
    await expect(t.ledger.fetch({ service: 'meta', purpose: 'batch' }, 'https://graph.facebook.com/v26.0/act_1/ads?access_token=supersecretkey', {}, { retries: 1 })).rejects.toThrow(/meta batch/);
    const rows = t.rows();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.ok).toBe(false);
      expect(r.status).toBeNull();
      expect(r.error).toContain('fetch failed');
      expect(r.error).not.toContain('supersecretkey');
      expect(r.url).toBe('https://graph.facebook.com/v26.0/act_1/ads');
    }
  });

  it('emits a ledger event per request', async () => {
    const t = setup({ 'example.com': () => json({}) });
    const seen: unknown[] = [];
    t.bus.subscribe((e) => seen.push(e));
    await t.ledger.fetch({ service: 'claude', purpose: 'listing' }, 'https://example.com/v1/messages', { method: 'POST' });
    expect(seen).toEqual([{ kind: 'ledger', service: 'claude', purpose: 'listing', ok: true, status: 200 }]);
    expect(t.rows()[0]!.method).toBe('POST');
  });
});
