import { describe, expect, it } from 'vitest';
import { PRODUCT_STATES, trackForState } from '../src/index.ts';

describe('trackForState', () => {
  it('maps every state onto the four stops', () => {
    for (const s of PRODUCT_STATES) {
      const t = trackForState(s);
      expect(Object.keys(t)).toEqual(['import', 'listing', 'creatives', 'launch']);
    }
  });
  it('uses amber for the three points where the user steps in, green for live', () => {
    expect(trackForState('editing_in_shopify')).toEqual({ import: 'done', listing: 'waiting', creatives: 'todo', launch: 'todo' });
    expect(trackForState('from_shopify')).toEqual(trackForState('editing_in_shopify'));
    expect(trackForState('review')).toEqual({ import: 'done', listing: 'done', creatives: 'waiting', launch: 'todo' });
    expect(trackForState('paused_in_meta')).toEqual({ import: 'done', listing: 'done', creatives: 'done', launch: 'waiting' });
    expect(trackForState('live')).toEqual({ import: 'done', listing: 'done', creatives: 'done', launch: 'live' });
    expect(trackForState('generating').creatives).toBe('active');
    expect(trackForState('needs_attention').import).toBe('attention');
  });
});
