import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, type AppContext } from '../src/context.ts';
import { MemoryStore } from '../src/secrets/keychain.ts';
import type { RunCli } from '../src/listing/writers/index.ts';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures');

export function fixture(rel: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'));
}

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  /** Multipart fields when the body was FormData: files appear as `{ name, type, size }`. */
  form: Record<string, string | { name: string; type: string; size: number }[]> | null;
}

export type Route = (req: Recorded) => Response | Promise<Response>;

/**
 * A fake `fetch` that records every call and answers from the given routes.
 * Tests never call outside services.
 */
export function fakeFetch(routes: Record<string, Route> = {}) {
  const calls: Recorded[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => (headers[k] = v));
    const b = init?.body;
    const body = b == null ? null : typeof b === 'string' ? b : b instanceof URLSearchParams ? b.toString() : '[binary]';
    let form: Recorded['form'] = null;
    if (b instanceof FormData) {
      form = {};
      for (const [k, v] of b.entries()) {
        if (typeof v === 'string') form[k] = v;
        else {
          const files = (form[k] as { name: string; type: string; size: number }[] | undefined) ?? [];
          files.push({ name: v.name, type: v.type, size: v.size });
          form[k] = files;
        }
      }
    }
    const rec: Recorded = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, body, form };
    calls.push(rec);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new TypeError(`fetch failed: no route for ${url}`);
    return routes[key]!(rec);
  };
  return { impl, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export interface TestOptions {
  fetchImpl?: typeof fetch;
  /** Fake CLI runner so no Claude Code or Codex subprocess ever starts in a test. */
  runCli?: RunCli;
}

/**
 * A fully isolated app: in-memory database, in-memory secrets, a fake fetch and a fake CLI
 * runner, and its own temporary data directory. Closing it removes the directory.
 */
export function testContext(fetchImpl?: typeof fetch, opts: TestOptions = {}): AppContext & { store: MemoryStore; dataDir: string } {
  const store = new MemoryStore();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-test-'));
  const impl = fetchImpl ?? opts.fetchImpl;
  // Tests never start a real subprocess. Without an injected runner,
  // both CLIs report themselves as missing so a writer can never actually run.
  const runCli: RunCli = opts.runCli ?? (async (file) => ({ stdout: '', stderr: `${file} is not available in tests`, code: 127, timedOut: false }));
  const ctx = createContext({ dbFile: ':memory:', secretStore: store, dataDir, runCli, ...(impl ? { fetchImpl: impl } : {}) });
  const close = ctx.close.bind(ctx);
  ctx.close = async () => {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return Object.assign(ctx, { store, dataDir });
}

/** Records every CLI invocation and answers from handlers, so writers are testable offline. */
export interface CliCall {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type CliHandler = (call: CliCall) => Promise<CliReply> | CliReply;
export interface CliReply {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  timedOut?: boolean;
  /** Files to write into cwd before returning, for codex's -o reply file. */
  files?: Record<string, string>;
}

export function fakeCli(handlers: { claude?: CliHandler; codex?: CliHandler } = {}) {
  const calls: CliCall[] = [];
  const run: RunCli = async (file, args, o) => {
    const call: CliCall = { file, args: [...args], cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs };
    calls.push(call);
    const handler = file === 'claude' ? handlers.claude : handlers.codex;
    if (!handler) return { stdout: '', stderr: `no fake handler for ${file}`, code: 127, timedOut: false };
    const reply = await handler(call);
    for (const [name, body] of Object.entries(reply.files ?? {})) fs.writeFileSync(path.join(o.cwd, name), body);
    return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', code: reply.code ?? 0, timedOut: reply.timedOut ?? false };
  };
  return { run, calls, of: (file: string) => calls.filter((c) => c.file === file) };
}

/** The JSON `claude -p --output-format json` prints on success. */
export function claudeResult(structured: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.03, result: JSON.stringify(structured), structured_output: structured, ...extra });
}

export function claudeAuthOk(): string {
  return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' });
}
