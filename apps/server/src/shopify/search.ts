import type { ShopifySearchHit } from '@conveyor/shared';
import type { ShopifyClient } from './client.ts';

export const SEARCH_QUERY = `
query ConveyorSearch($query: String, $first: Int!) {
  products(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
    nodes { id title handle status updatedAt featuredMedia { preview { image { url(transform: { maxWidth: 240, maxHeight: 240 }) } } } }
  }
}`;

interface SearchData {
  products: { nodes: { id: string; title: string; handle: string; status: string; updatedAt: string; featuredMedia: { preview: { image: { url: string } | null } | null } | null }[] };
}

/** Search the store by title (1 query). An empty box lists the newest products first. */
export async function searchShopify(client: ShopifyClient, text: string, meta: { jobId?: number | null } = {}): Promise<{ hits: Omit<ShopifySearchHit, 'onLine'>[]; requestId: string | null }> {
  const q = text.trim();
  const query = q ? `title:*${q.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}*` : null;
  const { data, requestId } = await client.graphql<SearchData>('search', SEARCH_QUERY, { query, first: 12 }, meta);
  return {
    requestId,
    hits: data.products.nodes.map((n) => ({ id: n.id, title: n.title, handle: n.handle, status: n.status, image: n.featuredMedia?.preview?.image?.url ?? null, updatedAt: n.updatedAt })),
  };
}
