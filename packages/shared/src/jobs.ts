import { z } from 'zod';

/** Job types, PLAN.md section 12. Phase 1 registers only `connection_test`; later phases add the rest. */
export const JobType = z.enum([
  'connection_test',
  'import',
  'download_photos',
  'write_listing',
  'create_draft',
  'pull_product',
  'generate_batch',
  'find_interests',
  'validate_interests',
  'launch',
  'read_campaign',
  'apply_edits',
  'pull_insights',
]);
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

/** A user-facing error: names the step, quotes the service, suggests a fix. */
export const JobError = z.object({
  step: z.string(),
  message: z.string(),
  service: z.string().nullable().default(null),
  code: z.string().nullable().default(null),
  subcode: z.string().nullable().default(null),
  requestId: z.string().nullable().default(null),
  suggestion: z.string().nullable().default(null),
  retryable: z.boolean().default(false),
});
export type JobError = z.infer<typeof JobError>;

export const JobLogLine = z.object({
  at: z.string(),
  step: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  requestId: z.string().nullable().optional(),
});
export type JobLogLine = z.infer<typeof JobLogLine>;

export const JobView = z.object({
  id: z.number().int(),
  type: JobType,
  productId: z.number().int().nullable(),
  status: JobStatus,
  steps: z.array(z.string()),
  currentStep: z.string().nullable(),
  completedSteps: z.array(z.string()),
  attempts: z.number().int(),
  progress: z.record(z.string(), z.unknown()).nullable(),
  error: JobError.nullable(),
  log: z.array(JobLogLine),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type JobView = z.infer<typeof JobView>;

/** Events streamed to the browser over SSE. */
export const ServerEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hello'), at: z.string() }),
  z.object({ kind: z.literal('job'), job: JobView }),
  z.object({ kind: z.literal('log'), jobId: z.number().int(), line: JobLogLine }),
  z.object({ kind: z.literal('ledger'), service: z.string(), purpose: z.string(), ok: z.boolean(), status: z.number().int().nullable() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
