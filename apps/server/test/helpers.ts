import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, type AppContext } from '../src/context.ts';
import { MemoryStore } from '../src/secrets/keychain.ts';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures');

export function fixture(rel: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'));
}

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export type Route = (req: Recorded) => Response | Promise<Response>;

/**
 * A fake `fetch` that records every call and answers from the given routes.
 * Tests never call outside services (CLAUDE.md hard rule 2).
 */
export function fakeFetch(routes: Record<string, Route> = {}) {
  const calls: Recorded[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => (headers[k] = v));
    const b = init?.body;
    const body = b == null ? null : typeof b === 'string' ? b : b instanceof URLSearchParams ? b.toString() : '[binary]';
    const rec: Recorded = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, body };
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

export function testContext(fetchImpl?: typeof fetch): AppContext & { store: MemoryStore } {
  const store = new MemoryStore();
  const ctx = createContext({ dbFile: ':memory:', secretStore: store, ...(fetchImpl ? { fetchImpl } : {}) });
  return Object.assign(ctx, { store });
}
