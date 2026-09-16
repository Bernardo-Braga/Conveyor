import { z } from 'zod';

/** Product states, PLAN.md section 5. `from_shopify` is equivalent to `editing_in_shopify`. */
export const PRODUCT_STATES = [
  'importing',
  'writing_listing',
  'editing_in_shopify',
  'from_shopify',
  'generating',
  'review',
  'ready_to_launch',
  'paused_in_meta',
  'live',
  'needs_attention',
] as const;
export const ProductState = z.enum(PRODUCT_STATES);
export type ProductState = z.infer<typeof ProductState>;

export const Platform = z.enum(['aliexpress', '1688']);
export type Platform = z.infer<typeof Platform>;

/** The four stations on the progress track, in order. */
export const STATIONS = ['import', 'listing', 'creatives', 'launch'] as const;
export type Station = (typeof STATIONS)[number];

export type StopStatus = 'done' | 'active' | 'waiting' | 'live' | 'attention' | 'todo';

/** Where a product state sits on the four-stop track. */
export function trackForState(state: ProductState): Record<Station, StopStatus> {
  const done = (n: number): Record<Station, StopStatus> => ({
    import: n > 0 ? 'done' : 'todo',
    listing: n > 1 ? 'done' : 'todo',
    creatives: n > 2 ? 'done' : 'todo',
    launch: n > 3 ? 'done' : 'todo',
  });
  switch (state) {
    case 'importing':
      return { ...done(0), import: 'active' };
    case 'writing_listing':
      return { ...done(1), listing: 'active' };
    case 'editing_in_shopify':
    case 'from_shopify':
      return { ...done(1), listing: 'waiting' };
    case 'generating':
      return { ...done(2), creatives: 'active' };
    case 'review':
      return { ...done(2), creatives: 'waiting' };
    case 'ready_to_launch':
      return { ...done(3), launch: 'waiting' };
    case 'paused_in_meta':
      return { ...done(3), launch: 'waiting' };
    case 'live':
      return { ...done(4), launch: 'live' };
    case 'needs_attention':
      return { ...done(0), import: 'attention' };
  }
}
