import { describe, expect, it } from 'vitest';
import { requests, supplierRaw } from '../src/db/schema.ts';
import { dataHubStatus } from '../src/suppliers/rapidapi.ts';
import { fakeFetch, json, testContext } from './helpers.ts';

const OK_BODY = { result: { status: { code: 200, data: 'success' }, item: { itemId: '1005006123456789', title: 'Mug' } } };
/** The real 205 body, from a saved raw response on 23 September 2026. */
const NO_RESULTS = { result: { status: { data: 'error', code: 205, msg: { 'data-error': 'request successfully formed, but no results were found' }, endpoint: 'item_detail' } } };
const KEY = 'rapidapiSecretKey123456';

async function setup(routes: Parameters<typeof fakeFetch>[0]) {
  const ff = fakeFetch(routes);
  const ctx = testContext(ff.impl);
  await ctx.secrets.set('rapidapi_key', KEY);
  return { ctx, calls: ff.calls, raws: () => ctx.db.select().from(supplierRaw).all(), ledger: () => ctx.db.select().from(requests).all() };
}

describe('RapidApiClient.fetchItem', () => {
  it('makes one request with the key in headers, saves the raw body, and reads quota from headers', async () => {
    const t = await setup({ 'aliexpress-datahub.p.rapidapi.com/item_detail': () => json(OK_BODY, 200, { 'x-ratelimit-requests-remaining': '987', 'x-ratelimit-requests-reset': '86400' }) });
    const res = await t.ctx.rapidapi.fetchItem('aliexpress', '1005006123456789', { productId: 1, jobId: 2 });
    expect(res.httpStatus).toBe(200);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.headers['x-rapidapi-key']).toBe(KEY);
    expect(t.calls[0]!.headers['x-rapidapi-host']).toBe('aliexpress-datahub.p.rapidapi.com');
    expect(t.calls[0]!.url).toBe('https://aliexpress-datahub.p.rapidapi.com/item_detail?itemId=1005006123456789');
    expect(t.raws()).toHaveLength(1);
    expect(JSON.parse(t.raws()[0]!.body)).toEqual(OK_BODY);
    expect(t.ctx.quota.get('aliexpress')).toMatchObject({ remaining: 987 });
    expect(t.ctx.quota.get('1688').remaining).toBeNull();
    expect(t.ledger()[0]).toMatchObject({ service: 'rapidapi', purpose: 'item_detail', productId: 1, jobId: 2, quotaRemaining: 987 });
    expect(JSON.stringify(t.ledger())).not.toContain(KEY);
    await t.ctx.close();
  });

  it('retries once on 5xx, never on 4xx, and a 200 with a DataHub error code is final', async () => {
    let n = 0;
    const t = await setup({ '1688-datahub': () => (n++ === 0 ? json({}, 502) : json(OK_BODY)) });
    await t.ctx.rapidapi.fetchItem('1688', '712345678901');
    expect(n).toBe(2);
    expect(t.raws()).toHaveLength(1); // only the final answer is saved as the raw response

    let m = 0;
    const t2 = await setup({ 'rapidapi.com': () => (m++, json({ message: 'You are not subscribed to this API.' }, 403)) });
    await expect(t2.ctx.rapidapi.fetchItem('aliexpress', '1')).rejects.toMatchObject({ details: { service: 'rapidapi', code: '403', retryable: false } });
    expect(m).toBe(1);
    expect(t2.raws()).toHaveLength(1); // saved before anything else

    let k = 0;
    const t3 = await setup({ 'rapidapi.com': () => (k++, json({ result: { status: { code: 404, data: 'error', msg: 'item not found' } } })) });
    await expect(t3.ctx.rapidapi.fetchItem('aliexpress', '2')).rejects.toMatchObject({ details: { code: '404', retryable: false } });
    expect(k).toBe(1);
    await Promise.all([t.ctx.close(), t2.ctx.close(), t3.ctx.close()]);
  });

  it('dataHubStatus reads the wrapper', () => {
    expect(dataHubStatus(OK_BODY)).toEqual({ ok: true, code: 200, message: null });
    expect(dataHubStatus({ result: { status: { code: 500, data: 'error', msg: 'upstream' } } })).toMatchObject({ ok: false, code: 500, message: 'upstream' });
    expect(dataHubStatus({})).toMatchObject({ ok: false });
    expect(dataHubStatus({ result: { item: {} } })).toMatchObject({ ok: true });
  });
});

/**
 * AliExpress DataHub answers HTTP 200 with `status.code` 205 for an item it cannot read
 * ("request successfully formed, but no results were found"). The item_detail_6 endpoint
 * answers the same item, so a 205 is the one body-level code worth a second request.
 */
describe('the 205 fallback to the backup endpoint', () => {
  it('asks item_detail_6, keeps both raw bodies, and returns the one that answered', async () => {
    const t = await setup({
      item_detail_6: () => json(OK_BODY, 200, { 'x-ratelimit-requests-remaining': '900' }),
      item_detail: () => json(NO_RESULTS, 200, { 'x-ratelimit-requests-remaining': '901' }),
    });
    const res = await t.ctx.rapidapi.fetchItem('aliexpress', '3256807730330502', { productId: 1, jobId: 2 });
    expect(res.endpoint).toBe('item_detail_6');
    expect(res.requests).toBe(2);
    expect(res.body).toEqual(OK_BODY);
    expect(t.calls.map((c) => c.url)).toEqual([
      'https://aliexpress-datahub.p.rapidapi.com/item_detail?itemId=3256807730330502',
      'https://aliexpress-datahub.p.rapidapi.com/item_detail_6?itemId=3256807730330502',
    ]);
    // Every endpoint's body is saved before parsing; the result points at the one that worked.
    expect(t.raws()).toHaveLength(2);
    expect(JSON.parse(t.raws().find((r) => r.id === res.rawId)!.body)).toEqual(OK_BODY);
    expect(t.ledger().map((r) => r.purpose)).toEqual(['item_detail', 'item_detail_6']);
    expect(t.ctx.quota.get('aliexpress')).toMatchObject({ remaining: 900 });
    await t.ctx.close();
  });

  it('costs nothing extra for any other failure: the backup would repeat it', async () => {
    const t = await setup({ item_detail_6: () => json(OK_BODY), item_detail: () => json({ result: { status: { code: 404, data: 'error', msg: 'item not found' } } }) });
    await expect(t.ctx.rapidapi.fetchItem('aliexpress', '2')).rejects.toMatchObject({ details: { code: '404', retryable: false } });
    expect(t.calls).toHaveLength(1);

    const t2 = await setup({ item_detail_6: () => json(OK_BODY), item_detail: () => json({ message: 'You are not subscribed to this API.' }, 403) });
    await expect(t2.ctx.rapidapi.fetchItem('aliexpress', '3')).rejects.toMatchObject({ details: { code: '403' } });
    expect(t2.calls).toHaveLength(1);
    await Promise.all([t.ctx.close(), t2.ctx.close()]);
  });

  it('1688 has no confirmed backup, so its 205 fails at once', async () => {
    const t = await setup({ '1688-datahub': () => json(NO_RESULTS) });
    await expect(t.ctx.rapidapi.fetchItem('1688', '712345678901')).rejects.toMatchObject({ details: { code: '205', retryable: false } });
    expect(t.calls).toHaveLength(1);
    await t.ctx.close();
  });

  it('names both endpoints when the backup finds nothing either', async () => {
    const t = await setup({ item_detail_6: () => json(NO_RESULTS), item_detail: () => json(NO_RESULTS) });
    await expect(t.ctx.rapidapi.fetchItem('aliexpress', '4')).rejects.toMatchObject({
      message: expect.stringContaining('item_detail, item_detail_6'),
      details: { code: '205', retryable: false },
    });
    expect(t.calls).toHaveLength(2);
    await t.ctx.close();
  });
});

describe('QuotaStore.guard', () => {
  it('allows unknown quota, stops below the threshold, and allows again after the reset', async () => {
    const t = await setup({});
    const q = t.ctx.quota;
    expect(q.guard('aliexpress', 50)).toEqual({ ok: true });
    q.updateFromHeaders('aliexpress', new Headers({ 'x-ratelimit-requests-remaining': '10', 'x-ratelimit-requests-reset': '3600' }));
    expect(q.guard('aliexpress', 50).ok).toBe(false);
    expect(q.guard('aliexpress', 5).ok).toBe(true);
    expect(q.guard('aliexpress', 50, new Date(Date.now() + 2 * 3600 * 1000)).ok).toBe(true);
    expect(q.view('aliexpress', 50)).toMatchObject({ platform: 'aliexpress', remaining: 10, threshold: 50, paused: true });
    await t.ctx.close();
  });
});
