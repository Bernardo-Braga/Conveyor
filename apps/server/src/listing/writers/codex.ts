import fs from 'node:fs/promises';
import path from 'node:path';
import { listingPrompt } from '../prompt.ts';
import { childEnv } from './childEnv.ts';
import { runCli as defaultRunCli } from './runCli.ts';
import { listingJsonSchemaString } from './schema.ts';
import { validate } from './claudeCode.ts';
import { WriterError, looksLikeUsageLimit, type ListingWriter, type RunCli, type WriterRequest, type WriterRun } from './types.ts';

/**
 * Flags, and why:
 * - `exec` non-interactive, `--skip-git-repo-check` because a product folder is not a repo.
 * - `--ephemeral` keeps listing runs out of the user's session history.
 * - `--sandbox read-only` the writer only reads photos; it must not write.
 * - `--ignore-user-config` drops the user's MCP servers and plugins, which have been reported
 *   to make `--output-schema` be ignored. `--ignore-rules` drops execpolicy files.
 * - `--output-schema` plus `-o` writes the reply as JSON to a file we read back.
 * stdin must be closed by the runner or the CLI waits for it; see runCli.ts.
 */
export function codexArgs(dir: string, prompt: string, schemaPath: string, replyPath: string): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox', 'read-only',
    '--ignore-user-config',
    '--ignore-rules',
    '--cd', dir,
    '--color', 'never',
    '--output-schema', schemaPath,
    '-o', replyPath,
    prompt,
  ];
}

export interface CodexOptions {
  run?: RunCli;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function codexWriter(opts: CodexOptions = {}): ListingWriter {
  const run = opts.run ?? defaultRunCli;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const baseEnv = opts.env ?? process.env;

  return {
    id: 'codex',
    async available() {
      const res = await run('codex', ['--version'], { cwd: process.cwd(), env: childEnv(baseEnv), timeoutMs: 20_000 });
      if (res.code !== 0) return { ok: false, reason: 'Codex CLI is not installed or not on PATH.' };
      return { ok: true, reason: `Codex CLI ${res.stdout.trim().replace(/^codex-cli\s+/, '')} is installed.` };
    },
    async write(req: WriterRequest): Promise<WriterRun> {
      const started = Date.now();
      const schemaPath = path.join(req.dir, 'listing-schema.json');
      const replyPath = path.join(req.dir, 'listing-reply.json');
      await fs.writeFile(schemaPath, listingJsonSchemaString());
      let lastProblem = '';

      for (let attempt = 1; attempt <= 2; attempt++) {
        await fs.rm(replyPath, { force: true });
        const prompt = listingPrompt(req.source, req.brandVoice, req.photos, { focus: req.focus, instructions: req.instructions, recentTitles: req.recentTitles, repairNote: (attempt === 1 ? req.repairNote : lastProblem || req.repairNote) ?? '' });
        const res = await run('codex', codexArgs(req.dir, prompt, schemaPath, replyPath), { cwd: req.dir, env: childEnv(baseEnv), timeoutMs });
        if (res.timedOut) throw new WriterError(`Codex did not finish within ${Math.round(timeoutMs / 1000)}s.`, 'codex', false, true);

        const reply = await fs.readFile(replyPath, 'utf8').catch(() => '');
        if (!reply.trim()) {
          const why = (res.stderr.trim() || `exit code ${res.code}`).slice(-500);
          throw new WriterError(`Codex wrote no reply: ${why}`, 'codex', looksLikeUsageLimit(why), true);
        }
        const parsed = validate({ result: reply });
        if (parsed.error === null) {
          return { draft: parsed.draft, apiRequests: 0, attempts: attempt, durationMs: Date.now() - started, reportedCostUsd: null, detail: 'Codex on your ChatGPT plan' };
        }
        lastProblem = parsed.error;
      }
      throw new WriterError(`Codex's listing failed validation twice: ${lastProblem}`, 'codex', false, true);
    },
  };
}
