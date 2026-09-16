import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { EventBus } from '../src/events/bus.ts';
import { sseHandler } from '../src/events/sse.ts';
import { Hono } from 'hono';
import { fakeFetch, fixture, json, testContext } from './helpers.ts';

describe('HTTP API', () => {
  it('health, versions and validation errors', async () => {
    const ctx = testContext();
    const app = createApp(ctx);
    const health = await (await app.request('/api/health')).json();
    expect(health).toMatchObject({ ok: true, env: 'test', versions: { metaApi: 'v26.0', shopifyAdminApi: '2026-07', codexCli: '0.154.0' } });
    const bad = await app.request('/api/settings/nope');
    expect(bad.status).toBe(400);
    const put = await app.request('/api/settings/connections', { method: 'PUT', body: JSON.stringify({ meta: { adAccountId: 'not-an-id' } }), headers: { 'content-type': 'application/json' } });
    expect(put.status).toBe(400);
    expect(await put.json()).toMatchObject({ error: 'Invalid input' });
    expect((await app.request('/api/missing')).status).toBe(404);
    await ctx.close();
  });

  it('secrets: the browser never receives a key', async () => {
    const ctx = testContext();
    const app = createApp(ctx);
    const put = await app.request('/api/secrets/meta_access_token', { method: 'PUT', body: JSON.stringify({ value: 'EAABrowserMustNotSeeThis000' }), headers: { 'content-type': 'application/json' } });
    expect(put.status).toBe(200);
    const list = await (await app.request('/api/secrets')).text();
    expect(list).not.toContain('BrowserMustNotSee');
    expect(JSON.parse(list).find((s: { name: string }) => s.name === 'meta_access_token')).toMatchObject({ set: true, hint: 's000' });
    expect((await app.request('/api/secrets/bogus', { method: 'PUT', body: '{"value":"x"}', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    const del = await app.request('/api/secrets/meta_access_token', { method: 'DELETE' });
    expect(del.status).toBe(200);
    await ctx.close();
  });

  it('connection test endpoint enqueues a job and the ledger endpoint shows the request without secrets', async () => {
    const ff = fakeFetch({ 'api.openai.com': () => json(fixture('openai/model.json')) });
    const ctx = testContext(ff.impl);
    await ctx.secrets.set('openai_api_key', 'sk-proj-EndpointSecret123456');
    const app = createApp(ctx);
    const res = await app.request('/api/connections/openai/test', { method: 'POST' });
    expect(res.status).toBe(202);
    const job = (await res.json()) as { id: number; status: string };
    expect(job.status).toBe('queued');
    await ctx.worker.drain();
    expect(((await (await app.request(`/api/jobs/${job.id}`)).json()) as { status: string }).status).toBe('done');
    const ledger = await (await app.request('/api/ledger')).text();
    expect(ledger).toContain('"purpose":"connection_test"');
    expect(ledger).not.toContain('EndpointSecret');
    const summary = (await (await app.request('/api/ledger/summary')).json()) as { service: string; count: number }[];
    expect(summary).toEqual([expect.objectContaining({ service: 'openai', count: 1, failed: 0 })]);
    const conns = (await (await app.request('/api/connections')).json()) as { service: string; last: { ok: boolean } | null }[];
    expect(conns.find((c) => c.service === 'openai')?.last).toMatchObject({ ok: true });
    await ctx.close();
  });

  it('errors reaching the browser are redacted', async () => {
    const ctx = testContext();
    await ctx.secrets.set('claude_api_key', 'sk-ant-LeakyKeyValue0001');
    const app = createApp(ctx);
    app.get('/boom', () => {
      throw new Error('failed with sk-ant-LeakyKeyValue0001');
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('LeakyKey');
    expect(text).toContain('[redacted]');
    await ctx.close();
  });
});

describe('SSE', () => {
  it('sends hello, then every bus event, and stops on abort', async () => {
    const bus = new EventBus();
    const app = new Hono().get('/events', sseHandler(bus, 60_000));
    const res = await app.request('/events');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const read = async () => dec.decode((await reader.read()).value);

    const first = await read();
    expect(first).toContain('"kind":"hello"');
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.listenerCount).toBe(1);

    bus.emit({ kind: 'ledger', service: 'meta', purpose: 'batch', ok: true, status: 200 });
    const second = await read();
    expect(second).toContain('"purpose":"batch"');

    await reader.cancel(); // what a closed browser tab does through the Node server
    await new Promise((r) => setTimeout(r, 20));
    expect(bus.listenerCount).toBe(0);
  });
});
