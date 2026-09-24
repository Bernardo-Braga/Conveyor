/**
 * The one HTTP path. Every outside request goes through
 * `LedgerClient.fetch`, which records service, purpose, product, job, status,
 * duration and quota remaining. It never records headers or bodies.
 *
 * ESLint forbids `fetch` everywhere else under apps/server and scripts.
 */
import type { LedgerService } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { requests } from '../db/schema.ts';
import type { EventBus } from '../events/bus.ts';
import { redact, safeUrl } from './redact.ts';

export interface LedgerMeta {
  service: LedgerService;
  purpose: string;
  productId?: number | null;
  jobId?: number | null;
}

export interface LedgerRequestOptions {
  /** Abort after this many milliseconds. Default 30 s. */
  timeoutMs?: number;
  /**
   * Extra attempts after the first, only for network errors, 429 or 5xx.
   * Default 0. Supplier calls use 1.
   */
  retries?: number;
  /** Wait before a retry. Default 1 s, doubled each time. */
  retryDelayMs?: number;
}

export interface LedgerDeps {
  db: Db;
  bus?: EventBus;
  /** Injected in tests. Production uses the global fetch, here and nowhere else. */
  fetchImpl?: typeof fetch;
  /** Known secret values to scrub from error text. */
  secretsForRedaction?: () => Promise<readonly string[]>;
  sleep?: (ms: number) => Promise<void>;
}

/** Headers we read for bookkeeping. Nothing else in a response's headers is ever looked at or stored. */
const QUOTA_REMAINING = ['x-ratelimit-requests-remaining'];
const QUOTA_RESET = ['x-ratelimit-requests-reset'];
const REQUEST_ID = ['request-id', 'x-request-id', 'x-fb-request-id', 'x-fb-trace-id', 'x-shopify-request-id'];

export class LedgerError extends Error {
  constructor(
    message: string,
    public readonly meta: LedgerMeta,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export class LedgerClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: LedgerDeps) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async fetch(meta: LedgerMeta, url: string | URL, init: RequestInit = {}, options: LedgerRequestOptions = {}): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const retries = options.retries ?? 0;
    let delay = options.retryDelayMs ?? 1_000;
    const method = (init.method ?? 'GET').toUpperCase();
    const recordedUrl = safeUrl(url);

    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      let res: Response | undefined;
      let failure: unknown;
      try {
        res = await this.fetchImpl(url, { ...init, signal });
      } catch (err) {
        failure = err;
      }
      const durationMs = Math.round(performance.now() - started);

      const row = {
        service: meta.service,
        purpose: meta.purpose,
        productId: meta.productId ?? null,
        jobId: meta.jobId ?? null,
        method,
        url: recordedUrl,
        status: res?.status ?? null,
        ok: res?.ok ?? false,
        durationMs,
        quotaRemaining: res ? intHeader(res, QUOTA_REMAINING) : null,
        quotaResetAt: res ? resetHeader(res) : null,
        requestId: res ? firstHeader(res, REQUEST_ID) : null,
        error: res ? (res.ok ? null : `HTTP ${res.status}`) : await this.describe(failure),
      };
      this.deps.db.insert(requests).values(row).run();
      this.deps.bus?.emit({ kind: 'ledger', service: meta.service, purpose: meta.purpose, ok: row.ok, status: row.status });

      const transient = res ? res.status === 429 || res.status >= 500 : true;
      if (res && (res.ok || !transient)) return res;
      if (attempt >= retries) {
        if (res) return res;
        throw new LedgerError(`${meta.service} ${meta.purpose}: ${row.error ?? 'request failed'}`, meta, failure);
      }
      await this.sleep(delay);
      delay *= 2;
    }
  }

  private async describe(err: unknown): Promise<string> {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const secrets = this.deps.secretsForRedaction ? await this.deps.secretsForRedaction() : [];
    return redact(text, secrets).slice(0, 500);
  }
}

function firstHeader(res: Response, names: readonly string[]): string | null {
  for (const n of names) {
    const v = res.headers.get(n);
    if (v) return v.slice(0, 128);
  }
  return null;
}

function intHeader(res: Response, names: readonly string[]): number | null {
  const v = firstHeader(res, names);
  if (v == null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** RapidAPI's reset header is seconds until reset; store it as an absolute time. */
function resetHeader(res: Response): string | null {
  const v = intHeader(res, QUOTA_RESET);
  if (v == null) return null;
  return new Date(Date.now() + v * 1000).toISOString();
}
