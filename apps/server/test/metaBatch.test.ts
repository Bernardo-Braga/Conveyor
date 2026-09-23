import { describe, expect, it } from 'vitest';
import { encodeBody, parseBatchResults, refsOf, splitByDependencies, withSavedIds, type BatchOp } from '../src/meta/batch.ts';
import { MetaClient, opError } from '../src/meta/client.ts';
import { interestFromName, findInterests, pickInterest, resolveVariantInterests } from '../src/meta/interests.ts';
import { exportForOtherTool, fillPattern, looksLikeTemplate, parseAgeBand, parseTemplate, storeTemplate } from '../src/meta/templates.ts';
import { fakeFetch, fixture, json, testContext } from './helpers.ts';

describe('batch helpers', () => {
  it('encodes bodies with nested JSON, finds references, and splits by dependencies at 50', () => {
    expect(encodeBody({ name: 'a b', targeting: { geo_locations: { countries: ['US'] } }, status: 'PAUSED' })).toBe('name=a+b&targeting=%7B%22geo_locations%22%3A%7B%22countries%22%3A%5B%22US%22%5D%7D%7D&status=PAUSED');
    const ops: BatchOp[] = [{ method: 'POST', relative_url: 'act_1/campaigns', name: 'campaign', body: { name: 'c' } }];
    for (let s = 0; s < 3; s++) {
      ops.push({ method: 'POST', relative_url: 'act_1/adsets', name: `set${s}`, body: { campaign_id: '{result=campaign:$.id}' } });
      for (let a = 0; a < 20; a++) ops.push({ method: 'POST', relative_url: 'act_1/ads', name: `ad${s}_${a}`, body: { adset_id: `{result=set${s}:$.id}` } });
    }
    expect(refsOf(ops[1]!)).toEqual(['campaign']);
    const batches = splitByDependencies(ops, 50);
    expect(batches.map((b) => b.length)).toEqual([50, 14]);
    // Second batch references set2 from the first batch: substituted with the saved ID before sending.
    const sent = withSavedIds(batches[1]!, { set2: '120209' });
    expect(sent.every((o) => !JSON.stringify(o.body).includes('{result=set2'))).toBe(true);
    expect((sent[0]!.body as { adset_id: string }).adset_id).toBe('120209');
  });

  it('refuses an operation that references a name not yet created', () => {
    expect(() => splitByDependencies([{ method: 'POST', relative_url: 'act_1/ads', body: { adset_id: '{result=missing:$.id}' } }])).toThrow(/references missing/);
  });

  it('parses results including timeouts and per-operation errors', () => {
    const ops: BatchOp[] = [{ method: 'POST', relative_url: 'x', name: 'a' }, { method: 'POST', relative_url: 'y', name: 'b' }, { method: 'POST', relative_url: 'z', name: 'c' }];
    const results = parseBatchResults([{ code: 200, body: '{"id":"1"}' }, { code: 400, body: JSON.stringify(fixture('meta/error-4834011.json')) }, null], ops);
    expect(results[0]).toEqual({ code: 200, body: { id: '1' }, name: 'a' });
    expect(opError(results[0]!)).toBeNull();
    expect(opError(results[1]!)).toMatchObject({ code: 100, error_subcode: 4834011 });
    expect(opError(results[2]!)).toMatchObject({ message: 'no response: the operation it depends on failed, or it timed out' });
  });
});

describe('MetaClient', () => {
  it('sends the token in a header, never the URL, and posts batches as multipart with attached files', async () => {
    const ff = fakeFetch({ 'graph.facebook.com/v26.0/': (r) => json(r.form ? [{ code: 200, body: '{"id":"1"}' }] : { id: 'me' }) });
    const ctx = testContext(ff.impl);
    await ctx.secrets.set('meta_access_token', 'EAAMetaSecretToken1234567890');
    const client = new MetaClient({ ledger: ctx.ledger, secrets: ctx.secrets });
    const { results } = await client.batch([{ method: 'POST', relative_url: 'act_1/adimages', name: 'img0', attached_files: 'img0', body: { name: 'a.jpg' } }], { purpose: 'upload' }, { img0: { data: Buffer.from('jpegbytes'), filename: 'a.jpg', type: 'image/jpeg' } });
    expect(results[0]).toMatchObject({ code: 200, body: { id: '1' }, name: 'img0' });
    const call = ff.calls[0]!;
    expect(call.url).toBe('https://graph.facebook.com/v26.0/');
    expect(call.url).not.toContain('access_token');
    expect(call.headers.authorization).toBe('Bearer EAAMetaSecretToken1234567890');
    const batch = JSON.parse(call.form!.batch as string) as { attached_files: string; body: string; omit_response_on_success: boolean }[];
    expect(batch[0]!.attached_files).toBe('img0');
    // Without this Meta omits the body of any operation another one depends on, and its ID is lost.
    expect(batch[0]!.omit_response_on_success).toBe(false);
    expect(batch[0]!.body).toBe('name=a.jpg');
    expect((call.form!.img0 as { name: string }[])[0]!.name).toBe('a.jpg');
    expect(JSON.stringify(ctx.db.select().from((await import('../src/db/schema.ts')).requests).all())).not.toContain('MetaSecret');
    await ctx.close();
  });

  it('turns a Graph error into a step error with code, subcode, trace and explanation', async () => {
    const ff = fakeFetch({ 'graph.facebook.com': () => json(fixture('meta/error-4834011.json'), 400, { 'x-fb-trace-id': 'trace-x' }) });
    const ctx = testContext(ff.impl);
    await ctx.secrets.set('meta_access_token', 'EAAtoken00000000000000000');
    const client = new MetaClient({ ledger: ctx.ledger, secrets: ctx.secrets });
    await expect(client.post('act_1/campaigns', { name: 'x' }, { purpose: 't' })).rejects.toMatchObject({ details: { service: 'meta', code: '100', subcode: '4834011', requestId: 'AZx4834011Trace' } });
    await expect(client.post('act_1/campaigns', { name: 'x' }, { purpose: 't' })).rejects.toThrow(/is_adset_budget_sharing_enabled: false/);
    await ctx.close();
  });
});

describe('templates', () => {
  it('detects, parses (dropping tokens), stores by id, updates on re-import, and exports without x_conveyor', () => {
    const ctx = testContext();
    const raw = { ...(fixture('templates/ashworth-cbo.json') as Record<string, unknown>), access_token: 'EAAshouldvanish', x_conveyor: { fillRule: 'rotate' } };
    expect(looksLikeTemplate(raw)).toBe(true);
    expect(looksLikeTemplate({ campaign: {} })).toBe(false);
    const t = parseTemplate(raw);
    expect(JSON.stringify(t)).not.toContain('shouldvanish');
    expect(t.x_conveyor?.fillRule).toBe('rotate');
    const first = storeTemplate(ctx.db, t, 'file');
    const again = storeTemplate(ctx.db, { ...t, version: 11 }, 'file');
    expect(again.id).toBe(first.id);
    expect(again.version).toBe(11);
    const exported = exportForOtherTool(t);
    expect(exported).not.toHaveProperty('x_conveyor');
    const original = fixture('templates/ashworth-cbo.json') as Record<string, unknown>;
    for (const k of Object.keys(original)) expect(exported).toHaveProperty(k);
    expect(exported.adset).toEqual(original.adset);
    expect(exported.adset_variants).toEqual(original.adset_variants);
    void ctx.close();
  });

  it('fills name patterns and parses age bands', () => {
    expect(fillPattern('{{date}}_{{template}}', { date: '2026-09-17', template: 'Whitcombe (CBO) 1.6' })).toBe('2026-09-17_Whitcombe (CBO) 1.6');
    expect(fillPattern('{{campaign}} – {{variation}}', { campaign: 'C', variation: 'US - Broad' })).toBe('C – US - Broad');
    expect(parseAgeBand('25-44')).toEqual({ ok: true, range: [25, 44] });
    expect(parseAgeBand('')).toEqual({ ok: true, range: null });
    expect(parseAgeBand('young adults')).toMatchObject({ ok: false });
    expect(parseAgeBand('70-80')).toMatchObject({ ok: false });
  });
});

describe('interests from ad set names', () => {
  it('reads the four name shapes', () => {
    expect(interestFromName('US - Broad')).toEqual({ kind: 'broad' });
    expect(interestFromName('US - broad 1')).toEqual({ kind: 'broad' });
    expect(interestFromName('US - Formal Wear')).toEqual({ kind: 'lookup', label: 'Formal Wear' });
    expect(interestFromName('US - Interest 1')).toEqual({ kind: 'placeholder', label: 'Interest 1' });
    expect(interestFromName('Ad set 4')).toEqual({ kind: 'none' });
    expect(interestFromName('UK – Running Shoes')).toEqual({ kind: 'lookup', label: 'Running Shoes' });
  });

  it('one batch looks up every uncached label, accepts only an exact case-insensitive match, caches suggestions, and a pick is reused', async () => {
    const ff = fakeFetch({ 'graph.facebook.com/v26.0/': () => json(fixture('meta/search-adinterest.json')) });
    const ctx = testContext(ff.impl);
    await ctx.secrets.set('meta_access_token', 'EAAtoken00000000000000000');
    const client = new MetaClient({ ledger: ctx.ledger, secrets: ctx.secrets });
    const r = await findInterests(client, ctx.db, ['Formal Wear', 'Loafers'], { productId: 1 });
    expect(r).toEqual({ requests: 1, matched: ['formal wear'], unmatched: ['loafers'] });
    const batch = JSON.parse(ff.calls[0]!.form!.batch as string) as { relative_url: string }[];
    expect(batch).toHaveLength(2);
    expect(batch[0]!.relative_url).toBe('search?type=adinterest&q=formal%20wear&limit=5');

    const formal = resolveVariantInterests(ctx.db, { name: 'US - Formal Wear', country: '', age_band: '', interests: [], custom_audiences: [] });
    expect(formal).toMatchObject({ kind: 'lookup', interests: [{ id: '6003290737525', name: 'Formal wear' }] });
    const loafers = resolveVariantInterests(ctx.db, { name: 'US - Loafers', country: '', age_band: '', interests: [], custom_audiences: [] });
    expect(loafers.kind).toBe('unmatched');
    expect(loafers.suggestions).toHaveLength(2);

    // Second call: everything cached, 0 requests.
    expect((await findInterests(client, ctx.db, ['formal wear', 'LOAFERS'], {})).requests).toBe(0);
    expect(ff.calls).toHaveLength(1);

    pickInterest(ctx.db, 'Loafers', { id: '6003394817', name: 'Loafers (footwear)' });
    expect(resolveVariantInterests(ctx.db, { name: 'US - Loafers', country: '', age_band: '', interests: [], custom_audiences: [] })).toMatchObject({ kind: 'picked', interests: [{ id: '6003394817' }] });

    // Interests in the file are used as they are; placeholders and broad make no lookup.
    expect(resolveVariantInterests(ctx.db, { name: 'US - Anything', country: '', age_band: '', interests: [{ id: '1', name: 'X' }], custom_audiences: [] }).kind).toBe('file');
    expect(resolveVariantInterests(ctx.db, { name: 'US - Interest 2', country: '', age_band: '', interests: [], custom_audiences: [] }).kind).toBe('placeholder');
    await ctx.close();
  });
});
