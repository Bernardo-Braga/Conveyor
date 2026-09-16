import { describe, expect, it } from 'vitest';
import { testContext } from './helpers.ts';

describe('Secrets', () => {
  it('reports set/unset with at most the last four characters', async () => {
    const ctx = testContext();
    await ctx.secrets.set('claude_api_key', '  sk-ant-api03-abcdefgh1234  ');
    const status = await ctx.secrets.status();
    const claude = status.find((s) => s.name === 'claude_api_key')!;
    expect(claude).toMatchObject({ set: true, hint: '1234' });
    expect(claude.updatedAt).toMatch(/^\d{4}-/);
    expect(JSON.stringify(status)).not.toContain('abcdefgh');
    expect(status.find((s) => s.name === 'openai_api_key')).toMatchObject({ set: false, hint: null, updatedAt: null });
    expect(await ctx.secrets.get('claude_api_key')).toBe('sk-ant-api03-abcdefgh1234');

    await ctx.secrets.delete('claude_api_key');
    expect((await ctx.secrets.status()).find((s) => s.name === 'claude_api_key')).toMatchObject({ set: false, updatedAt: null });
    await expect(ctx.secrets.require('claude_api_key')).rejects.toThrow(/Missing key: Claude API key/);
    await ctx.close();
  });

  it('never stores a value in the database', async () => {
    const ctx = testContext();
    await ctx.secrets.set('meta_access_token', 'EAAUniqueNeedleValue987654321');
    const tables = ctx.opened.sqlite.prepare(`select name from sqlite_master where type='table'`).all() as { name: string }[];
    for (const { name } of tables) {
      const rows = ctx.opened.sqlite.prepare(`select * from "${name}"`).all();
      expect(JSON.stringify(rows), name).not.toContain('UniqueNeedle');
    }
    await ctx.close();
  });
});

describe('SettingsStore', () => {
  it('returns defaults, validates, normalises and round-trips', async () => {
    const ctx = testContext();
    expect(ctx.settings.get('connections')).toEqual({ shopify: { storeDomain: '' }, meta: { adAccountId: '', pageId: '', instagramUserId: '', pixelId: '', testAdAccountId: '' } });
    expect(ctx.settings.get('import').quotaPauseThreshold).toBe(50);
    expect(ctx.settings.get('import').pricing).toMatchObject({ multiplier: 3, compareAtMarkupPercent: 40, minimumMarginMinor: 800, agentFeeMinor1688: 250, shippingEstimateMinor: 600 });

    const saved = ctx.settings.set('connections', { shopify: { storeDomain: ' My-Store.myshopify.com ' }, meta: { adAccountId: 'act_42', access_token: 'EAAdropme' } });
    expect(saved.shopify.storeDomain).toBe('my-store.myshopify.com');
    expect(saved.meta.adAccountId).toBe('act_42');
    expect(JSON.stringify(ctx.settings.get('connections'))).not.toContain('dropme');

    expect(() => ctx.settings.set('connections', { shopify: { storeDomain: 'https://x.myshopify.com' } })).toThrow();
    expect(() => ctx.settings.set('connections', { meta: { adAccountId: '42' } })).toThrow();
    await ctx.close();
  });
});
