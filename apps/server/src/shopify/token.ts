import { VERSIONS } from '../../../../config/versions.ts';
import type { LedgerClient } from '../http/ledgerClient.ts';
import { JobStepError } from '../jobs/types.ts';

interface CachedToken {
  storeDomain: string;
  token: string;
  expiresAt: number;
}

/** Refresh this long before Shopify's expiry (about 24 h). */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

/**
 * Client-credentials token for a Dev Dashboard app. Cached in memory only,
 * refreshed before expiry, and never written to disk or sent to the browser.
 */
export class ShopifyTokenCache {
  private cached: CachedToken | null = null;

  constructor(private readonly ledger: LedgerClient) {}

  invalidate(): void {
    this.cached = null;
  }

  async get(storeDomain: string, clientId: string, clientSecret: string, jobId: number | null = null): Promise<{ token: string; fetched: boolean }> {
    const c = this.cached;
    if (c && c.storeDomain === storeDomain && c.expiresAt - REFRESH_MARGIN_MS > Date.now()) return { token: c.token, fetched: false };

    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    const res = await this.ledger.fetch(
      { service: 'shopify', purpose: 'access_token', jobId },
      `https://${storeDomain}/admin/oauth/access_token`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body },
    );
    const requestId = res.headers.get('x-request-id');
    if (!res.ok) {
      throw new JobStepError(`Shopify refused the client credentials (HTTP ${res.status}).`, {
        service: 'shopify',
        code: String(res.status),
        requestId,
        suggestion: 'Check the store domain, client ID and client secret, and that the app is installed on the store.',
      });
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new JobStepError('Shopify returned no access token.', { service: 'shopify', requestId });
    this.cached = { storeDomain, token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 86_400) * 1000 };
    return { token: json.access_token, fetched: true };
  }
}

export const SHOPIFY_GRAPHQL_PATH = `/admin/api/${VERSIONS.shopifyAdminApi}/graphql.json`;
