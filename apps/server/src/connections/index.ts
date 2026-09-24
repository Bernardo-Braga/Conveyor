import { z } from 'zod';
import { ConnectionService, type ConnectionTestResult, type ConnectionStatus, type SecretName } from '@conveyor/shared';
import { connectionChecks } from '../db/schema.ts';
import { MissingSecretError, LABELS } from '../secrets/keychain.ts';
import type { JobDefinition, Services } from '../jobs/types.ts';
import type { ShopifyTokenCache } from '../shopify/token.ts';
import { testClaude } from './claude.ts';
import { testClaudeCode } from './claudeCode.ts';
import { testCodex } from './codex.ts';
import { testMeta } from './meta.ts';
import { testOpenAI } from './openai.ts';
import { testShopify } from './shopify.ts';
import type { ConnectionDeps, ConnectionTester } from './types.ts';

export const TESTERS: Partial<Record<ConnectionService, ConnectionTester>> = {
  claude_code: testClaudeCode,
  claude: testClaude,
  openai: testOpenAI,
  shopify: testShopify,
  meta: testMeta,
  codex: testCodex,
  // rapidapi: no test. Its status comes from the last import.
};

/** What must be set before a test can run. The plan-based CLIs need no key at all. */
const REQUIRED_SECRETS: Record<ConnectionService, SecretName[]> = {
  claude_code: [],
  claude: ['claude_api_key'],
  openai: ['openai_api_key'],
  shopify: ['shopify_client_id', 'shopify_client_secret'],
  meta: ['meta_access_token'],
  codex: [],
  rapidapi: ['rapidapi_key'],
};

/** Services Conveyor works without. The UI marks them so a blank row does not look broken. */
export const OPTIONAL_SERVICES: ReadonlySet<ConnectionService> = new Set(['claude', 'openai']);

export async function runConnectionTest(service: ConnectionService, deps: ConnectionDeps): Promise<ConnectionTestResult> {
  const tester = TESTERS[service];
  if (!tester) return { service, ok: false, detail: 'RapidAPI has no test. Its status comes from the last import.', requests: 0, requestId: null, checkedAt: new Date().toISOString() };
  let res: ConnectionTestResult;
  try {
    res = await tester(deps);
  } catch (err) {
    if (err instanceof MissingSecretError) res = { service, ok: false, detail: err.message, requests: 0, requestId: null, checkedAt: new Date().toISOString() };
    else throw err;
  }
  deps.db
    .insert(connectionChecks)
    .values({ service, ok: res.ok, detail: res.detail, checkedAt: res.checkedAt, requestId: res.requestId, requests: res.requests })
    .onConflictDoUpdate({ target: connectionChecks.service, set: { ok: res.ok, detail: res.detail, checkedAt: res.checkedAt, requestId: res.requestId, requests: res.requests } })
    .run();
  return res;
}

export async function connectionStatuses(services: Services): Promise<ConnectionStatus[]> {
  const secretStatus = new Map((await services.secrets.status()).map((s) => [s.name, s.set]));
  const conn = services.settings.get('connections');
  const last = new Map(services.db.select().from(connectionChecks).all().map((r) => [r.service, r]));
  return ConnectionService.options.map((service) => {
    const missing = REQUIRED_SECRETS[service].filter((n) => !secretStatus.get(n)).map((n) => LABELS[n]);
    if (service === 'shopify' && !conn.shopify.storeDomain) missing.push('Store domain');
    const l = last.get(service);
    return {
      service,
      configured: missing.length === 0,
      missing,
      last: l ? { service, ok: l.ok, detail: l.detail, checkedAt: l.checkedAt, requestId: l.requestId, requests: l.requests } : null,
    };
  });
}

export const ConnectionTestInput = z.object({ service: ConnectionService });
export type ConnectionTestInput = z.infer<typeof ConnectionTestInput>;

/** The `connection_test` job: one step, one read-only call. */
export function connectionTestJob(shopifyTokens: ShopifyTokenCache): JobDefinition<ConnectionTestInput> {
  return {
    type: 'connection_test',
    input: ConnectionTestInput,
    steps: [
      {
        name: 'check',
        async run(ctx) {
          ctx.log(`Testing ${ctx.input.service}`);
          const res = await runConnectionTest(ctx.input.service, { ...ctx, shopifyTokens, jobId: ctx.jobId });
          ctx.log(res.detail, res.ok ? 'info' : 'warn', res.requestId);
          ctx.progress({ result: res });
          return res;
        },
      },
    ],
  };
}
