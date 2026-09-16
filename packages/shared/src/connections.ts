import { z } from 'zod';

/** Services with a connection test. RapidAPI has none: its status comes from the last import. */
export const ConnectionService = z.enum(['claude', 'openai', 'shopify', 'meta', 'codex', 'rapidapi']);
export type ConnectionService = z.infer<typeof ConnectionService>;

export const ConnectionTestResult = z.object({
  service: ConnectionService,
  ok: z.boolean(),
  /** Plain sentence, e.g. "Signed in as Ashworth Ltd" or the error with code and request ID. */
  detail: z.string(),
  checkedAt: z.string(),
  requestId: z.string().nullable(),
  /** Requests this test made. Confirms the budget in PLAN.md section 3. */
  requests: z.number().int(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResult>;

export const ConnectionStatus = z.object({
  service: ConnectionService,
  configured: z.boolean(),
  /** What is still missing before a test can run. */
  missing: z.array(z.string()),
  last: ConnectionTestResult.nullable(),
});
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;
