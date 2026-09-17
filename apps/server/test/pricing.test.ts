import { describe, expect, it } from 'vitest';
import { ImportSettings } from '@conveyor/shared';
import { priceVariant, roundUpTo99, usdPerCny } from '../src/listing/pricing.ts';

const defaults = ImportSettings.parse({}).pricing;

describe('roundUpTo99', () => {
  it('rounds up to the next .99', () => {
    expect(roundUpTo99(1234)).toBe(1299);
    expect(roundUpTo99(1299)).toBe(1299);
    expect(roundUpTo99(1300)).toBe(1399);
    expect(roundUpTo99(0)).toBe(99);
  });
});

describe('priceVariant', () => {
  it('USD: landed = cost + shipping; price = landed × 3 rounded up to .99; compare-at +40%', () => {
    const p = priceVariant(2903, 'USD', defaults, 0.14);
    expect(p.landedCostMinor).toBe(2903 + 600);
    expect(p.priceMinor).toBe(roundUpTo99(Math.round(3503 * 3))); // 10509 → 10599
    expect(p.priceMinor).toBe(10599);
    expect(p.compareAtMinor).toBe(roundUpTo99(Math.round(10599 * 1.4))); // 14838.6 → 14899
    expect(p.marginMinor).toBe(10599 - 3503);
  });

  it('1688: converts CNY, adds the agent fee and shipping', () => {
    const p = priceVariant(3500, 'CNY', defaults, 0.14); // ¥35.00 → $4.90
    expect(p.landedCostMinor).toBe(490 + 250 + 600);
    expect(p.priceMinor).toBe(roundUpTo99(Math.round(1340 * 3))); // 4020 → 4099
    expect(p.notes.some((n) => n.includes('CNY'))).toBe(true);
  });

  it('enforces the minimum margin on cheap items', () => {
    const p = priceVariant(50, 'USD', { ...defaults, multiplier: 1.1 }, 0.14); // landed 650, ×1.1 = 715 → 799, margin 149 < 800
    expect(p.priceMinor).toBe(roundUpTo99(650 + 800));
    expect(p.marginMinor).toBeGreaterThanOrEqual(800);
    expect(p.notes.some((n) => n.includes('minimum margin'))).toBe(true);
  });

  it('usdPerCny prefers the daily rate only when the mode says so', () => {
    expect(usdPerCny(defaults, 0.1387)).toBe(0.14);
    expect(usdPerCny({ ...defaults, cnyRate: { mode: 'daily', fixed: '0.14' } }, 0.1387)).toBe(0.1387);
    expect(usdPerCny({ ...defaults, cnyRate: { mode: 'daily', fixed: '0.14' } }, null)).toBe(0.14);
  });
});
