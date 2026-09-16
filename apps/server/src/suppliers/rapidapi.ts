import type { Platform } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import type { LedgerClient } from '../http/ledgerClient.ts';
import { JobStepError } from '../jobs/types.ts';
import type { Secrets } from '../secrets/keychain.ts';
import { HOSTS } from './parseLink.ts';
import type { QuotaStore } from './quota.ts';
import { saveRaw } from './supplierRaw.ts';

export interface FetchItemResult {
  rawId: number;
  httpStatus: number;
  body: unknown;
  requestId: string | null;
}

/**
 * DataHub wraps the payload in `result` with its own `result.status.code`.
 * A 200 carrying an error code is a failed import and is not retried.
 */
export function dataHubStatus(body: unknown): { ok: boolean; code: number | string | null; message: string | null } {
  const result = (body as { result?: { status?: Record<string, unknown> } } | null)?.result;
  const status = result?.status;
  if (!status || typeof status !== 'object') return { ok: !!result, code: null, message: result ? null : 'No result in the response' };
  const code = (status.code ?? status.status ?? null) as number | string | null;
  const message = [status.msg, status.message, status.error, status.data].find((v) => typeof v === 'string' && v && !/^(success|error|ok)$/i.test(v)) as string | undefined;
  const flaggedError = typeof status.data === 'string' && /^error$/i.test(status.data);
  const ok = code == null ? !message && !flaggedError : String(code) === '200';
  return { ok, code, message: message ?? null };
}

/**
 * The single RapidAPI request per product (PLAN.md section 6, step 4).
 * Retried at most once, only for network errors, 429 or 5xx (the ledger enforces that).
 * The raw body is saved before any parsing.
 */
export class RapidApiClient {
  constructor(
    private readonly deps: { db: Db; ledger: LedgerClient; secrets: Secrets; quota: QuotaStore },
  ) {}

  async fetchItem(platform: Platform, itemId: string, meta: { productId?: number | null; jobId?: number | null } = {}): Promise<FetchItemResult> {
    const key = await this.deps.secrets.require('rapidapi_key');
    const host = HOSTS[platform];
    const res = await this.deps.ledger.fetch(
      { service: 'rapidapi', purpose: 'item_detail', productId: meta.productId ?? null, jobId: meta.jobId ?? null },
      `https://${host}/item_detail?itemId=${encodeURIComponent(itemId)}`,
      { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host, accept: 'application/json' } },
      { retries: 1, timeoutMs: 45_000 },
    );
    this.deps.quota.updateFromHeaders(platform, res.headers);
    const requestId = res.headers.get('x-request-id');
    const text = await res.text();
    const rawId = saveRaw(this.deps.db, { platform, itemId, httpStatus: res.status, body: text }); // before parsing

    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? 'Check the RapidAPI key and that the app is subscribed to this API.'
          : res.status === 429
            ? 'RapidAPI rate limit or quota reached. Wait for the reset shown under Settings, Import.'
            : res.status === 404
              ? 'The item was not found. Check the link.'
              : 'Try again later. The raw response is saved.';
      throw new JobStepError(`RapidAPI ${platform} returned HTTP ${res.status}.`, { service: 'rapidapi', code: String(res.status), requestId, suggestion: hint, retryable: res.status === 429 || res.status >= 500 });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new JobStepError(`RapidAPI ${platform} returned a body that is not JSON.`, { service: 'rapidapi', requestId, suggestion: 'The raw response is saved. Try "Refresh supplier data" later.', retryable: false });
    }
    const status = dataHubStatus(body);
    if (!status.ok) {
      throw new JobStepError(`RapidAPI ${platform} reported ${status.code ?? 'an error'}${status.message ? `: ${status.message}` : ''}.`, {
        service: 'rapidapi',
        code: status.code == null ? null : String(status.code),
        requestId,
        suggestion: 'The item may be unavailable or the ID format unsupported. Nothing is retried for this.',
        retryable: false,
      });
    }
    return { rawId, httpStatus: res.status, body, requestId };
  }
}
