import { JobStepError } from '../jobs/types.ts';
import { SHOPIFY_GRAPHQL_PATH } from '../shopify/token.ts';
import { result, type ConnectionTester } from './types.ts';

const SHOP_QUERY = `{ shop { name myshopifyDomain currencyCode plan { displayName } } }`;

/**
 * One read-only GraphQL query. The client-credentials exchange adds one request the
 * first time (then the token is cached for about 24 h).
 */
export const testShopify: ConnectionTester = async (deps) => {
  const { ledger, secrets, settings, shopifyTokens, jobId } = deps;
  const { storeDomain } = settings.get('connections').shopify;
  if (!storeDomain) return result('shopify', false, 'Add the store domain (my-store.myshopify.com) under Connections.', 0);
  const clientId = await secrets.require('shopify_client_id');
  const clientSecret = await secrets.require('shopify_client_secret');

  let requests = 0;
  let tokenResult: Awaited<ReturnType<typeof shopifyTokens.get>>;
  try {
    tokenResult = await shopifyTokens.get(storeDomain, clientId, clientSecret, jobId);
  } catch (err) {
    if (err instanceof JobStepError) return result('shopify', false, `${err.message} ${err.details.suggestion ?? ''}`.trim(), 1, err.details.requestId);
    throw err;
  }
  requests += tokenResult.fetched ? 1 : 0;

  const res = await ledger.fetch(
    { service: 'shopify', purpose: 'connection_test', jobId },
    `https://${storeDomain}${SHOPIFY_GRAPHQL_PATH}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': tokenResult.token },
      body: JSON.stringify({ query: SHOP_QUERY }),
    },
  );
  requests += 1;
  const requestId = res.headers.get('x-request-id');
  if (res.status === 401) shopifyTokens.invalidate();
  if (!res.ok) return result('shopify', false, `Shopify returned HTTP ${res.status}${requestId ? ` (request ${requestId})` : ''}. Check the app's scopes and that it is installed.`, requests, requestId);

  const body = (await res.json()) as { data?: { shop?: { name?: string; myshopifyDomain?: string; currencyCode?: string; plan?: { displayName?: string } } }; errors?: { message: string }[] };
  if (body.errors?.length) return result('shopify', false, `Shopify GraphQL error: ${body.errors.map((e) => e.message).join('; ')}${requestId ? ` (request ${requestId})` : ''}.`, requests, requestId);
  const shop = body.data?.shop;
  return result('shopify', true, `Connected to ${shop?.name ?? storeDomain} (${shop?.myshopifyDomain ?? storeDomain}, ${shop?.currencyCode ?? '?'}).`, requests, requestId);
};
