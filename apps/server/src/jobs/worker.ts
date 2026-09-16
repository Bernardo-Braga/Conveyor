import { and, desc, eq, inArray } from 'drizzle-orm';
import { JobError, JobType, type JobLogLine, type JobView } from '@conveyor/shared';
import { jobs } from '../db/schema.ts';
import { redact } from '../http/redact.ts';
import { JobStepError, type JobRegistry, type Services, type StepContext } from './types.ts';

const MAX_LOG_LINES = 500;

type JobRow = typeof jobs.$inferSelect;

/**
 * Runs jobs one at a time. A job is an ordered list of named, idempotent steps with a
 * checkpoint after each. A retry resumes at the failed step.
 */
export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;

  constructor(
    private readonly services: Services,
    private readonly registry: JobRegistry,
    private readonly pollMs = 250,
  ) {}

  /** Records a job and returns it. The worker picks it up on its next tick. */
  enqueue(type: JobType, input: unknown, productId: number | null = null): JobView {
    const def = this.registry.get(type);
    const parsed = def.input.parse(input);
    const row = this.services.db
      .insert(jobs)
      .values({ type, productId, status: 'queued', input: parsed, steps: def.steps.map((s) => s.name), checkpoints: {}, log: [] })
      .returning()
      .get();
    const view = toView(row);
    this.services.bus.emit({ kind: 'job', job: view });
    return view;
  }

  /** Re-queues a failed job. Steps with a checkpoint are skipped when it runs again. */
  retry(id: number): JobView {
    const row = this.get(id);
    if (row.status !== 'failed' && row.status !== 'cancelled') throw new Error(`Job ${id} is ${row.status}, not failed`);
    const updated = this.services.db
      .update(jobs)
      .set({ status: 'queued', error: null, finishedAt: null, updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id))
      .returning()
      .get()!;
    const view = toView(updated);
    this.services.bus.emit({ kind: 'job', job: view });
    return view;
  }

  get(id: number): JobRow {
    const row = this.services.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!row) throw new Error(`Job ${id} not found`);
    return row;
  }

  view(id: number): JobView {
    return toView(this.get(id));
  }

  list(limit = 50): JobView[] {
    return this.services.db.select().from(jobs).orderBy(desc(jobs.id)).limit(limit).all().map(toView);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Anything left "running" by a previous process is resumed from its last checkpoint.
    this.services.db.update(jobs).set({ status: 'queued' }).where(eq(jobs.status, 'running')).run();
    const tick = async () => {
      if (this.stopped) return;
      try {
        while (await this.runOnce()) {
          if (this.stopped) return;
        }
      } finally {
        if (!this.stopped) this.timer = setTimeout(tick, this.pollMs);
      }
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) await this.running;
  }

  /** Runs the oldest queued job, if any. Returns whether one ran. Tests call this directly. */
  async runOnce(): Promise<boolean> {
    const next = this.services.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'queued'), inArray(jobs.type, JobType.options)))
      .orderBy(jobs.id)
      .limit(1)
      .get();
    if (!next) return false;
    this.running = this.run(next);
    try {
      await this.running;
    } finally {
      this.running = null;
    }
    return true;
  }

  /** Runs every queued job until the queue is empty. */
  async drain(): Promise<void> {
    while (await this.runOnce()) {
      /* keep going */
    }
  }

  private async run(row: JobRow): Promise<void> {
    const def = this.registry.get(JobType.parse(row.type));
    const db = this.services.db;
    const now = () => new Date().toISOString();
    const checkpoints = { ...((row.checkpoints as Record<string, unknown> | null) ?? {}) };
    let log = [...((row.log as JobLogLine[] | null) ?? [])];
    let progress = (row.progress as Record<string, unknown> | null) ?? null;

    const emit = () => this.services.bus.emit({ kind: 'job', job: this.view(row.id) });
    const save = (patch: Partial<typeof jobs.$inferInsert>) => {
      db.update(jobs).set({ ...patch, updatedAt: now() }).where(eq(jobs.id, row.id)).run();
    };

    save({ status: 'running', attempts: row.attempts + 1, startedAt: row.startedAt ?? now(), error: null });
    emit();

    const makeLog = (step: string) => (message: string, level: JobLogLine['level'] = 'info', requestId: string | null = null) => {
      const line: JobLogLine = { at: now(), step, level, message: redact(message), requestId };
      log = [...log.slice(-(MAX_LOG_LINES - 1)), line];
      save({ log });
      this.services.bus.emit({ kind: 'log', jobId: row.id, line });
    };

    for (const step of def.steps) {
      if (step.name in checkpoints) continue; // already done: never repeat its requests
      save({ currentStep: step.name });
      emit();
      const ctx: StepContext<unknown> = {
        ...this.services,
        jobId: row.id,
        productId: row.productId,
        input: row.input,
        prior: { ...checkpoints },
        log: makeLog(step.name),
        progress: (patch) => {
          progress = { ...(progress ?? {}), ...patch };
          save({ progress });
          emit();
        },
      };
      try {
        const result = await step.run(ctx);
        checkpoints[step.name] = result === undefined ? null : result;
        save({ checkpoints });
      } catch (err) {
        const secrets = await this.services.secrets.allValues();
        const error = toJobError(step.name, err, secrets);
        makeLog(step.name)(error.message, 'error', error.requestId);
        try {
          def.onError?.({ ...this.services, jobId: row.id, productId: row.productId, input: row.input, prior: { ...checkpoints } }, error);
        } catch (hookErr) {
          makeLog(step.name)(`onError hook failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`, 'warn');
        }
        save({ status: 'failed', error, finishedAt: now() });
        emit();
        return;
      }
    }

    def.onDone?.({ ...this.services, jobId: row.id, productId: row.productId, input: row.input, prior: { ...checkpoints } });
    save({ status: 'done', currentStep: null, finishedAt: now() });
    emit();
  }
}

function toJobError(step: string, err: unknown, secrets: readonly string[]): JobError {
  if (err instanceof JobStepError) {
    return JobError.parse({ step, message: redact(err.message, secrets), ...err.details });
  }
  const message = err instanceof Error ? err.message : String(err);
  return JobError.parse({ step, message: redact(message, secrets) || 'Unknown error', retryable: false });
}

export function toView(row: JobRow): JobView {
  const checkpoints = (row.checkpoints as Record<string, unknown> | null) ?? {};
  return {
    id: row.id,
    type: JobType.parse(row.type),
    productId: row.productId,
    status: row.status as JobView['status'],
    steps: row.steps as string[],
    currentStep: row.currentStep,
    completedSteps: Object.keys(checkpoints),
    attempts: row.attempts,
    progress: (row.progress as Record<string, unknown> | null) ?? null,
    error: (row.error as JobError | null) ?? null,
    log: (row.log as JobLogLine[] | null) ?? [],
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
