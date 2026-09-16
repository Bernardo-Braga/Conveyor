import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { map1688 } from '../src/suppliers/map1688.ts';
import { mapAliexpress } from '../src/suppliers/mapAliexpress.ts';
import { dataHubStatus } from '../src/suppliers/rapidapi.ts';
import { FIXTURES, fixture } from './helpers.ts';

const ALI = path.join(FIXTURES, 'rapidapi', 'aliexpress-item.json');
const C1688 = path.join(FIXTURES, 'rapidapi', '1688-item.json');

/**
 * These run against the real responses captured by scripts/capture-rapidapi-fixtures.ts
 * (2 requests, run by the user). Until the files exist they are skipped and say so.
 */
describe.skipIf(!fs.existsSync(ALI))('mapAliexpress (captured fixture)', () => {
  it('maps a real item_detail response', () => {
    const body = fixture('rapidapi/aliexpress-item.json');
    expect(dataHubStatus(body).ok).toBe(true);
    const sp = mapAliexpress(body, { itemId: 'x', url: 'https://www.aliexpress.com/item/x.html' });
    expect(sp.title.length).toBeGreaterThan(3);
    expect(sp.images.length).toBeGreaterThan(0);
    for (const u of sp.images) expect(u).toMatch(/^https:\/\/.+\.(jpe?g|png|gif)$/i);
    expect(new Set(sp.images).size).toBe(sp.images.length);
    expect(sp.variants.length).toBeGreaterThan(0);
    for (const v of sp.variants) expect(v.costMinor).toBeGreaterThan(0);
    if (sp.options.length) for (const v of sp.variants) expect(v.optionValues.filter(Boolean).length).toBe(sp.options.length);
    expect(sp.currency).toBe('USD');
    expect(sp.source.platform).toBe('aliexpress');
  });
});

describe.skipIf(!fs.existsSync(C1688))('map1688 (captured fixture)', () => {
  it('maps a real item_detail response', () => {
    const body = fixture('rapidapi/1688-item.json');
    expect(dataHubStatus(body).ok).toBe(true);
    const sp = map1688(body, { itemId: 'x', url: 'https://detail.1688.com/offer/x.html' });
    expect(sp.title.length).toBeGreaterThan(1);
    expect(sp.images.length).toBeGreaterThan(0);
    for (const u of sp.images) expect(u).toMatch(/^https:\/\//);
    expect(sp.variants.length).toBeGreaterThan(0);
    for (const v of sp.variants) expect(v.costMinor).toBeGreaterThan(0);
    expect(sp.currency).toBe('CNY');
    expect(sp.priceTiers?.length ?? 0).toBeGreaterThan(0);
    expect(sp.moq ?? 1).toBeGreaterThan(0);
  });
});

describe('mapper fixtures', () => {
  it('reports whether the captured fixtures exist', () => {
    const missing = [ALI, C1688].filter((f) => !fs.existsSync(f)).map((f) => path.relative(FIXTURES, f));
    if (missing.length) console.warn(`Captured RapidAPI fixtures missing (run pnpm capture:fixtures): ${missing.join(', ')}`);
    expect(true).toBe(true);
  });
});
