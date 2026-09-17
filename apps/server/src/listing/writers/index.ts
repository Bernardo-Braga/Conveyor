import { ListingWriterId, WRITER_LABELS } from '@conveyor/shared';
import type { LedgerClient } from '../../http/ledgerClient.ts';
import type { Secrets } from '../../secrets/keychain.ts';
import { apiWriter } from './api.ts';
import { claudeCodeWriter } from './claudeCode.ts';
import { codexWriter } from './codex.ts';
import { WriterError, type ListingWriter, type RunCli, type WriterRequest, type WriterRun } from './types.ts';

export * from './types.ts';
export { childEnv, keyVarsInEnvironment } from './childEnv.ts';

export interface WriterDeps {
  ledger: LedgerClient;
  secrets: Secrets;
  /** Injected by tests so no subprocess starts. */
  run?: RunCli;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export type WriterSet = Record<ListingWriterId, ListingWriter>;

export function makeWriters(deps: WriterDeps): WriterSet {
  const cli = { ...(deps.run ? { run: deps.run } : {}), ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}), ...(deps.env ? { env: deps.env } : {}) };
  return {
    claude_code: claudeCodeWriter(cli),
    codex: codexWriter(cli),
    claude_api: apiWriter({ ledger: deps.ledger, secrets: deps.secrets }),
  };
}

export interface WriterOutcome extends WriterRun {
  writer: ListingWriterId;
  /** Writers that reported a usage limit before this one ran. */
  handedOffFrom: ListingWriterId[];
}

/**
 * Runs the preferred writer and, if it reports a usage limit, hands the work to the next
 * available one (PLAN.md section 7). Only a usage limit hands off: a validation failure or a
 * crash is that writer's own error, so the same problem is not paid for twice.
 */
export async function runListingWriter(
  writers: WriterSet,
  preferred: ListingWriterId,
  req: WriterRequest,
  log: (message: string, level?: 'info' | 'warn') => void,
): Promise<WriterOutcome> {
  const order = [preferred, ...ListingWriterId.options.filter((id) => id !== preferred)];
  const handedOffFrom: ListingWriterId[] = [];
  const skipped: string[] = [];

  for (const id of order) {
    const writer = writers[id];
    const availability = await writer.available();
    if (!availability.ok) {
      skipped.push(`${WRITER_LABELS[id]}: ${availability.reason}`);
      continue;
    }
    try {
      const run = await writer.write(req);
      if (handedOffFrom.length) log(`${WRITER_LABELS[id]} finished the listing after the hand-off.`);
      return { ...run, writer: id, handedOffFrom };
    } catch (err) {
      if (err instanceof WriterError && err.usageLimit) {
        handedOffFrom.push(id);
        log(`${WRITER_LABELS[id]} hit a usage limit: ${err.message} Handing off to the next writer.`, 'warn');
        continue;
      }
      throw err;
    }
  }

  if (handedOffFrom.length) {
    throw new WriterError(`Every listing writer is at its usage limit (${handedOffFrom.map((id) => WRITER_LABELS[id]).join(', ')}). The supplier data is saved, so retrying later costs nothing.`, handedOffFrom[0]!, true, true);
  }
  throw new WriterError(`No listing writer is available. ${skipped.join(' ')}`, preferred, false, true);
}
