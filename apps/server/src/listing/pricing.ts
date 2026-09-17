import type { ImportSettings, Pricing, SourceProduct } from '@conveyor/shared';

/**
 * Pure arithmetic, PLAN.md section 7. Money in minor units.
 * Landed cost = supplier cost (converted to USD for 1688) + agent fee + shipping estimate.
 * Price = landed cost × multiplier, rounded up to .99, then raised to keep the minimum margin.
 * Compare-at = price + markup %, also ending in .99.
 */
export function priceVariant(costMinor: number, currency: SourceProduct['currency'], settings: ImportSettings['pricing'], usdPerCny: number): Pricing {
  const notes: string[] = [];
  let cost = costMinor;
  if (currency === 'CNY') {
    cost = Math.round(costMinor * usdPerCny);
    notes.push(`Converted from CNY at ${usdPerCny} USD per CNY.`);
  }
  let landed = cost;
  if (currency === 'CNY') {
    landed += settings.agentFeeMinor1688;
    notes.push(`Added the 1688 agent fee.`);
  }
  landed += settings.shippingEstimateMinor;
  notes.push('Added the shipping estimate.');

  let price = roundUpTo99(Math.round(landed * settings.multiplier));
  if (price - landed < settings.minimumMarginMinor) {
    price = roundUpTo99(landed + settings.minimumMarginMinor);
    notes.push('Raised to keep the minimum margin.');
  }
  const compareAt = roundUpTo99(Math.round(price * (1 + settings.compareAtMarkupPercent / 100)));
  return { costMinor, landedCostMinor: landed, priceMinor: price, compareAtMinor: compareAt, marginMinor: price - landed, notes };
}

/** 1234 → 1299; 1299 → 1299; 1300 → 1399. Whole dollars end in .99. */
export function roundUpTo99(minor: number): number {
  const dollars = Math.floor(minor / 100);
  const candidate = dollars * 100 + 99;
  return candidate >= minor ? candidate : candidate + 100;
}

export function usdPerCny(settings: ImportSettings['pricing'], dailyRate: number | null): number {
  if (settings.cnyRate.mode === 'daily' && dailyRate) return dailyRate;
  return Number.parseFloat(settings.cnyRate.fixed);
}
