import { describe, expect, it } from 'vitest';
import { formatMoney, sentence } from '../src/lib/format.ts';

describe('formatMoney', () => {
  it('formats minor units as currency', () => {
    expect(formatMoney(10000)).toBe('$100.00');
    expect(formatMoney(2000)).toBe('$20.00');
    expect(formatMoney(1999, 'GBP', 'en-GB')).toBe('£19.99');
  });
});

describe('sentence', () => {
  it('turns snake_case into sentence case', () => {
    expect(sentence('needs_attention')).toBe('Needs attention');
    expect(sentence('live')).toBe('Live');
  });
});
