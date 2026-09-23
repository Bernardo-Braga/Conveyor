import type { ListingDraft, ListingWriterId, SourceProduct } from '@conveyor/shared';

export interface WriterRequest {
  /** The product's own folder. Photos live here and the CLI runs here. */
  dir: string;
  source: SourceProduct;
  brandVoice: string;
  /** The store's standing rules for every listing, empty when there are none. */
  instructions: string;
  /** This product's own direction for the listing, empty when there is none. */
  focus: string;
  /** Titles this store has already used, newest first, so the writer does not name a product twice. */
  recentTitles: readonly string[];
  /** Photo file names inside `dir`. */
  photos: readonly string[];
  /** Set on the second attempt, quoting what failed validation. */
  repairNote?: string;
  productId: number | null;
  jobId: number | null;
}

export interface WriterRun {
  draft: ListingDraft;
  /** Outside API requests this run made. Zero for the plan-based CLI writers. */
  apiRequests: number;
  /** Attempts made inside the writer (a repair round counts as two). */
  attempts: number;
  durationMs: number;
  /** What the writer reports it would have cost on an API, for the cost ledger. Null on the API writer's own billing. */
  reportedCostUsd: number | null;
  detail: string;
}

export interface ListingWriter {
  id: ListingWriterId;
  /** False when the CLI is missing or the key is not set; the chooser then skips it. */
  available(): Promise<{ ok: boolean; reason: string }>;
  write(req: WriterRequest): Promise<WriterRun>;
}

/** A writer failure. `usageLimit` is the only kind that hands off to the other writer. */
export class WriterError extends Error {
  constructor(
    message: string,
    readonly writer: ListingWriterId,
    readonly usageLimit = false,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'WriterError';
  }
}

/** Matches the plan-limit wording both CLIs use. Kept in one place so both writers agree. */
const USAGE_LIMIT = /(usage limit|rate limit|quota|too many requests|limit reached|out of (?:credits|tokens)|upgrade to continue|resets? at|try again (?:later|in))/i;

export function looksLikeUsageLimit(text: string): boolean {
  return USAGE_LIMIT.test(text);
}

/** How a CLI is run. Tests inject a fake so no subprocess starts. */
export type RunCli = (
  file: string,
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>;
