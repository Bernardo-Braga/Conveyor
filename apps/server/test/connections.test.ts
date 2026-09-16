import { describe, expect, it } from 'vitest';
import { connectionStatuses, runConnectionTest } from '../src/connections/index.ts';
import { requests } from '../src/db/schema.ts';
import { fakeFetch, fixture, json, testContext } from './helpers.ts';

const SECRET = { claude: 'sk-ant-api03-ClaudeSecretValue', openai: 'sk-proj-OpenAISecretValue', shopifyId: 'shopifyClientIdValue', shopifySecret: 'shpss_ShopifySecretValue1234', meta: 'EAAMetaSecretTokenValue1234567890' };

async function setup(routes: Parameters<typeof fakeFetch>[0]) {
  const ff = fakeFetch(routes);
  const ctx = testContext(ff.impl);
  await ctx.secrets.set('claude_api_key', SECRET.claude);
  await ctx.secrets.set('openai_api_key', SECRET.openai);
  await ctx.secrets.set('shopify_client_id', SECRET.shopifyId);
  await ctx.secrets.set('shopify_client_secret', SECRET.shopifySecret);
  await ctx.secrets.set('meta_access_token', SECRET.meta);
  ctx.settings.set('connections', { shopify: { storeDomain: 'ashworth-studio.myshopify.com' }, meta: { adAccountId: 'act_1234567890' } });
  const deps = { ...ctx, shopifyTokens: ctx.shopifyTokens, jobId: null };
  const ledger = () => ctx.db.select().from(requests).all();
  const assertNoSecretsInLedger = () => {
    const s = JSON.stringify(ledger());
    for (const v of Object.values(SECRET)) expect(s).not.toContain(v);
  };
  return { ctx, deps, calls: ff.calls, ledger, assertNoSecretsInLedger };
}

describe('connection tests', () => {
  it('Claude: one read-only call, key in a header, success names the model', async () => {
    const t = await setup({ 'api.anthropic.com/v1/models/claude-sonnet-5': () => json(fixture('claude/model.json'), 200, { 'request-id': 'req_claude_1' }) });
    const r = await runConnectionTest('claude', t.deps);
    expect(r).toMatchObject({ service: 'claude', ok: true, requests: 1, requestId: 'req_claude_1' });
    expect(r.detail).toContain('claude-sonnet-5');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.headers['x-api-key']).toBe(SECRET.claude);
    expect(t.calls[0]!.url).not.toContain(SECRET.claude);
    t.assertNoSecretsInLedger();
    await t.ctx.close();
  });

  it('Claude: a 401 is reported with the service message and request ID', async () => {
    const t = await setup({ 'api.anthropic.com': () => json(fixture('claude/error-401.json'), 401, { 'request-id': 'req_claude_bad' }) });
    const r = await runConnectionTest('claude', t.deps);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('authentication_error');
    expect(r.detail).toContain('req_claude_bad');
    expect(r.detail).toContain('Check the key');
    await t.ctx.close();
  });

  it('OpenAI: one read-only call for the pinned image model', async () => {
    const t = await setup({ 'api.openai.com/v1/models/gpt-image-2': () => json(fixture('openai/model.json'), 200, { 'x-request-id': 'req_oai' }) });
    const r = await runConnectionTest('openai', t.deps);
    expect(r).toMatchObject({ ok: true, requests: 1, requestId: 'req_oai' });
    expect(t.calls[0]!.headers.authorization).toBe(`Bearer ${SECRET.openai}`);
    t.assertNoSecretsInLedger();
    await t.ctx.close();
  });

  it('Shopify: token exchange plus one query the first time, then only the query', async () => {
    const t = await setup({
      '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')),
      '/admin/api/2026-07/graphql.json': () => json(fixture('shopify/shop.json'), 200, { 'x-request-id': 'shop-req-1' }),
    });
    const first = await runConnectionTest('shopify', t.deps);
    expect(first).toMatchObject({ ok: true, requests: 2, requestId: 'shop-req-1' });
    expect(first.detail).toContain('Ashworth Studio');
    expect(t.calls[0]!.body).toContain('grant_type=client_credentials');
    expect(t.calls[1]!.headers['x-shopify-access-token']).toBe('shpat_0123456789abcdef0123456789abcdef');

    const second = await runConnectionTest('shopify', t.deps);
    expect(second.requests).toBe(1);
    expect(t.calls).toHaveLength(3);
    expect(t.ledger().map((r) => r.purpose)).toEqual(['access_token', 'connection_test', 'connection_test']);
    t.assertNoSecretsInLedger();
    expect(JSON.stringify(t.ledger())).not.toContain('shpat_');
    await t.ctx.close();
  });

  it('Shopify: without a store domain it makes no request', async () => {
    const t = await setup({});
    t.ctx.settings.set('connections', { shopify: { storeDomain: '' } });
    const r = await runConnectionTest('shopify', t.deps);
    expect(r).toMatchObject({ ok: false, requests: 0 });
    expect(t.calls).toHaveLength(0);
    await t.ctx.close();
  });

  it('Meta: one call to the ad account with the token in the header, not the URL', async () => {
    const t = await setup({ 'graph.facebook.com/v26.0/act_1234567890': () => json(fixture('meta/adaccount.json'), 200, { 'x-fb-trace-id': 'fbtrace1' }) });
    const r = await runConnectionTest('meta', t.deps);
    expect(r).toMatchObject({ ok: true, requests: 1, requestId: 'fbtrace1' });
    expect(r.detail).toContain('Ashworth Ads');
    expect(t.calls[0]!.url).not.toContain('access_token');
    expect(t.calls[0]!.headers.authorization).toBe(`Bearer ${SECRET.meta}`);
    t.assertNoSecretsInLedger();
    await t.ctx.close();
  });

  it('Meta: quotes code, subcode, message and trace, and explains known codes', async () => {
    const t = await setup({ 'graph.facebook.com': () => json(fixture('meta/error-190.json'), 400) });
    const r = await runConnectionTest('meta', t.deps);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('code 190 / subcode 463');
    expect(r.detail).toContain('AbCdEf123Trace');
    expect(r.detail).toContain('new system user token');
    expect(r.requestId).toBe('AbCdEf123Trace');
    await t.ctx.close();
  });

  it('a missing key is reported without any request', async () => {
    const t = await setup({});
    await t.ctx.secrets.delete('claude_api_key');
    const r = await runConnectionTest('claude', t.deps);
    expect(r).toMatchObject({ ok: false, requests: 0 });
    expect(r.detail).toContain('Claude API key');
    expect(t.calls).toHaveLength(0);
    await t.ctx.close();
  });

  it('statuses list what is missing and the last result', async () => {
    const t = await setup({ 'api.openai.com': () => json(fixture('openai/model.json')) });
    await t.ctx.secrets.delete('meta_access_token');
    await runConnectionTest('openai', t.deps);
    const statuses = await connectionStatuses(t.ctx);
    expect(statuses.find((s) => s.service === 'meta')).toMatchObject({ configured: false, missing: ['Meta access token'], last: null });
    expect(statuses.find((s) => s.service === 'openai')).toMatchObject({ configured: true, missing: [], last: { ok: true, requests: 1 } });
    expect(statuses.find((s) => s.service === 'rapidapi')).toMatchObject({ configured: false, missing: ['RapidAPI key'] });
    expect(statuses.find((s) => s.service === 'codex')).toMatchObject({ configured: true, missing: [] });
    await t.ctx.close();
  });

  it('runs as a job through the worker and streams its result', async () => {
    const t = await setup({ 'api.anthropic.com': () => json(fixture('claude/model.json')) });
    const job = t.ctx.worker.enqueue('connection_test', { service: 'claude' });
    await t.ctx.worker.drain();
    const v = t.ctx.worker.view(job.id);
    expect(v.status).toBe('done');
    expect(v.progress).toMatchObject({ result: { service: 'claude', ok: true, requests: 1 } });
    expect(t.ledger()).toHaveLength(1);
    expect(t.ledger()[0]!.jobId).toBe(job.id);
    await t.ctx.close();
  });
});
