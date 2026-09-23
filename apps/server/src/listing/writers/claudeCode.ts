import { ListingWire, foldListing, type ListingDraft } from '@conveyor/shared';
import { VERSIONS } from '../../../../../config/versions.ts';
import { listingJsonSchemaString } from './schema.ts';
import { listingPrompt } from '../prompt.ts';
import { childEnv } from './childEnv.ts';
import { runCli as defaultRunCli } from './runCli.ts';
import { WriterError, looksLikeUsageLimit, type ListingWriter, type RunCli, type WriterRequest, type WriterRun } from './types.ts';

/** The shape `claude -p --output-format json` prints. Confirmed against Claude Code 2.1.273. */
interface ClaudeCodeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  num_turns?: number;
  total_cost_usd?: number;
  api_error_status?: unknown;
  permission_denials?: unknown[];
}

/**
 * Flags, in order and why each one is here:
 * - `-p` print mode, `--output-format json` so the result is machine-readable.
 * - `--json-schema` asks for structured output; Zod still validates it.
 * - `--model` the pinned alias.
 * - `--tools Read` removes every other built-in tool, not just its permission.
 * - `--permission-mode dontAsk` and `--permission-prompts none` so nothing can block unattended.
 * - `--strict-mcp-config --mcp-config {}` ignores the user's MCP servers.
 * - `--restricted` ignores user, project and local settings files and confines file tools here.
 * - `--disable-slash-commands` so a skill cannot be triggered by the product text.
 * - `--no-session-persistence` keeps listing runs out of the user's session history.
 * - Never `--bare`: bare mode reads only an API key and never the plan login.
 */
export function claudeCodeArgs(prompt: string, schema: string): string[] {
  return [
    '-p', prompt,
    '--output-format', 'json',
    '--json-schema', schema,
    '--model', VERSIONS.writers.claudeCodeModel,
    '--tools', 'Read',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--restricted',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
}

export interface ClaudeCodeOptions {
  run?: RunCli;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function claudeCodeWriter(opts: ClaudeCodeOptions = {}): ListingWriter {
  const run = opts.run ?? defaultRunCli;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const baseEnv = opts.env ?? process.env;

  return {
    id: 'claude_code',
    async available() {
      const res = await run('claude', ['auth', 'status'], { cwd: process.cwd(), env: childEnv(baseEnv), timeoutMs: 20_000 });
      if (res.code !== 0) return { ok: false, reason: 'Claude Code is not installed or not on PATH. Install it and run "claude auth login".' };
      const status = parseAuthStatus(res.stdout);
      if (!status?.loggedIn) return { ok: false, reason: 'Claude Code is installed but not signed in. Run "claude auth login".' };
      if (status.authMethod && status.authMethod !== 'claude.ai') return { ok: false, reason: `Claude Code is signed in with ${status.authMethod}, not a Claude plan. Conveyor's writer must use the plan login.` };
      return { ok: true, reason: `Signed in with a ${status.subscriptionType ?? 'Claude'} plan.` };
    },
    async write(req: WriterRequest): Promise<WriterRun> {
      const started = Date.now();
      let cost = 0;
      let lastProblem = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        const prompt = listingPrompt(req.source, req.brandVoice, req.photos, { focus: req.focus, instructions: req.instructions, recentTitles: req.recentTitles, repairNote: (attempt === 1 ? req.repairNote : lastProblem || req.repairNote) ?? '' });
        const res = await run('claude', claudeCodeArgs(prompt, listingJsonSchemaString()), { cwd: req.dir, env: childEnv(baseEnv), timeoutMs });
        if (res.timedOut) throw new WriterError(`Claude Code did not finish within ${Math.round(timeoutMs / 1000)}s.`, 'claude_code', false, true);

        let out: ClaudeCodeResult;
        try {
          out = JSON.parse(lastJsonLine(res.stdout)) as ClaudeCodeResult;
        } catch {
          const why = res.stderr.trim() || res.stdout.trim().slice(0, 300) || `exit code ${res.code}`;
          throw new WriterError(`Claude Code returned no JSON result: ${why}`, 'claude_code', looksLikeUsageLimit(why), true);
        }
        cost += out.total_cost_usd ?? 0;
        if (out.is_error) {
          const why = (out.result ?? out.subtype ?? 'unknown error').slice(0, 500);
          throw new WriterError(`Claude Code reported an error: ${why}`, 'claude_code', looksLikeUsageLimit(why), false);
        }

        const parsed = validate(out);
        if (parsed.error === null) {
          return { draft: parsed.draft, apiRequests: 0, attempts: attempt, durationMs: Date.now() - started, reportedCostUsd: cost, detail: `Claude Code, ${out.num_turns ?? 1} turn(s)` };
        }
        lastProblem = parsed.error;
      }
      throw new WriterError(`Claude Code's listing failed validation twice: ${lastProblem}`, 'claude_code', false, true);
    },
  };
}

function parseAuthStatus(stdout: string): { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } | null {
  try {
    return JSON.parse(lastJsonLine(stdout)) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
  } catch {
    return null;
  }
}

/** The CLI may print notices before the JSON; take the last balanced JSON object. */
export function lastJsonLine(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const lines = trimmed.split('\n').filter((l) => l.trim().startsWith('{'));
  if (lines.length) return lines[lines.length - 1]!.trim();
  const start = trimmed.indexOf('{');
  return start >= 0 ? trimmed.slice(start) : trimmed;
}

/** Structured output is a hint; Zod decides. Falls back to the text result if the field is missing. */
export function validate(out: { structured_output?: unknown; result?: string }): { error: null; draft: ListingDraft } | { error: string; draft?: undefined } {
  let candidate: unknown = out.structured_output;
  if (candidate == null && out.result) {
    try {
      candidate = JSON.parse(stripFence(out.result));
    } catch {
      return { error: 'the reply was not JSON' };
    }
  }
  if (candidate == null) return { error: 'the reply contained no JSON' };
  const wire = ListingWire.safeParse(candidate);
  if (!wire.success) return { error: describeIssues(wire.error.issues) };
  try {
    return { error: null, draft: foldListing(wire.data) };
  } catch (err) {
    return { error: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
  }
}

export function stripFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1]! : text).trim();
}

export function describeIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.slice(0, 5).map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ');
}
