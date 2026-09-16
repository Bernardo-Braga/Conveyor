import type { Platform, SourceProduct } from '@conveyor/shared';
import { map1688 } from './map1688.ts';
import { mapAliexpress } from './mapAliexpress.ts';

export function mapItem(platform: Platform, body: unknown, source: { itemId: string; url: string }): SourceProduct {
  return platform === 'aliexpress' ? mapAliexpress(body, source) : map1688(body, source);
}
