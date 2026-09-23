import { createHmac } from 'node:crypto';
import { VERSIONS } from '../../../../config/versions.ts';
import type { LedgerClient } from '../http/ledgerClient.ts';
import { JobStepError } from '../jobs/types.ts';
import type { Secrets } from '../secrets/keychain.ts';
import { encodeBody, parseBatchResults, type BatchOp, type BatchResult } from './batch.ts';
import { describeMetaError, explainMetaError, type MetaErrorBody } from './errors.ts';

const GRAPH = `https://graph.facebook.com/${VERSIONS.metaApi}`;

export interface MetaMeta {
  purpose: string;
  productId?: number | null;
  jobId?: number | null;
}

export class MetaApiError extends JobStepError {
  constructor(
    readonly body: MetaErrorBody | undefined,
    status: number,
    requestId: string | null,
    readonly retryAfter = false,
  ) {
    const why = describeMetaError(body, status, requestId);
    const explain = explainMetaError(body?.code, body?.error_subcode);
    super(explain ? `${why} ${explain}` : why, {
      service: 'meta',
      code: body?.code != null ? String(body.code) : String(status),
      subcode: body?.error_subcode != null ? String(body.error_subcode) : null,
      requestId: body?.fbtrace_id ?? requestId,
      suggestion: explain ?? (status >= 500 || status === 429 ? 'Retry this step in a minute.' : 'Check the field named in the message.'),
      retryable: status >= 500 || status === 429 || body?.code === 17 || body?.code === 80004,
    });
  }
}

/**
 * Thin fetch wrapper over the ledger (PLAN.md section 4). The token travels in the
 * Authorization header, never in the URL, so it never reaches the ledger. Writes go in
 * Graph batch requests; reads are single GETs. Meta's usage headers are read for backoff.
 */
export class MetaClient {
  private lastUsage: { callCount: number; totalTime: number; totalCpu: number } | null = null;

  constructor(private readonly deps: { ledger: LedgerClient; secrets: Secrets }) {}

  usage() {
    return this.lastUsage;
  }

  private async token(): Promise<string> {
    return this.deps.secrets.require('meta_access_token');
  }

  /**
   * `appsecret_proof` = HMAC-SHA256(token, app secret), sent as a query parameter when an app
   * secret is saved. Apps with "Require app secret" reject calls without it. The token itself
   * stays in the Authorization header, so neither reaches the ledger.
   */
  private async proofParams(token: string): Promise<Record<string, string>> {
    const secret = await this.deps.secrets.get('meta_app_secret');
    return secret ? { appsecret_proof: createHmac('sha256', secret).update(token).digest('hex') } : {};
  }

  private readUsage(res: Response): void {
    const raw = res.headers.get('x-app-usage') ?? res.headers.get('x-ad-account-usage');
    if (!raw) return;
    try {
      const u = JSON.parse(raw) as { call_count?: number; total_time?: number; total_cputime?: number; acc_id_util_pct?: number };
      this.lastUsage = { callCount: u.call_count ?? u.acc_id_util_pct ?? 0, totalTime: u.total_time ?? 0, totalCpu: u.total_cputime ?? 0 };
    } catch {
      /* ignore */
    }
  }

  async get<T>(path: string, params: Record<string, string | number | boolean> = {}, meta: MetaMeta): Promise<{ data: T; requestId: string | null }> {
    const url = new URL(`${GRAPH}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const token = await this.token();
    for (const [k, v] of Object.entries(await this.proofParams(token))) url.searchParams.set(k, v);
    const res = await this.deps.ledger.fetch({ service: 'meta', ...meta }, url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } }, { retries: 1, retryDelayMs: 2_000 });
    this.readUsage(res);
    const requestId = res.headers.get('x-fb-trace-id') ?? res.headers.get('x-fb-request-id');
    const body = (await res.json().catch(() => ({}))) as T & { error?: MetaErrorBody };
    if (!res.ok || body.error) throw new MetaApiError(body.error, res.status, requestId);
    return { data: body, requestId };
  }

  async post<T>(path: string, body: Record<string, unknown>, meta: MetaMeta): Promise<{ data: T; requestId: string | null }> {
    const token = await this.token();
    const res = await this.deps.ledger.fetch(
      { service: 'meta', ...meta },
      `${GRAPH}/${path.replace(/^\//, '')}`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: encodeBody({ ...body, ...(await this.proofParams(token)) }) },
      { retries: 1, retryDelayMs: 2_000 },
    );
    this.readUsage(res);
    const requestId = res.headers.get('x-fb-trace-id') ?? res.headers.get('x-fb-request-id');
    const data = (await res.json().catch(() => ({}))) as T & { error?: MetaErrorBody };
    if (!res.ok || data.error) throw new MetaApiError(data.error, res.status, requestId);
    return { data, requestId };
  }

  /**
   * One batch request: up to 50 operations, optional binary files attached by name
   * (`attached_files` on the operation, multipart field of the same name).
   *
   * Every named operation sends `omit_response_on_success: false`. Meta omits the body of an
   * operation another one depends on, returning `null` in its place, so without this the
   * campaign, ad sets and creatives come back empty and their IDs are lost (17 September 2026).
   */
  async batch(ops: BatchOp[], meta: MetaMeta, files: Record<string, { data: Buffer; filename: string; type: string }> = {}): Promise<{ results: BatchResult[]; requestId: string | null }> {
    if (ops.length === 0) return { results: [], requestId: null };
    if (ops.length > 50) throw new Error(`A batch holds at most 50 operations, got ${ops.length}`);
    const form = new FormData();
    form.set('batch', JSON.stringify(ops.map((op) => ({ method: op.method, relative_url: op.relative_url, ...(op.body ? { body: encodeBody(op.body) } : {}), ...(op.name ? { name: op.name, omit_response_on_success: false } : {}), ...(op.attached_files ? { attached_files: op.attached_files } : {}) }))));
    form.set('include_headers', 'false');
    const token = await this.token();
    for (const [k, v] of Object.entries(await this.proofParams(token))) form.set(k, v);
    for (const [name, f] of Object.entries(files)) form.append(name, new Blob([new Uint8Array(f.data)], { type: f.type }), f.filename);
    const res = await this.deps.ledger.fetch({ service: 'meta', ...meta }, `${GRAPH}/`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form }, { retries: 1, retryDelayMs: 3_000, timeoutMs: 180_000 });
    this.readUsage(res);
    const requestId = res.headers.get('x-fb-trace-id') ?? res.headers.get('x-fb-request-id');
    const raw = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok || (raw && typeof raw === 'object' && !Array.isArray(raw) && 'error' in raw)) throw new MetaApiError((raw as { error?: MetaErrorBody }).error, res.status, requestId);
    return { results: parseBatchResults(raw, ops), requestId };
  }
}

/** Error body of a failed operation inside a batch, if any. */
export function opError(r: BatchResult): MetaErrorBody | null {
  const b = r.body as { error?: MetaErrorBody } | null;
  // Meta returns null for an operation it never ran because a dependency failed, and for one that timed out.
  return b && typeof b === 'object' && b.error ? b.error : r.code >= 400 || r.code === 0 ? { message: r.code === 0 ? 'no response: the operation it depends on failed, or it timed out' : `HTTP ${r.code}`, code: r.code } : null;
}
