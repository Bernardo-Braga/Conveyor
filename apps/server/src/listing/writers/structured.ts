import fs from 'node:fs/promises';
import path from 'node:path';
import type { ListingWriterId } from '@conveyor/shared';
import { WRITER_LABELS } from '@conveyor/shared';
import { childEnv } from './childEnv.ts';
import { claudeCodeArgs, lastJsonLine, stripFence } from './claudeCode.ts';
import { codexArgs } from './codex.ts';
import { runCli as defaultRunCli } from './runCli.ts';
import { WriterError, looksLikeUsageLimit, type RunCli } from './types.ts';

export interface StructuredRequest {
  /** Folder the CLI runs in. Files the prompt refers to must already be there. */
  dir: string;
  prompt: string;
  schema: Record<string, unknown>;
}

/**
 * One structured run on a local writer, for jobs other than a listing: the import-profile
 * mapping and the optional creative check. Same flags, same
 * key stripping, same usage-limit hand-off as the listing writers.
 */
export async function structuredRun(writer: ListingWriterId, req: StructuredRequest, opts: { run?: RunCli; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ output: unknown; writer: ListingWriterId }> {
  const run = opts.run ?? defaultRunCli;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const env = childEnv(opts.env);
  await fs.mkdir(req.dir, { recursive: true });
  if (writer === 'claude_code') {
    const res = await run('claude', claudeCodeArgs(req.prompt, JSON.stringify(req.schema)), { cwd: req.dir, env, timeoutMs });
    if (res.timedOut) throw new WriterError(`Claude Code did not finish within ${Math.round(timeoutMs / 1000)}s.`, writer, false, true);
    let out: { is_error?: boolean; result?: string; structured_output?: unknown };
    try {
      out = JSON.parse(lastJsonLine(res.stdout));
    } catch {
      const why = res.stderr.trim() || `exit code ${res.code}`;
      throw new WriterError(`Claude Code returned no JSON: ${why}`, writer, looksLikeUsageLimit(why), true);
    }
    if (out.is_error) throw new WriterError(`Claude Code reported an error: ${out.result ?? 'unknown'}`, writer, looksLikeUsageLimit(out.result ?? ''), false);
    return { output: out.structured_output ?? (out.result ? JSON.parse(stripFence(out.result)) : null), writer };
  }
  if (writer === 'codex') {
    const schemaPath = path.join(req.dir, 'schema.json');
    const replyPath = path.join(req.dir, 'reply.json');
    await fs.writeFile(schemaPath, JSON.stringify(req.schema));
    await fs.rm(replyPath, { force: true });
    const res = await run('codex', codexArgs(req.dir, req.prompt, schemaPath, replyPath), { cwd: req.dir, env, timeoutMs });
    if (res.timedOut) throw new WriterError(`Codex did not finish within ${Math.round(timeoutMs / 1000)}s.`, writer, false, true);
    const reply = await fs.readFile(replyPath, 'utf8').catch(() => '');
    if (!reply.trim()) {
      const why = res.stderr.trim().slice(-400) || `exit code ${res.code}`;
      throw new WriterError(`Codex wrote no reply: ${why}`, writer, looksLikeUsageLimit(why), true);
    }
    return { output: JSON.parse(stripFence(reply)), writer };
  }
  throw new WriterError(`${WRITER_LABELS[writer]} is not available for structured runs.`, writer);
}

/** Preferred writer first; a usage limit hands off to the other local writer. */
export async function structuredRunWithFallback(preferred: ListingWriterId, req: StructuredRequest, opts: { run?: RunCli; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ output: unknown; writer: ListingWriterId }> {
  const order: ListingWriterId[] = preferred === 'codex' ? ['codex', 'claude_code'] : ['claude_code', 'codex'];
  let last: WriterError | null = null;
  for (const w of order) {
    try {
      return await structuredRun(w, req, opts);
    } catch (err) {
      if (err instanceof WriterError && err.usageLimit) {
        last = err;
        continue;
      }
      throw err;
    }
  }
  throw last ?? new WriterError('No writer available.', preferred);
}
