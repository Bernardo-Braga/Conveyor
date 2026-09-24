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
  /** Which endpoint answered, and how many were asked. More than one means a 205 sent us to a backup. */
  endpoint: string;
  requests: number;
}

/**
 * DataHub wraps the payload in `result` with its own `result.status.code`.
 * A 200 carrying an error code is a failed import; only a 205 is tried on another endpoint.
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
 * DataHub's "no results" code: HTTP 200 with `result.status.code` 205 and
 * "request successfully formed, but no results were found". The item exists; this endpoint
 * just could not read it, and a backup endpoint answers the same item.
 */
const NO_RESULTS = '205';

/**
 * Endpoints tried in order, first one first. The backups take the same query and return the
 * same body, so only a 205 moves on to the next one: every other failure is the item's own.
 * 1688 has no confirmed backup, so a 205 there still fails the import at once.
 */
const ENDPOINTS: Record<Platform, readonly string[]> = {
  aliexpress: ['item_detail', 'item_detail_6'],
  '1688': ['item_detail'],
};

type Attempt = { ok: true; result: FetchItemResult } | { ok: false; error: JobStepError; noResults: boolean };

/**
 * One RapidAPI request per product, plus one more only when
 * AliExpress answers 205 and the backup endpoint is tried.
 * Retried at most once, only for network errors, 429 or 5xx (the ledger enforces that).
 * The raw body is saved before any parsing, for every endpoint tried.
 */
export class RapidApiClient {
  constructor(
    private readonly deps: { db: Db; ledger: LedgerClient; secrets: Secrets; quota: QuotaStore },
  ) {}

  async fetchItem(platform: Platform, itemId: string, meta: { productId?: number | null; jobId?: number | null } = {}): Promise<FetchItemResult> {
    const key = await this.deps.secrets.require('rapidapi_key');
    const endpoints = ENDPOINTS[platform];
    for (const [i, endpoint] of endpoints.entries()) {
      const attempt = await this.call(platform, itemId, endpoint, key, meta);
      if (attempt.ok) return { ...attempt.result, endpoint, requests: i + 1 };
      // Only "no results" is worth a second endpoint. A key, quota or 404 problem repeats.
      if (attempt.noResults && i < endpoints.length - 1) continue;
      throw attempt.noResults ? withTriedEndpoints(attempt.error, endpoints) : attempt.error;
    }
    throw new JobStepError(`RapidAPI ${platform} has no item_detail endpoint configured.`, { service: 'rapidapi', retryable: false });
  }

  private async call(platform: Platform, itemId: string, endpoint: string, key: string, meta: { productId?: number | null; jobId?: number | null }): Promise<Attempt> {
    const host = HOSTS[platform];
    const res = await this.deps.ledger.fetch(
      { service: 'rapidapi', purpose: endpoint, productId: meta.productId ?? null, jobId: meta.jobId ?? null },
      `https://${host}/${endpoint}?itemId=${encodeURIComponent(itemId)}`,
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
      return { ok: false, noResults: false, error: new JobStepError(`RapidAPI ${platform} ${endpoint} returned HTTP ${res.status}.`, { service: 'rapidapi', code: String(res.status), requestId, suggestion: hint, retryable: res.status === 429 || res.status >= 500 }) };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, noResults: false, error: new JobStepError(`RapidAPI ${platform} ${endpoint} returned a body that is not JSON.`, { service: 'rapidapi', requestId, suggestion: 'The raw response is saved. Try "Refresh supplier data" later.', retryable: false }) };
    }
    const status = dataHubStatus(body);
    if (!status.ok) {
      const noResults = status.code != null && String(status.code) === NO_RESULTS;
      return {
        ok: false,
        noResults,
        error: new JobStepError(`RapidAPI ${platform} ${endpoint} reported ${status.code ?? 'an error'}${status.message ? `: ${status.message}` : ''}.`, {
          service: 'rapidapi',
          code: status.code == null ? null : String(status.code),
          requestId,
          suggestion: 'The item may be unavailable or the ID format unsupported. Nothing is retried for this.',
          retryable: false,
        }),
      };
    }
    return { ok: true, result: { rawId, httpStatus: res.status, body, requestId, endpoint, requests: 1 } };
  }
}

/** The last endpoint also found nothing: say which ones were asked, so the message is not misread as one failure. */
function withTriedEndpoints(error: JobStepError, endpoints: readonly string[]): JobStepError {
  if (endpoints.length < 2) return error;
  return new JobStepError(`${error.message} The backup endpoint${endpoints.length > 2 ? 's' : ''} found nothing either (${endpoints.join(', ')}).`, {
    ...error.details,
    suggestion: 'Every endpoint answered "no results". Check the link, or try again later: the item may be off sale. The raw responses are saved.',
  });
}
