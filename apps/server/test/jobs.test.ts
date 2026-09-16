import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@conveyor/shared';
import { JobStepError, type JobDefinition } from '../src/jobs/types.ts';
import { testContext } from './helpers.ts';

function flakyJob(failOn: { step: string; times: number }, counts: Record<string, number>): JobDefinition<{ n: number }> {
  let failures = 0;
  const step = (name: string) => ({
    name,
    async run(ctx: { input: { n: number }; prior: Record<string, unknown>; log: (m: string) => void }) {
      counts[name] = (counts[name] ?? 0) + 1;
      ctx.log(`${name} ran`);
      if (name === failOn.step && failures < failOn.times) {
        failures++;
        throw new JobStepError('Meta said no', { service: 'meta', code: '100', subcode: '4834011', requestId: 'trace-1', suggestion: 'Check the payload rules.', retryable: true });
      }
      return { [name]: ctx.input.n + Object.keys(ctx.prior).length };
    },
  });
  return { type: 'import', input: z.object({ n: z.number() }), steps: [step('parse'), step('fetch'), step('save')] };
}

describe('JobWorker', () => {
  it('runs steps in order, checkpoints each, and reports done', async () => {
    const ctx = testContext();
    const counts: Record<string, number> = {};
    ctx.registry.register(flakyJob({ step: 'none', times: 0 }, counts));
    const events: ServerEvent[] = [];
    ctx.bus.subscribe((e) => events.push(e));

    const job = ctx.worker.enqueue('import', { n: 1 });
    expect(job.status).toBe('queued');
    expect(job.steps).toEqual(['parse', 'fetch', 'save']);
    await ctx.worker.drain();

    const done = ctx.worker.view(job.id);
    expect(done.status).toBe('done');
    expect(done.completedSteps).toEqual(['parse', 'fetch', 'save']);
    expect(done.attempts).toBe(1);
    expect(done.log.map((l) => l.message)).toEqual(['parse ran', 'fetch ran', 'save ran']);
    expect(counts).toEqual({ parse: 1, fetch: 1, save: 1 });
    expect(events.filter((e) => e.kind === 'job').length).toBeGreaterThanOrEqual(5);
    expect(events.filter((e) => e.kind === 'log')).toHaveLength(3);
    await ctx.close();
  });

  it('fails with an error naming the step and quoting the service, then resumes at that step on retry', async () => {
    const ctx = testContext();
    const counts: Record<string, number> = {};
    ctx.registry.register(flakyJob({ step: 'fetch', times: 1 }, counts));

    const job = ctx.worker.enqueue('import', { n: 2 });
    await ctx.worker.drain();
    const failed = ctx.worker.view(job.id);
    expect(failed.status).toBe('failed');
    expect(failed.completedSteps).toEqual(['parse']);
    expect(failed.error).toMatchObject({ step: 'fetch', message: 'Meta said no', service: 'meta', code: '100', subcode: '4834011', requestId: 'trace-1', retryable: true });
    expect(failed.log.at(-1)).toMatchObject({ level: 'error', step: 'fetch', requestId: 'trace-1' });

    ctx.worker.retry(job.id);
    await ctx.worker.drain();
    const done = ctx.worker.view(job.id);
    expect(done.status).toBe('done');
    expect(done.attempts).toBe(2);
    // The earlier step was not repeated: its request budget is spent once.
    expect(counts).toEqual({ parse: 1, fetch: 2, save: 1 });
    await ctx.close();
  });

  it('rejects invalid input before recording anything', async () => {
    const ctx = testContext();
    ctx.registry.register(flakyJob({ step: 'none', times: 0 }, {}));
    expect(() => ctx.worker.enqueue('import', { n: 'x' })).toThrow();
    expect(ctx.worker.list()).toEqual([]);
    await ctx.close();
  });

  it('redacts secrets from error messages', async () => {
    const ctx = testContext();
    await ctx.secrets.set('meta_access_token', 'EAAVerySecretToken1234567890');
    ctx.registry.register({
      type: 'launch',
      input: z.object({}),
      steps: [{ name: 'send', run: async () => { throw new Error('Bad token EAAVerySecretToken1234567890 in request'); } }],
    });
    const job = ctx.worker.enqueue('launch', {});
    await ctx.worker.drain();
    const v = ctx.worker.view(job.id);
    expect(v.error?.message).toBe('Bad token [redacted] in request');
    expect(JSON.stringify(v)).not.toContain('VerySecret');
    await ctx.close();
  });
});
