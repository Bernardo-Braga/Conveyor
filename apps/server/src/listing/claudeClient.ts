import Anthropic from '@anthropic-ai/sdk';
import type { LedgerClient, LedgerMeta } from '../http/ledgerClient.ts';

/**
 * The official SDK for request shapes, with the ledger as its transport (CLAUDE.md hard rule 1).
 * The SDK's own retries are off; the ledger records every attempt and the job retries by step.
 */
export function claudeClient(ledger: LedgerClient, apiKey: string, meta: Omit<LedgerMeta, 'service'>): Anthropic {
  const fetchViaLedger: typeof fetch = (input, init) => ledger.fetch({ service: 'claude', ...meta }, input instanceof Request ? input.url : input, init ?? {}, { timeoutMs: 180_000, retries: 1, retryDelayMs: 2_000 });
  return new Anthropic({ apiKey, fetch: fetchViaLedger, maxRetries: 0, timeout: 180_000 });
}
