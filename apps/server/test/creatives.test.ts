import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT_BODY, DEFAULT_SHOTS, PROMPT_9x16_RULE, PROMPT_FIXED_RULES, ShopifySnapshot, shotFor, splitShots } from '@conveyor/shared';
import { createApp } from '../src/app.ts';
import { creativeBatches, creatives, products, requests } from '../src/db/schema.ts';
import { codexEngine, planTasks, taskFile } from '../src/images/codexWorkers.ts';
import type { RunCli } from '../src/listing/writers/types.ts';
import { customVariables, fillPrompt, promptVariables } from '../src/images/prompts.ts';
import { ensureReferences } from '../src/images/references.ts';
import { exiftoolAvailable, exiftoolClean } from '../src/images/exiftool.ts';
import { FIXTURES, fakeCli, fakeFetch, fixture, json, testContext, type CliCall } from './helpers.ts';

const MUG = fs.readFileSync(path.join(FIXTURES, 'images', 'codex-mug.png'));
const SNAPSHOT = ShopifySnapshot.parse({
  id: 'gid://shopify/Product/8001', handle: 'linen-oversized-blazer', title: 'Linen Oversized Blazer', status: 'ACTIVE', descriptionHtml: '<p>x</p>', productType: 'Blazers', tags: [], vendor: 'conveyor', onlineStoreUrl: null,
  featuredImage: 'https://cdn.shopify.com/s/files/1/blazer.jpg',
  images: [1, 2, 3, 4].map((i) => ({ id: `gid://shopify/MediaImage/900${i}`, url: `https://cdn.shopify.com/s/files/1/blazer-${i}.jpg`, altText: null })),
  options: [], variants: [{ id: 'v1', title: 'S', sku: null, priceMinor: 8999, compareAtPriceMinor: null, imageId: null }], currency: 'USD', updatedAt: '2026-09-15T10:00:00Z', fetchedAt: new Date().toISOString(),
});

/** A fake Codex that reads TASK.md, and writes the listed out/NN.png files (a real engine PNG). */
function fakeCodex(behaviour: (call: CliCall, files: string[], attempt: number) => { write?: string[]; stdout?: string; stderr?: string; code?: number | null; timedOut?: boolean } = () => ({})) {
  let attempts = 0;
  return fakeCli({
    codex: async (call) => {
      if (call.args[0] === '--version') return { stdout: 'codex-cli 0.154.0' };
      attempts += 1;
      const task = fs.readFileSync(path.join(call.cwd, 'TASK.md'), 'utf8');
      const files = [...task.matchAll(/out\/(\d\d\.png)/g)].map((m) => m[1]!);
      const b = behaviour(call, files, attempts);
      const toWrite = b.write ?? files;
      fs.mkdirSync(path.join(call.cwd, 'out'), { recursive: true });
      for (const f of toWrite) fs.writeFileSync(path.join(call.cwd, 'out', f), MUG);
      return { stdout: b.stdout ?? '{"type":"turn.completed"}', stderr: b.stderr ?? '', code: b.code ?? 0, timedOut: b.timedOut ?? false };
    },
  });
}

describe('prompts', () => {
  it('finds variables and fills them, appending the fixed rules and the 9:16 rule', () => {
    expect(promptVariables('A {{title}} in {{scene}} for {{ audience }}, {{title}}')).toEqual(['title', 'scene', 'audience']);
    expect(customVariables('{{title}} {{scene}}')).toEqual(['scene']);
    const { prompt, missing } = fillPrompt('Photo of {{title}} in {{scene}}.', { title: 'a mug' }, '9:16');
    expect(prompt).toContain('Photo of a mug in .');
    expect(prompt).toContain(PROMPT_FIXED_RULES);
    expect(prompt).toContain(PROMPT_9x16_RULE);
    expect(missing).toEqual(['scene']);
    expect(fillPrompt(DEFAULT_PROMPT_BODY, { title: 'x' }, '1:1').prompt).not.toContain('14%');
  });
});

describe('codex worker pool', () => {
  const slots = (n: number, aspects: ('1:1' | '4:5' | '9:16')[] = ['1:1', '4:5', '9:16']) => aspects.flatMap((aspect, a) => Array.from({ length: n }, (_, i) => ({ creativeId: a * 100 + i + 1, aspect, slot: i + 1 })));
  const events = (log: string[] = []) => ({ images: new Map<number, Buffer>(), log, ev: { onImage: async (s: { creativeId: number }, b: Buffer) => void events_images.set(s.creativeId, b), log: (m: string) => void log.push(m), progress: () => undefined } });
  const events_images = new Map<number, Buffer>();

  it('one task per format, each in its own folder with references, a task file and the right sizes', async () => {
    const cli = fakeCodex();
    const ctx = testContext(undefined, { runCli: cli.run });
    const refDir = path.join(ctx.dataDir, 'refs');
    fs.mkdirSync(refDir, { recursive: true });
    const ref = path.join(refDir, 'ref-0.png');
    fs.writeFileSync(ref, MUG);
    const engine = codexEngine({ workers: 3, imagesPerTask: 'format', timeLimitPerImageMs: 5_000, run: cli.run, pollMs: 10 });
    const produced: number[] = [];
    const out = await engine.generate({ batchId: 1, productId: 1, workDir: path.join(ctx.dataDir, 'workers', 'b1'), referencePaths: [ref], prompt: 'PROMPT TEXT', slots: slots(4) }, { onImage: async (s) => void produced.push(s.creativeId), log: () => undefined, progress: () => undefined });
    expect(out.producedCreativeIds.length).toBe(12);
    expect(out.remaining).toEqual([]);
    expect(out.handoff).toBeNull();
    expect(out.apiRequests).toBe(0);
    expect(out.tasks).toBe(3);
    const execs = cli.of('codex').filter((c) => c.args[0] === 'exec');
    expect(execs).toHaveLength(3);
    expect(new Set(execs.map((c) => c.cwd)).size).toBe(3);
    for (const c of execs) {
      expect(c.args).toContain('--json');
      expect(c.args[c.args.indexOf('--sandbox') + 1]).toBe('workspace-write');
      expect(c.env.OPENAI_API_KEY).toBeUndefined();
      expect(fs.existsSync(path.join(c.cwd, 'reference-1.png'))).toBe(true);
      const task = fs.readFileSync(path.join(c.cwd, 'TASK.md'), 'utf8');
      expect(task).toContain('PROMPT TEXT');
      expect(task).toMatch(/1088x(1088|1360|1936)/);
      expect(task).toContain('reference-1.png');
      expect(task).toContain('out/01.png, out/02.png, out/03.png, out/04.png');
    }
    await ctx.close();
  });

  it('never runs more workers than configured', async () => {
    let inFlight = 0;
    let peak = 0;
    const cli = fakeCli({
      codex: async (call) => {
        if (call.args[0] === '--version') return { stdout: 'codex-cli 0.154.0' };
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 60));
        const files = [...fs.readFileSync(path.join(call.cwd, 'TASK.md'), 'utf8').matchAll(/out\/(\d\d\.png)/g)].map((m) => m[1]!);
        fs.mkdirSync(path.join(call.cwd, 'out'), { recursive: true });
        for (const f of files) fs.writeFileSync(path.join(call.cwd, 'out', f), MUG);
        inFlight -= 1;
        return { stdout: '' };
      },
    });
    const ctx = testContext(undefined, { runCli: cli.run });
    const engine = codexEngine({ workers: 2, imagesPerTask: 'one', timeLimitPerImageMs: 5_000, run: cli.run, pollMs: 5 });
    const out = await engine.generate({ batchId: 1, productId: 1, workDir: path.join(ctx.dataDir, 'w'), referencePaths: [], prompt: 'p', slots: slots(3, ['1:1']) }, { onImage: async () => undefined, log: () => undefined, progress: () => undefined });
    expect(out.producedCreativeIds).toHaveLength(3);
    expect(out.tasks).toBe(3);
    expect(peak).toBeLessThanOrEqual(2);
    await ctx.close();
  });

  it('retries only the missing images, once', async () => {
    const cli = fakeCodex((_c, files, attempt) => (attempt === 1 ? { write: files.slice(0, 2) } : {}));
    const ctx = testContext(undefined, { runCli: cli.run });
    const log: string[] = [];
    const engine = codexEngine({ workers: 1, imagesPerTask: 'format', timeLimitPerImageMs: 5_000, run: cli.run, pollMs: 5 });
    const out = await engine.generate({ batchId: 1, productId: 1, workDir: path.join(ctx.dataDir, 'w'), referencePaths: [], prompt: 'p', slots: slots(4, ['4:5']) }, { onImage: async () => undefined, log: (m) => void log.push(m), progress: () => undefined });
    expect(out.producedCreativeIds).toHaveLength(4);
    const execs = cli.of('codex').filter((c) => c.args[0] === 'exec');
    expect(execs).toHaveLength(2);
    const retryTask = fs.readFileSync(path.join(execs[1]!.cwd, 'TASK.md'), 'utf8');
    expect(retryTask).toContain('out/03.png, out/04.png');
    expect(retryTask).not.toContain('out/01.png');
    expect(log.some((l) => /Retrying 2 missing/.test(l))).toBe(true);
    await ctx.close();
  });

  it('stops after two failed tasks and reports the remaining slots for hand-off', async () => {
    const cli = fakeCodex(() => ({ write: [], code: 1, stderr: 'image generation error' }));
    const ctx = testContext(undefined, { runCli: cli.run });
    const engine = codexEngine({ workers: 1, imagesPerTask: 'format', timeLimitPerImageMs: 5_000, run: cli.run, pollMs: 5 });
    const out = await engine.generate({ batchId: 1, productId: 1, workDir: path.join(ctx.dataDir, 'w'), referencePaths: [], prompt: 'p', slots: slots(2) }, { onImage: async () => undefined, log: () => undefined, progress: () => undefined });
    expect(out.producedCreativeIds).toEqual([]);
    expect(out.remaining).toHaveLength(6);
    expect(out.handoff).toMatchObject({ usageLimit: false });
    expect(out.failures).toBe(2);
    expect(cli.of('codex').filter((c) => c.args[0] === 'exec')).toHaveLength(2);
    await ctx.close();
  });

  it('a plan limit stops the pool at once and is marked as one', async () => {
    const cli = fakeCodex(() => ({ write: [], code: 1, stderr: "You've hit your usage limit. Try again in 3 hours." }));
    const ctx = testContext(undefined, { runCli: cli.run });
    const engine = codexEngine({ workers: 1, imagesPerTask: 'format', timeLimitPerImageMs: 5_000, run: cli.run, pollMs: 5 });
    const out = await engine.generate({ batchId: 1, productId: 1, workDir: path.join(ctx.dataDir, 'w'), referencePaths: [], prompt: 'p', slots: slots(2) }, { onImage: async () => undefined, log: () => undefined, progress: () => undefined });
    expect(out.handoff).toMatchObject({ usageLimit: true });
    expect(cli.of('codex').filter((c) => c.args[0] === 'exec')).toHaveLength(1);
    expect(out.remaining).toHaveLength(6);
    await ctx.close();
  });

  it('a timed-out task counts as a failure but keeps the images that did arrive', async () => {
    const cli = fakeCodex((_c, files) => ({ write: files.slice(0, 1), timedOut: true, code: null }));
    const ctx = testContext(undefined, { runCli: cli.run });
    const engine = codexEngine({ workers: 1, imagesPerTask: 'format', timeLimitPerImageMs: 5_000, run: cli.run, pollMs: 5, maxFailures: 1 });
    const out = await engine.generate({ batchId: 1, productId: 1, workDir: path.join(ctx.dataDir, 'w'), referencePaths: [], prompt: 'p', slots: slots(3, ['1:1']) }, { onImage: async () => undefined, log: () => undefined, progress: () => undefined });
    expect(out.producedCreativeIds).toHaveLength(1);
    expect(out.remaining).toHaveLength(2);
    expect(out.handoff).not.toBeNull();
    await ctx.close();
  });

  it('planTasks and taskFile', () => {
    expect(planTasks(slots(2), 'format').map((t) => t.slots.length)).toEqual([2, 2, 2]);
    expect(planTasks(slots(2), 'one')).toHaveLength(6);
    const t = taskFile({ prompt: 'P', aspect: '9:16', slots: [{ creativeId: 1, aspect: '9:16', slot: 7 }], refs: ['reference-1.png'], edit: { name: 'edit-target.jpg', instruction: 'make the mug blue' } });
    expect(t).toContain('1088x1936');
    expect(t).toContain('out/07.png');
    expect(t).toContain('make the mug blue');
    expect(t).toContain('FAILED');
  });

  it('the task file never makes pixel size a reason to stop, and gives every image its own shot', () => {
    const t = taskFile({ prompt: 'P', aspect: '1:1', slots: [{ creativeId: 1, aspect: '1:1', slot: 5, direction: 'Side profile.' }, { creativeId: 2, aspect: '1:1', slot: 6, direction: 'From above.' }], refs: [], edit: null });
    // Live, 17 September 2026: the tool returned 1254x1254 for "exactly 1088x1088" and Codex stopped after one image.
    expect(t).not.toMatch(/exactly \d+x\d+/);
    expect(t).toContain('Never stop, retry or report a failure because of pixel size');
    expect(t).toContain('- out/05.png: Shot: Side profile.');
    expect(t).toContain('- out/06.png: Shot: From above.');
    expect(t).toContain('clearly different photograph');
  });

  it('shots come from the template when it lists them, and from the built-in list otherwise', () => {
    const own = splitShots('A studio photo of {{title}}.\n\nShots:\n- On a plinth\n2. Held in a hand\n\n');
    expect(own).toEqual({ body: 'A studio photo of {{title}}.', shots: ['On a plinth', 'Held in a hand'] });
    expect(splitShots('No list here.')).toEqual({ body: 'No list here.', shots: [] });
    expect(shotFor(own.shots, 1)).toBe('Held in a hand');
    expect(shotFor(own.shots, 2)).toContain('On a plinth');
    expect(shotFor(own.shots, 2)).toContain('different pose');
    expect(new Set(DEFAULT_SHOTS.map((_, i) => shotFor([], i))).size).toBe(DEFAULT_SHOTS.length);
  });

  it('relays the line Codex gives when it stops early', async () => {
    const ctx = testContext();
    const workDir = path.join(ctx.dataDir, 'w-gaveup');
    const logs: string[] = [];
    const run: RunCli = async (_cmd, args, o) => {
      if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.154.0', stderr: '', timedOut: false };
      fs.mkdirSync(path.join(o.cwd, 'out'), { recursive: true });
      fs.writeFileSync(path.join(o.cwd, 'out', '01.png'), MUG);
      fs.writeFileSync(path.join(o.cwd, 'last-message.txt'), 'FAILED the tool returned an odd size');
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    const engine = codexEngine({ workers: 1, imagesPerTask: 'format', timeLimitPerImageMs: 5_000, run, pollMs: 5 });
    const out = await engine.generate(
      { batchId: 1, productId: 1, workDir, referencePaths: [], prompt: 'P', slots: [{ creativeId: 1, aspect: '1:1', slot: 1 }, { creativeId: 2, aspect: '1:1', slot: 2 }] },
      { onImage: async () => undefined, log: (m) => logs.push(m), progress: () => undefined },
    );
    expect(out.producedCreativeIds).toEqual([1]);
    expect(logs.join('\n')).toContain('Codex stopped early: FAILED the tool returned an odd size');
    await ctx.close();
  });
  void events;
});

describe('reference cache', () => {
  it('downloads the first three Shopify images once; a second batch reuses them', async () => {
    const ff = fakeFetch({ 'cdn.shopify.com': () => new Response(MUG, { status: 200, headers: { 'content-type': 'image/png' } }) });
    const ctx = testContext(ff.impl);
    const pid = ctx.db.insert(products).values({ origin: 'shopify', state: 'editing_in_shopify', shopifyProductId: SNAPSHOT.id, snapshot: SNAPSHOT }).returning({ id: products.id }).get().id;
    const dir = path.join(ctx.dataDir, 'products', String(pid));
    const a = await ensureReferences(ctx, pid, SNAPSHOT, 'first_3_shopify_images', dir, { jobId: null });
    expect(a.paths).toHaveLength(3);
    expect(a.downloaded).toBe(3);
    expect(ff.calls).toHaveLength(3);
    const b = await ensureReferences(ctx, pid, SNAPSHOT, 'first_3_shopify_images', dir, { jobId: null });
    expect(b.reused).toBe(3);
    expect(ff.calls).toHaveLength(3);
    expect(ctx.db.select().from(requests).all().every((r) => r.service === 'cdn' && r.purpose === 'reference_image')).toBe(true);
    expect((await ensureReferences(ctx, pid, SNAPSHOT, 'none', dir, { jobId: null })).paths).toEqual([]);
    await ctx.close();
  });
});

describe('a 12-image batch on Codex', () => {
  async function setup(codex = fakeCodex(), snapshotAgeMin = 0) {
    const ff = fakeFetch({
      '/admin/oauth/access_token': () => json(fixture('shopify/access_token.json')),
      'graphql.json': () => json(fixture('shopify/product.json')),
      'cdn.shopify.com': () => new Response(MUG, { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const ctx = testContext(ff.impl, { runCli: codex.run });
    await ctx.secrets.set('shopify_client_id', 'cid');
    await ctx.secrets.set('shopify_client_secret', 'shpss_secret1234567890');
    ctx.settings.set('connections', { shopify: { storeDomain: 'ashworth-studio.myshopify.com' } });
    const snapshotAt = new Date(Date.now() - snapshotAgeMin * 60_000).toISOString();
    const pid = ctx.db.insert(products).values({ origin: 'shopify', state: 'editing_in_shopify', shopifyProductId: 'gid://shopify/Product/8001', shopifyHandle: 'linen-oversized-blazer', title: 'Linen Oversized Blazer', snapshot: { ...SNAPSHOT, fetchedAt: snapshotAt }, snapshotAt }).returning({ id: products.id }).get().id;
    const app = createApp(ctx);
    const post = (p: string, body: unknown = {}) => app.request(p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const api = () => ctx.db.select().from(requests).all().filter((r) => r.service === 'shopify' && r.purpose !== 'access_token');
    return { ctx, app, post, pid, ff, codex, api };
  }

  it('uses 1 API request (the snapshot), finishes 12 clean JPEGs, and moves the product to review', async () => {
    const t = await setup(fakeCodex(), 30);
    const res = await t.post(`/api/products/${t.pid}/generate`);
    expect(res.status).toBe(202);
    await t.ctx.worker.drain();

    const job = t.ctx.worker.list()[0]!;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    expect(job.completedSteps).toEqual(['snapshot', 'plan', 'references', 'generate', 'finish']);
    expect(t.api().map((r) => r.purpose)).toEqual(['product_snapshot']);
    // The re-read snapshot comes from fixtures/shopify/product.json, which has two images and a video.
    expect(t.ctx.db.select().from(requests).all().filter((r) => r.service === 'cdn')).toHaveLength(2);
    expect(t.ff.calls.some((c) => /openai|anthropic|rapidapi/.test(c.url))).toBe(false);

    const batches = (await (await t.app.request(`/api/products/${t.pid}/batches`)).json()) as { status: string; total: number; finished: number; apiRequests: number; creatives: { status: string; fileName: string; finishedUrl: string; width: number; height: number; metadataCheck: string; sha256: string; aspect: string; slot: number }[] }[];
    expect(batches).toHaveLength(1);
    const b = batches[0]!;
    expect(b).toMatchObject({ status: 'done', total: 12, finished: 12, apiRequests: 1 });
    expect(b.creatives.map((c) => c.fileName).slice(0, 2)).toEqual(['linen-oversized-blazer_1x1_01.jpg', 'linen-oversized-blazer_1x1_02.jpg']);
    expect(b.creatives.filter((c) => c.aspect === '9:16').every((c) => c.width === 1080 && c.height === 1920)).toBe(true);
    // Every fake image is the same PNG, so hashes repeat within an aspect but differ across the three frames.
    expect(b.creatives.every((c) => /^[a-f0-9]{64}$/.test(c.sha256))).toBe(true);
    expect(new Set(b.creatives.map((c) => c.sha256)).size).toBe(3);
    if (await exiftoolAvailable()) {
      expect(b.creatives.every((c) => c.metadataCheck === 'clean (sharp, exiftool)')).toBe(true);
    }
    const img = await t.app.request(b.creatives[0]!.finishedUrl);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await img.arrayBuffer()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    for (const c of b.creatives) {
      const file = t.ctx.db.select().from(creatives).all().find((x) => x.id === (c as unknown as { id: number }).id)!.finishedPath!;
      expect(fs.existsSync(file)).toBe(true);
      if (await exiftoolAvailable()) expect((await exiftoolClean(file)).ok).toBe(true);
    }

    const p = (await (await t.app.request(`/api/products/${t.pid}`)).json()) as { state: string };
    expect(p.state).toBe('review');
    await t.ctx.close();
  });

  it('a fresh snapshot means 0 API requests, and a second batch continues the slot numbering', async () => {
    const t = await setup(fakeCodex(), 2);
    await t.post(`/api/products/${t.pid}/generate`, { formats: ['1:1'], countPerFormat: 2 });
    await t.ctx.worker.drain();
    await t.post(`/api/products/${t.pid}/generate`, { formats: ['1:1'], countPerFormat: 2 });
    await t.ctx.worker.drain();
    expect(t.api()).toHaveLength(0);
    const names = t.ctx.db.select({ f: creatives.fileName }).from(creatives).all().map((r) => r.f);
    expect(names).toEqual(['linen-oversized-blazer_1x1_01.jpg', 'linen-oversized-blazer_1x1_02.jpg', 'linen-oversized-blazer_1x1_03.jpg', 'linen-oversized-blazer_1x1_04.jpg']);
    expect(t.ff.calls.filter((c) => c.url.includes('cdn.shopify.com'))).toHaveLength(3);
    await t.ctx.close();
  });

  it('a simulated Codex limit with no OpenAI engine leaves a partial batch, and a retry makes only the missing images', async () => {
    let limited = true;
    const codex = fakeCodex((_c, files) => (limited ? { write: files.slice(0, 1), code: 1, stderr: 'usage limit reached, resets at 9pm' } : {}));
    const t = await setup(codex, 30);
    await t.post(`/api/products/${t.pid}/generate`, { formats: ['4:5'], countPerFormat: 4 });
    await t.ctx.worker.drain();
    const job = t.ctx.worker.list()[0]!;
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ step: 'generate', retryable: true, code: 'usage_limit' });
    expect(job.error!.message).toMatch(/3 of 4 images were not made/);
    let b = t.ctx.db.select().from(creativeBatches).get()!;
    expect(b.status).toBe('partial');
    expect(b.note).toMatch(/plan limit|usage limit/i);
    expect(((await (await t.app.request(`/api/products/${t.pid}`)).json()) as { state: string }).state).toBe('review');

    limited = false;
    await t.app.request(`/api/products/${t.pid}/retry`, { method: 'POST' });
    await t.ctx.worker.drain();
    expect(t.ctx.worker.view(job.id).status).toBe('done');
    b = t.ctx.db.select().from(creativeBatches).get()!;
    expect(b.status).toBe('done');
    // The retry produced only the 3 missing images and made no new API request.
    const lastTask = fs.readFileSync(path.join(t.codex.of('codex').filter((c) => c.args[0] === 'exec').at(-1)!.cwd, 'TASK.md'), 'utf8');
    expect(lastTask).toContain('out/02.png, out/03.png, out/04.png');
    expect(t.api()).toHaveLength(1);
    await t.ctx.close();
  });

  it('approve moves the product to ready to launch; regenerate makes a one-image batch in the same aspect', async () => {
    const t = await setup(fakeCodex(), 30);
    await t.post(`/api/products/${t.pid}/generate`, { formats: ['4:5'], countPerFormat: 2 });
    await t.ctx.worker.drain();
    const first = t.ctx.db.select().from(creatives).get()!;
    const approved = (await (await t.post(`/api/creatives/${first.id}/approve`)).json()) as { approval: string };
    expect(approved.approval).toBe('approved');
    expect(((await (await t.app.request(`/api/products/${t.pid}`)).json()) as { state: string }).state).toBe('ready_to_launch');
    await t.post(`/api/creatives/${first.id}/unapprove`);
    expect(((await (await t.app.request(`/api/products/${t.pid}`)).json()) as { state: string }).state).toBe('review');

    const res = await t.post(`/api/creatives/${first.id}/regenerate`, { instruction: 'darker background' });
    expect(res.status).toBe(202);
    await t.ctx.worker.drain();
    const batches = t.ctx.db.select().from(creativeBatches).all();
    expect(batches).toHaveLength(2);
    expect(batches[1]).toMatchObject({ replacesCreativeId: first.id, countPerFormat: 1, formats: ['4:5'] });
    expect(batches[1]!.prompt).toContain('darker background');
    const task = fs.readFileSync(path.join(t.codex.of('codex').filter((c) => c.args[0] === 'exec').at(-1)!.cwd, 'TASK.md'), 'utf8');
    expect(task).toContain('edit-target');
    expect(task).toContain('out/03.png');
    expect(t.api()).toHaveLength(1); // the snapshot from the first batch was still fresh
    await t.ctx.close();
  });

  it('prompt templates are versioned and the default is seeded', async () => {
    const t = await setup();
    const list = (await (await t.app.request('/api/prompt-templates')).json()) as { id: number; name: string; version: number; isDefault: boolean; variables: string[] }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Clean product shot', version: 1, isDefault: true });
    expect(list[0]!.variables).toContain('title');
    const updated = (await (await t.app.request(`/api/prompt-templates/${list[0]!.id}`, { method: 'PUT', body: JSON.stringify({ name: 'Clean product shot', body: 'A photo of {{title}} in {{scene}}, ten words more here.', formats: ['1:1'], countPerFormat: 2 }), headers: { 'content-type': 'application/json' } })).json()) as { version: number; isDefault: boolean; variables: string[] };
    expect(updated).toMatchObject({ version: 2, isDefault: true });
    expect(updated.variables).toEqual(['title', 'scene']);
    const again = (await (await t.app.request('/api/prompt-templates')).json()) as { version: number }[];
    expect(again).toHaveLength(1);
    expect(again[0]!.version).toBe(2);
    await t.ctx.close();
  });
});
