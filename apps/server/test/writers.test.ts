import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ListingWire, listingJsonSchema, type SourceProduct } from '@conveyor/shared';
import { childEnv, keyVarsInEnvironment, looksLikeUsageLimit, runListingWriter, makeWriters, WriterError } from '../src/listing/writers/index.ts';
import { claudeCodeArgs } from '../src/listing/writers/claudeCode.ts';
import { codexArgs } from '../src/listing/writers/codex.ts';
import { HISTORY_TITLES, historyNote, listingPrompt } from '../src/listing/prompt.ts';
import { ensurePhotos } from '../src/listing/photos.ts';
import { mapAliexpress } from '../src/suppliers/mapAliexpress.ts';
import { claudeAuthOk, claudeResult, fakeCli, fixture, testContext, type CliCall } from './helpers.ts';

const source = (): SourceProduct => mapAliexpress(fixture('rapidapi/aliexpress-item.json'), { itemId: '3256812772817240', url: 'https://www.aliexpress.com/item/3256812772817240.html' });
const WIRE = JSON.parse((fixture('claude/listing-response.json') as { content: { text: string }[] }).content[0]!.text) as unknown;
const isAuth = (c: CliCall) => c.args[0] === 'auth';

function req(dir: string, photos: string[] = ['photo-0.jpg'], focus = '') {
  return { dir, source: source(), brandVoice: 'Warm and plain.', instructions: '', focus, recentTitles: [], photos, productId: 1, jobId: 1 };
}

describe('childEnv', () => {
  it('removes every key-like variable, including ones we have not named', () => {
    const env = childEnv({ PATH: '/usr/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x', CLAUDE_CODE_USE_BEDROCK: '1', MY_SERVICE_API_KEY: 'x', SOME_ACCESS_TOKEN: 'x', GH_TOKEN: 'keepme' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/h', GH_TOKEN: 'keepme' });
    expect(keyVarsInEnvironment({ ANTHROPIC_API_KEY: 'x', PATH: '/' })).toEqual(['ANTHROPIC_API_KEY']);
  });
});

describe('the JSON schema handed to the CLIs', () => {
  it('is generated from the same Zod object the reply is validated against', () => {
    const schema = listingJsonSchema() as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(ListingWire.shape).sort());
    expect(schema.required).toContain('needsCheck');
  });

  it('names no dialect: Claude Code 2.1.274 rejects a "$schema" it cannot resolve', () => {
    const text = JSON.stringify(listingJsonSchema());
    expect(text).not.toContain('$schema');
    expect(text).not.toContain('$ref');
    expect(text).not.toContain('$defs');
  });
});

describe('listingPrompt', () => {
  it('names the photos, carries the brand voice, and leaves seller data out', () => {
    const p = listingPrompt(source(), 'Warm and plain.', ['photo-0.jpg', 'photo-1.jpg']);
    expect(p).toContain('photo-0.jpg, photo-1.jpg');
    expect(p).toContain('Warm and plain.');
    expect(p).toContain('Do not invent');
    expect(p).not.toContain('storeTitle');
    expect(p).not.toContain('sellerId');
    expect(listingPrompt(source(), '', [])).toContain('No photos are available');
    expect(listingPrompt(source(), '', [], { repairNote: 'title: too long' })).toContain('title: too long');
  });

  it('carries this product\'s focus, under the rule that it may not invent a fact to fit it', () => {
    const p = listingPrompt(source(), '', [], { focus: 'The full-grain leather, for commuters' });
    expect(p).toContain('Focus for this listing: The full-grain leather, for commuters');
    expect(p).toContain('Never invent a fact to fit the focus.');
    expect(p.indexOf('Focus for this listing')).toBeLessThan(p.indexOf('Supplier data'));
    expect(listingPrompt(source(), '', [], { focus: '   ' })).not.toContain('Focus for this listing');
  });
});

describe('the titles already used', () => {
  it('are listed newest first, with the rule that a name is not used twice', () => {
    const p = listingPrompt(source(), '', [], { recentTitles: ['Ashworth leather loafer', 'Whitcombe desk lamp'] });
    expect(p).toContain('Titles this store has already published, newest first:');
    expect(p.indexOf('- Ashworth leather loafer')).toBeLessThan(p.indexOf('- Whitcombe desk lamp'));
    expect(p).toContain('Do not reuse one of these titles');
    expect(p.indexOf('Titles this store has already published')).toBeLessThan(p.indexOf('Supplier data'));
  });

  it('drops blanks and repeats, whatever their casing, and caps the list', () => {
    const note = historyNote(['Ashworth loafer', '  ', 'ASHWORTH LOAFER', 'Whitcombe lamp'])!;
    expect(note.match(/^- /gm)).toHaveLength(2);
    const many = historyNote(Array.from({ length: HISTORY_TITLES + 15 }, (_, i) => `Title ${i}`))!;
    expect(many.match(/^- /gm)).toHaveLength(HISTORY_TITLES);
  });

  it('says nothing at all when the store has published nothing yet', () => {
    expect(historyNote([])).toBeNull();
    expect(historyNote(['  '])).toBeNull();
    expect(listingPrompt(source(), '', [])).not.toContain('already published');
  });
});

describe('the store\'s additional instructions', () => {
  it('ride alongside the voice as rules, under the same hard limits', () => {
    const p = listingPrompt(source(), 'Warm and plain.', [], { instructions: 'Never use the word premium.' });
    expect(p).toContain('Never use the word premium.');
    expect(p).toContain('Treat them as rules, not suggestions');
    expect(p).toContain('Warm and plain.');
    expect(listingPrompt(source(), '', [], { instructions: '  ' })).not.toContain('Treat them as rules');
  });
});

describe('the store\'s writing instructions', () => {
  it('take precedence over the style rules, but never over the hard limits', () => {
    const prompt = listingPrompt(source(), 'Titles follow "Name | Material Type".', []);
    expect(prompt).toContain('Titles follow "Name | Material Type".');
    expect(prompt).toContain('Where they differ from the style rules above, follow them.');
    expect(prompt).toContain('never override the character limits');
    expect(listingPrompt(source(), '  ', [])).toContain('Brand voice: plain, warm and specific.');
  });
});

describe('claude code writer', () => {
  it('runs in the product folder with an API-key-free environment and the isolation flags', async () => {
    const cli = fakeCli({ claude: (c) => (isAuth(c) ? { stdout: claudeAuthOk() } : { stdout: claudeResult(WIRE) }) });
    const ctx = testContext(undefined, { runCli: cli.run });
    const dir = path.join(ctx.dataDir, 'p1');
    fs.mkdirSync(dir, { recursive: true });
    const run = await ctx.writers.claude_code.write(req(dir));

    expect(run.draft.title).toBe('Soft-sole slip-on loafers for men');
    expect(run.apiRequests).toBe(0);
    expect(run.attempts).toBe(1);
    const call = cli.of('claude').find((c) => !isAuth(c))!;
    expect(call.cwd).toBe(dir);
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    const args = call.args;
    expect(args[0]).toBe('-p');
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(args).not.toContain('--bare');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toMatchObject({ type: 'object' });
    await ctx.close();
  });

  it('asks once more when the reply fails validation, then succeeds', async () => {
    const bad = { ...(WIRE as Record<string, unknown>), title: 'x'.repeat(90) };
    let n = 0;
    const cli = fakeCli({ claude: (c) => (isAuth(c) ? { stdout: claudeAuthOk() } : { stdout: claudeResult(n++ === 0 ? bad : WIRE) }) });
    const ctx = testContext(undefined, { runCli: cli.run });
    const run = await ctx.writers.claude_code.write(req(ctx.dataDir));
    expect(run.attempts).toBe(2);
    const writes = cli.of('claude').filter((c) => !isAuth(c));
    expect(writes).toHaveLength(2);
    expect(writes[1]!.args[1]).toContain('did not pass validation');
    await ctx.close();
  });

  it('reads the text result when structured output is missing', async () => {
    const cli = fakeCli({ claude: (c) => (isAuth(c) ? { stdout: claudeAuthOk() } : { stdout: JSON.stringify({ type: 'result', is_error: false, result: '```json\n' + JSON.stringify(WIRE) + '\n```' }) }) });
    const ctx = testContext(undefined, { runCli: cli.run });
    expect((await ctx.writers.claude_code.write(req(ctx.dataDir))).draft.productType).toBe('Loafers');
    await ctx.close();
  });

  it('classifies a usage limit apart from an ordinary error, and a timeout as retryable', async () => {
    expect(looksLikeUsageLimit('Claude usage limit reached. Your limit resets at 3pm.')).toBe(true);
    expect(looksLikeUsageLimit('Invalid JSON schema')).toBe(false);

    const limited = fakeCli({ claude: (c) => (isAuth(c) ? { stdout: claudeAuthOk() } : { stdout: JSON.stringify({ type: 'result', is_error: true, subtype: 'error', result: 'Claude usage limit reached. Your limit resets at 3pm.' }) }) });
    const a = testContext(undefined, { runCli: limited.run });
    await expect(a.writers.claude_code.write(req(a.dataDir))).rejects.toMatchObject({ usageLimit: true, writer: 'claude_code' });
    await a.close();

    const broken = fakeCli({ claude: (c) => (isAuth(c) ? { stdout: claudeAuthOk() } : { stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Invalid flag' }) }) });
    const b = testContext(undefined, { runCli: broken.run });
    await expect(b.writers.claude_code.write(req(b.dataDir))).rejects.toMatchObject({ usageLimit: false });
    await b.close();

    const slow = fakeCli({ claude: (c) => (isAuth(c) ? { stdout: claudeAuthOk() } : { timedOut: true, code: null }) });
    const c = testContext(undefined, { runCli: slow.run });
    await expect(c.writers.claude_code.write(req(c.dataDir))).rejects.toMatchObject({ retryable: true, usageLimit: false });
    await c.close();
  });

  it('is unavailable when signed in with anything other than a Claude plan', async () => {
    const apiKeyLogin = fakeCli({ claude: (c) => (isAuth(c) ? { stdout: JSON.stringify({ loggedIn: true, authMethod: 'apiKey' }) } : { stdout: claudeResult(WIRE) }) });
    const ctx = testContext(undefined, { runCli: apiKeyLogin.run });
    const a = await ctx.writers.claude_code.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toContain('not a Claude plan');
    await ctx.close();
  });
});

describe('codex writer', () => {
  it('writes the schema, reads the reply file, and passes the isolation flags', async () => {
    const cli = fakeCli({ codex: () => ({ files: { 'listing-reply.json': JSON.stringify(WIRE) } }) });
    const ctx = testContext(undefined, { runCli: cli.run });
    const dir = path.join(ctx.dataDir, 'p2');
    fs.mkdirSync(dir, { recursive: true });
    const run = await ctx.writers.codex.write(req(dir));

    expect(run.draft.title).toBe('Soft-sole slip-on loafers for men');
    expect(run.apiRequests).toBe(0);
    const args = cli.of('codex')[0]!.args;
    expect(args[0]).toBe('exec');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ephemeral');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args[args.indexOf('--output-schema') + 1]).toBe(path.join(dir, 'listing-schema.json'));
    expect(args[args.indexOf('-o') + 1]).toBe(path.join(dir, 'listing-reply.json'));
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'listing-schema.json'), 'utf8'))).toMatchObject({ type: 'object' });
    expect(cli.of('codex')[0]!.env.OPENAI_API_KEY).toBeUndefined();
    await ctx.close();
  });

  it('reports an empty reply, quoting stderr', async () => {
    const cli = fakeCli({ codex: () => ({ stderr: 'You have hit your usage limit.', code: 1 }) });
    const ctx = testContext(undefined, { runCli: cli.run });
    await expect(ctx.writers.codex.write(req(ctx.dataDir))).rejects.toMatchObject({ usageLimit: true, writer: 'codex' });
    await ctx.close();
  });
});

describe('hand-off', () => {
  const limitClaude = (c: CliCall) => (isAuth(c) ? { stdout: claudeAuthOk() } : { stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Claude usage limit reached.' }) });

  it('moves to Codex when Claude Code is at its limit, and says so', async () => {
    const cli = fakeCli({ claude: limitClaude, codex: () => ({ files: { 'listing-reply.json': JSON.stringify(WIRE) } }) });
    const ctx = testContext(undefined, { runCli: cli.run });
    const lines: string[] = [];
    const out = await runListingWriter(ctx.writers, 'claude_code', req(ctx.dataDir), (m) => lines.push(m));
    expect(out.writer).toBe('codex');
    expect(out.handedOffFrom).toEqual(['claude_code']);
    expect(lines.join(' ')).toContain('usage limit');
    await ctx.close();
  });

  it('does not hand off an ordinary failure', async () => {
    const cli = fakeCli({ claude: (c) => (isAuth(c) ? { stdout: claudeAuthOk() } : { stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Unknown flag' }) }), codex: () => ({ files: { 'listing-reply.json': JSON.stringify(WIRE) } }) });
    const ctx = testContext(undefined, { runCli: cli.run });
    await expect(runListingWriter(ctx.writers, 'claude_code', req(ctx.dataDir), () => undefined)).rejects.toThrow(/Unknown flag/);
    expect(cli.of('codex')).toHaveLength(0);
    await ctx.close();
  });

  it('when every writer is limited, the error says so and stays retryable', async () => {
    const cli = fakeCli({ claude: limitClaude, codex: () => ({ stderr: 'usage limit reached', code: 1 }) });
    const ctx = testContext(undefined, { runCli: cli.run });
    await expect(runListingWriter(ctx.writers, 'claude_code', req(ctx.dataDir), () => undefined)).rejects.toMatchObject({ usageLimit: true, retryable: true });
    await ctx.close();
  });

  it('skips the API writer when no key is set, and uses it when asked and set', async () => {
    const cli = fakeCli({ claude: limitClaude, codex: () => ({ stderr: 'usage limit reached', code: 1 }) });
    const ctx = testContext(undefined, { runCli: cli.run });
    expect((await ctx.writers.claude_api.available()).ok).toBe(false);
    await ctx.secrets.set('claude_api_key', 'sk-ant-key');
    expect((await ctx.writers.claude_api.available()).ok).toBe(true);
    await ctx.close();
  });
});

describe('makeWriters', () => {
  it('exposes exactly the three writers', () => {
    const ctx = testContext();
    expect(Object.keys(makeWriters({ ledger: ctx.ledger, secrets: ctx.secrets })).sort()).toEqual(['claude_api', 'claude_code', 'codex']);
    void ctx.close();
  });
  it('WriterError carries the writer and its kind', () => {
    const e = new WriterError('m', 'codex', true, true);
    expect(e).toMatchObject({ writer: 'codex', usageLimit: true, retryable: true });
  });
});

describe('ensurePhotos', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const routes = { 'aliexpress-media.com': () => new Response(png, { status: 200, headers: { 'content-type': 'image/jpeg' } }) };

  it('downloads up to four photos, reuses them on a second run, and never touches RapidAPI', async () => {
    const { fakeFetch } = await import('./helpers.ts');
    const ff = fakeFetch(routes);
    const ctx = testContext(ff.impl);
    const dir = path.join(ctx.dataDir, 'photos');
    const first = await ensurePhotos(ctx.ledger, source(), dir, { productId: 1, jobId: 1 });
    expect(first.files).toEqual(['photo-0.jpg', 'photo-1.jpg', 'photo-2.jpg', 'photo-3.jpg']);
    expect(first.downloaded).toBe(4);
    expect(ff.calls).toHaveLength(4);
    expect(ff.calls.every((c) => !c.url.includes('rapidapi'))).toBe(true);

    const second = await ensurePhotos(ctx.ledger, source(), dir, { productId: 1, jobId: 2 });
    expect(second.reused).toBe(4);
    expect(second.downloaded).toBe(0);
    expect(ff.calls).toHaveLength(4);

    const { requests } = await import('../src/db/schema.ts');
    const rows = ctx.db.select().from(requests).all();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.service === 'cdn' && r.purpose === 'listing_photo')).toBe(true);
    await ctx.close();
  });

  it('skips a failed or oversized image without failing the step', async () => {
    const { fakeFetch } = await import('./helpers.ts');
    let n = 0;
    const ff = fakeFetch({ 'aliexpress-media.com': () => (n++ === 0 ? new Response('nope', { status: 404 }) : new Response(png, { status: 200, headers: { 'content-type': 'image/jpeg' } })) });
    const ctx = testContext(ff.impl);
    const set = await ensurePhotos(ctx.ledger, source(), path.join(ctx.dataDir, 'p'), { productId: 1, jobId: 1 });
    expect(set.files).toHaveLength(3);
    expect(set.skipped[0]).toContain('HTTP 404');
    await ctx.close();
  });

  it('downloads nothing when the maximum is zero', async () => {
    const { fakeFetch } = await import('./helpers.ts');
    const ff = fakeFetch(routes);
    const ctx = testContext(ff.impl);
    const set = await ensurePhotos(ctx.ledger, source(), path.join(ctx.dataDir, 'p'), { productId: 1, jobId: 1 }, 0);
    expect(set.files).toEqual([]);
    expect(ff.calls).toHaveLength(0);
    await ctx.close();
  });
});

describe('argument builders are stable', () => {
  it('claudeCodeArgs and codexArgs put the prompt where the CLI expects it', () => {
    expect(claudeCodeArgs('PROMPT', '{}')[1]).toBe('PROMPT');
    expect(codexArgs('/d', 'PROMPT', '/d/s.json', '/d/r.json').at(-1)).toBe('PROMPT');
  });
});
