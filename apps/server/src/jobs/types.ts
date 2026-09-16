import type { z } from 'zod';
import type { JobError, JobLogLine, JobType } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import type { EventBus } from '../events/bus.ts';
import type { LedgerClient } from '../http/ledgerClient.ts';
import type { Secrets } from '../secrets/keychain.ts';
import type { SettingsStore } from '../settings/store.ts';

/** Everything a step may touch. Outside calls go through `ledger` only. */
export interface Services {
  db: Db;
  ledger: LedgerClient;
  secrets: Secrets;
  settings: SettingsStore;
  bus: EventBus;
}

export interface StepContext<I> extends Services {
  jobId: number;
  productId: number | null;
  input: I;
  /** Results of earlier steps, by step name. */
  prior: Record<string, unknown>;
  log(message: string, level?: JobLogLine['level'], requestId?: string | null): void;
  progress(patch: Record<string, unknown>): void;
}

export interface JobStep<I> {
  name: string;
  /** Must be idempotent: a retry resumes here and never repeats earlier steps' requests. */
  run(ctx: StepContext<I>): Promise<unknown>;
}

export interface JobDefinition<I = unknown> {
  type: JobType;
  input: z.ZodType<I>;
  steps: readonly JobStep<I>[];
}

/**
 * Thrown by a step to give the user a precise error: the step is filled in by the worker,
 * the service part is quoted as received, and the suggestion says what to do next.
 */
export class JobStepError extends Error {
  readonly details: Omit<JobError, 'step' | 'message'>;
  constructor(message: string, details: Partial<Omit<JobError, 'step' | 'message'>> = {}) {
    super(message);
    this.name = 'JobStepError';
    this.details = {
      service: details.service ?? null,
      code: details.code ?? null,
      subcode: details.subcode ?? null,
      requestId: details.requestId ?? null,
      suggestion: details.suggestion ?? null,
      retryable: details.retryable ?? false,
    };
  }
}

export class JobRegistry {
  private readonly defs = new Map<JobType, JobDefinition<never>>();

  register<I>(def: JobDefinition<I>): this {
    this.defs.set(def.type, def as JobDefinition<never>);
    return this;
  }

  get(type: JobType): JobDefinition<unknown> {
    const def = this.defs.get(type);
    if (!def) throw new Error(`No job registered for type "${type}"`);
    return def as JobDefinition<unknown>;
  }

  has(type: JobType): boolean {
    return this.defs.has(type);
  }
}
