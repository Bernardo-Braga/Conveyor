import { describe, expect, it } from 'vitest';
import { isShortLink, looksLikeUrl, parseLink, resolveShortLink } from '../src/suppliers/parseLink.ts';
import { LedgerClient } from '../src/http/ledgerClient.ts';
import { openDb } from '../src/db/index.ts';
import { requests } from '../src/db/schema.ts';
import { fakeFetch } from './helpers.ts';

describe('parseLink', () => {
  it('reads both AliExpress ID styles from item links', () => {
    expect(parseLink('https://www.aliexpress.com/item/1005006123456789.html')).toEqual({ platform: 'aliexpress', itemId: '1005006123456789' });
    expect(parseLink('https://www.aliexpress.us/item/3256805123456789.html?spm=a2g0o&gatewayAdapt=glo2usa')).toEqual({ platform: 'aliexpress', itemId: '3256805123456789' });
    expect(parseLink('https://pt.aliexpress.com/item/1005006123456789.html')).toEqual({ platform: 'aliexpress', itemId: '1005006123456789' });
    expect(parseLink('https://m.aliexpress.com/item/1005006123456789.html')).toEqual({ platform: 'aliexpress', itemId: '1005006123456789' });
    expect(parseLink('https://www.aliexpress.com/i/1005006123456789.html')).toEqual({ platform: 'aliexpress', itemId: '1005006123456789' });
    expect(parseLink('aliexpress.com/item/1005006123456789.html')).toEqual({ platform: 'aliexpress', itemId: '1005006123456789' });
    expect(parseLink('https://www.aliexpress.com/p/order/index.html?productId=1005006123456789')).toEqual({ platform: 'aliexpress', itemId: '1005006123456789' });
  });

  it('reads 1688 offer links', () => {
    expect(parseLink('https://detail.1688.com/offer/712345678901.html')).toEqual({ platform: '1688', itemId: '712345678901' });
    expect(parseLink('https://m.1688.com/offer/712345678901.html?a=1')).toEqual({ platform: '1688', itemId: '712345678901' });
    expect(parseLink('https://detail.1688.com/offer/712345678901.html?offerId=999')).toEqual({ platform: '1688', itemId: '712345678901' });
  });

  it('returns null for anything else, so nothing is fetched', () => {
    expect(parseLink('https://www.amazon.com/dp/B000')).toBeNull();
    expect(parseLink('https://www.aliexpress.com/store/1234')).toBeNull();
    expect(parseLink('https://notaliexpress.com/item/1005006123456789.html')).toBeNull();
    expect(parseLink('blue ceramic mug')).toBeNull();
    expect(parseLink('')).toBeNull();
  });

  it('spots short links and product names', () => {
    expect(isShortLink('https://a.aliexpress.com/_mNc0Zl')).toBe(true);
    expect(isShortLink('https://www.aliexpress.com/item/1005006123456789.html')).toBe(false);
    expect(looksLikeUrl('https://a.aliexpress.com/_mNc0Zl')).toBe(true);
    expect(looksLikeUrl('detail.1688.com/offer/712345678901.html')).toBe(true);
    expect(looksLikeUrl('blue ceramic mug')).toBe(false);
  });

  it('resolves a short link with one request that never touches RapidAPI', async () => {
    const { db } = openDb(':memory:');
    const ff = fakeFetch({ 'a.aliexpress.com': () => Object.defineProperty(new Response(''), 'url', { value: 'https://www.aliexpress.com/item/1005006123456789.html?x=1' }) });
    const ledger = new LedgerClient({ db, fetchImpl: ff.impl });
    const resolved = await resolveShortLink(ledger, 'https://a.aliexpress.com/_mNc0Zl');
    expect(parseLink(resolved!)).toEqual({ platform: 'aliexpress', itemId: '1005006123456789' });
    const rows = db.select().from(requests).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service: 'other', purpose: 'short_link' });
    expect(rows[0]!.url).not.toContain('rapidapi');
  });
});
