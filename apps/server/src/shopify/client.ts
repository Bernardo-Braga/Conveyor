import type { LedgerClient } from '../http/ledgerClient.ts';
import { JobStepError } from '../jobs/types.ts';
import type { Secrets } from '../secrets/keychain.ts';
import type { SettingsStore } from '../settings/store.ts';
import { SHOPIFY_GRAPHQL_PATH, type ShopifyTokenCache } from './token.ts';

export interface GraphqlResult<T> {
  data: T;
  requestId: string | null;
  /** Query cost, from `extensions.cost`, for the throttle. */
  cost: { requested: number; actual: number; available: number } | null;
}

/**
 * Admin GraphQL, one request per call. The client-credentials token is cached
 * (about 24 h) and retried once on a 401 with a fresh token.
 */
export class ShopifyClient {
  constructor(
    private readonly deps: { ledger: LedgerClient; secrets: Secrets; settings: SettingsStore; tokens: ShopifyTokenCache },
  ) {}

  storeDomain(): string {
    const { storeDomain } = this.deps.settings.get('connections').shopify;
    if (!storeDomain) throw new JobStepError('Shopify store domain is not set.', { service: 'shopify', suggestion: 'Add the store domain under Settings, Connections.' });
    return storeDomain;
  }

  adminUrl(shopifyProductId: string): string {
    const numeric = shopifyProductId.split('/').pop();
    return `https://admin.shopify.com/store/${this.storeDomain().replace('.myshopify.com', '')}/products/${numeric}`;
  }

  async graphql<T>(purpose: string, query: string, variables: Record<string, unknown>, meta: { productId?: number | null; jobId?: number | null } = {}): Promise<GraphqlResult<T>> {
    const storeDomain = this.storeDomain();
    const clientId = await this.deps.secrets.require('shopify_client_id');
    const clientSecret = await this.deps.secrets.require('shopify_client_secret');
    const send = async () => {
      const { token } = await this.deps.tokens.get(storeDomain, clientId, clientSecret, meta.jobId ?? null);
      return this.deps.ledger.fetch(
        { service: 'shopify', purpose, productId: meta.productId ?? null, jobId: meta.jobId ?? null },
        `https://${storeDomain}${SHOPIFY_GRAPHQL_PATH}`,
        { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': token }, body: JSON.stringify({ query, variables }) },
        { retries: 1 },
      );
    };
    let res = await send();
    if (res.status === 401) {
      this.deps.tokens.invalidate();
      res = await send();
    }
    const requestId = res.headers.get('x-request-id');
    if (!res.ok) {
      throw new JobStepError(`Shopify returned HTTP ${res.status}.`, { service: 'shopify', code: String(res.status), requestId, suggestion: res.status === 401 || res.status === 403 ? 'Check the app credentials and scopes.' : 'Try again later.', retryable: res.status === 429 || res.status >= 500 });
    }
    const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[]; extensions?: { cost?: { requestedQueryCost: number; actualQueryCost: number; throttleStatus: { currentlyAvailable: number } } } };
    if (body.errors?.length) {
      const first = body.errors[0]!;
      throw new JobStepError(`Shopify GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`, { service: 'shopify', code: first.extensions?.code ?? null, requestId, suggestion: first.extensions?.code === 'THROTTLED' ? 'Wait a moment and retry.' : 'Check the query and the app scopes.', retryable: first.extensions?.code === 'THROTTLED' });
    }
    if (body.data == null) throw new JobStepError('Shopify returned no data.', { service: 'shopify', requestId });
    const c = body.extensions?.cost;
    return { data: body.data, requestId, cost: c ? { requested: c.requestedQueryCost, actual: c.actualQueryCost, available: c.throttleStatus.currentlyAvailable } : null };
  }
}

/** "12.50" → 1250. Shopify money amounts are decimal strings. */
export function toMinor(amount: string | number | null | undefined): number | null {
  if (amount == null || amount === '') return null;
  const n = typeof amount === 'number' ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
