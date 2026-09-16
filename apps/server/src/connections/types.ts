import type { ConnectionService, ConnectionTestResult } from '@conveyor/shared';
import type { Services } from '../jobs/types.ts';
import type { ShopifyTokenCache } from '../shopify/token.ts';

export interface ConnectionDeps extends Services {
  shopifyTokens: ShopifyTokenCache;
  jobId: number | null;
}

export type ConnectionTester = (deps: ConnectionDeps) => Promise<ConnectionTestResult>;

export function result(service: ConnectionService, ok: boolean, detail: string, requests: number, requestId: string | null = null): ConnectionTestResult {
  return { service, ok, detail, requests, requestId, checkedAt: new Date().toISOString() };
}
