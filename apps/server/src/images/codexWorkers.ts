import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { GEN_SIZE, type Aspect } from '@conveyor/shared';
import { VERSIONS } from '../../../../config/versions.ts';
import type { Db } from '../db/index.ts';
import { codexTasks } from '../db/schema.ts';
import { childEnv } from '../listing/writers/childEnv.ts';
import { runCli as defaultRunCli } from '../listing/writers/runCli.ts';
import { looksLikeUsageLimit, type RunCli } from '../listing/writers/types.ts';
import type { EngineSlot, ImageEngine } from './engine.ts';
import { fileIsStable } from './store.ts';

export interface CodexPoolOptions {
  workers: number;
  imagesPerTask: 'one' | 'format';
  timeLimitPerImageMs: number;
  /** Stop after this many failed tasks. */
  maxFailures?: number;
  run?: RunCli;
  env?: NodeJS.ProcessEnv;
  /** How often `out/` is checked. */
  pollMs?: number;
  db?: Db;
}

interface Task {
  index: number;
  aspect: Aspect;
  slots: EngineSlot[];
  attempt: number;
}

interface TaskResult {
  task: Task;
  produced: number[];
  missing: EngineSlot[];
  failed: boolean;
  usageLimit: boolean;
  timedOut: boolean;
  error: string | null;
  durationMs: number;
}

/**
 * The default engine. One Codex CLI process per task in its own folder
 * under data/workers/, using the built-in image generation tool on the ChatGPT plan. The
 * tool writes under $CODEX_HOME/generated_images and has no output path, so the task file
 * tells Codex to copy each result to out/NN.png; a watcher picks those up as they land.
 *
 * Confirmed 16 September 2026 (codex-smoke.ts, 3 of 3): view reference → image_gen → cp.
 */
export function codexEngine(opts: CodexPoolOptions): ImageEngine {
  const run = opts.run ?? defaultRunCli;
  const maxFailures = opts.maxFailures ?? 2;
  const pollMs = opts.pollMs ?? 1_000;

  return {
    id: 'codex',
    async available() {
      const res = await run('codex', ['--version'], { cwd: process.cwd(), env: childEnv(opts.env), timeoutMs: 20_000 });
      if (res.code !== 0) return { ok: false, reason: 'Codex CLI is not installed or not on PATH.' };
      const v = res.stdout.trim().replace(/^codex-cli\s+/, '');
      return { ok: true, reason: v === VERSIONS.codexCli ? `Codex CLI ${v}.` : `Codex CLI ${v} (tested with ${VERSIONS.codexCli}).` };
    },

    async generate(req, events) {
      const tasks = planTasks(req.slots, opts.imagesPerTask);
      const produced = new Set<number>();
      let failures = 0;
      let taskCount = 0;
      let stop: { reason: string; usageLimit: boolean } | null = null;
      const total = req.slots.length;
      const queue = [...tasks];
      const retried = new Set<number>();

      const runTask = async (task: Task, worker: number): Promise<void> => {
        taskCount += 1;
        const res = await executeTask(task, worker);
        for (const id of res.produced) produced.add(id);
        events.progress(produced.size, total);
        if (res.usageLimit) {
          stop ??= { reason: `Codex reported a plan limit: ${res.error ?? 'usage limit'}`, usageLimit: true };
          return;
        }
        if (res.failed) {
          failures += 1;
          events.log(`Task ${task.index + 1} (${task.aspect}) ${res.timedOut ? 'timed out' : 'failed'}${res.error ? `: ${res.error}` : ''}. ${res.produced.length} of ${task.slots.length} image(s) arrived.`, 'warn');
          if (failures >= maxFailures) {
            stop ??= { reason: `${failures} Codex tasks failed.`, usageLimit: false };
            return;
          }
        }
        // Retry only the images that are still missing, once.
        if (res.missing.length && !retried.has(task.index) && !stop) {
          retried.add(task.index);
          events.log(`Retrying ${res.missing.length} missing ${task.aspect} image(s) once.`);
          queue.push({ ...task, slots: res.missing, attempt: task.attempt + 1 });
        }
      };

      const executeTask = async (task: Task, worker: number): Promise<TaskResult> => {
        const started = Date.now();
        const dir = path.join(req.workDir, `task-${task.index + 1}${task.attempt > 1 ? `-retry${task.attempt - 1}` : ''}`);
        const outDir = path.join(dir, 'out');
        await fs.mkdir(outDir, { recursive: true });
        const refs: string[] = [];
        for (const [i, p] of req.referencePaths.entries()) {
          const name = `reference-${i + 1}${path.extname(p) || '.png'}`;
          await fs.copyFile(p, path.join(dir, name));
          refs.push(name);
        }
        let editName: string | null = null;
        if (req.edit) {
          editName = `edit-target${path.extname(req.edit.path) || '.jpg'}`;
          await fs.copyFile(req.edit.path, path.join(dir, editName));
        }
        await fs.writeFile(path.join(dir, 'TASK.md'), taskFile({ prompt: req.prompt, aspect: task.aspect, slots: task.slots, refs, edit: req.edit ? { name: editName!, instruction: req.edit.instruction } : null }));
        const taskRow = opts.db
          ? opts.db.insert(codexTasks).values({ batchId: req.batchId, creativeIds: task.slots.map((s) => s.creativeId), aspect: task.aspect, worker, folder: dir, attempts: task.attempt, startedAt: new Date().toISOString() }).returning({ id: codexTasks.id }).get()
          : null;

        const timeoutMs = opts.timeLimitPerImageMs * task.slots.length;
        const expected = new Map(task.slots.map((s) => [outName(s), s]));
        const seen = new Set<string>();
        const producedIds: number[] = [];
        let watcherError: string | null = null;

        const collect = async () => {
          const names = await fs.readdir(outDir).catch(() => [] as string[]);
          for (const name of names) {
            if (seen.has(name) || !expected.has(name)) continue;
            const file = path.join(outDir, name);
            if (!(await fileIsStable(file))) continue;
            seen.add(name);
            const slot = expected.get(name)!;
            try {
              await events.onImage(slot, await fs.readFile(file));
              producedIds.push(slot.creativeId);
              events.log(`${task.aspect} image ${String(slot.slot).padStart(2, '0')} arrived from worker ${worker}.`);
            } catch (err) {
              watcherError = `${name}: ${err instanceof Error ? err.message : String(err)}`;
              events.log(`Could not finish ${name}: ${watcherError}`, 'warn');
            }
          }
        };

        const proc = run(
          'codex',
          ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--ignore-rules', '--color', 'never', '--json', '--cd', dir, '-o', path.join(dir, 'last-message.txt'), 'Read TASK.md in this folder and do exactly what it says.'],
          { cwd: dir, env: childEnv(opts.env), timeoutMs },
        );
        let done = false;
        const result = proc.then((r) => {
          done = true;
          return r;
        });
        while (!done) {
          await collect();
          if (!done) await new Promise((r) => setTimeout(r, pollMs));
        }
        const res = await result;
        await collect();
        await fs.writeFile(path.join(dir, 'events.jsonl'), res.stdout).catch(() => undefined);
        await fs.writeFile(path.join(dir, 'stderr.txt'), res.stderr).catch(() => undefined);

        const missing = task.slots.filter((s) => !producedIds.includes(s.creativeId));
        // Codex exits 0 even when it gives up, so its own last line is the only explanation there is.
        const lastMessage = (await fs.readFile(path.join(dir, 'last-message.txt'), 'utf8').catch(() => '')).trim();
        const gaveUp = missing.length ? (lastMessage.split('\n').find((l) => l.trim().startsWith('FAILED'))?.trim().slice(0, 400) ?? null) : null;
        if (gaveUp) events.log(`Codex stopped early: ${gaveUp}`, 'warn');
        const tail = [res.stderr, res.stdout].join('\n').slice(-4000);
        const usageLimit = looksLikeUsageLimit(tail) && missing.length > 0;
        const failed = missing.length > 0 && (res.timedOut || res.code !== 0 || producedIds.length === 0);
        const error = res.timedOut ? `no result within ${Math.round(timeoutMs / 1000)}s` : res.code !== 0 ? `exit code ${res.code}${lastLine(res.stderr) ? `: ${lastLine(res.stderr)}` : ''}` : (watcherError ?? gaveUp);
        const out: TaskResult = { task, produced: producedIds, missing, failed, usageLimit, timedOut: res.timedOut, error, durationMs: Date.now() - started };
        if (opts.db && taskRow) {
          opts.db.update(codexTasks).set({ finishedAt: new Date().toISOString(), result: { produced: producedIds, missing: missing.map((m) => m.slot), durationMs: out.durationMs, timedOut: res.timedOut, exitCode: res.code }, error: failed || usageLimit || gaveUp ? error : null }).where(eq(codexTasks.id, taskRow.id)).run();
        }
        return out;
      };

      // A fixed number of workers pull from the queue until it is empty or the pool is stopped.
      const workers = Array.from({ length: Math.max(1, Math.min(opts.workers, tasks.length)) }, async (_, w) => {
        while (!stop) {
          const task = queue.shift();
          if (!task) return;
          await runTask(task, w + 1);
        }
      });
      await Promise.all(workers);

      const remaining = req.slots.filter((s) => !produced.has(s.creativeId));
      return { producedCreativeIds: [...produced], remaining, handoff: remaining.length && stop ? stop : null, apiRequests: 0, tasks: taskCount, failures };
    },
  };
}

/** One task per format by default; `one` makes a task per image, which is slower but isolates failures. */
export function planTasks(slots: EngineSlot[], mode: 'one' | 'format'): Task[] {
  const groups = new Map<Aspect, EngineSlot[]>();
  for (const s of slots) groups.set(s.aspect, [...(groups.get(s.aspect) ?? []), s]);
  const tasks: Task[] = [];
  for (const [aspect, group] of groups) {
    if (mode === 'one') for (const s of group) tasks.push({ index: tasks.length, aspect, slots: [s], attempt: 1 });
    else tasks.push({ index: tasks.length, aspect, slots: group, attempt: 1 });
  }
  return tasks;
}

export function outName(slot: EngineSlot): string {
  return `${String(slot.slot).padStart(2, '0')}.png`;
}

function lastLine(s: string): string {
  return s.trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';
}

/** The task file Codex reads. Everything Codex needs is in its own folder. */
export function taskFile(args: { prompt: string; aspect: Aspect; slots: EngineSlot[]; refs: string[]; edit: { name: string; instruction: string } | null }): string {
  const [w, h] = GEN_SIZE[args.aspect];
  const files = args.slots.map((s) => `out/${outName(s)}`);
  const lines = [
    '# Task',
    '',
    'You are running unattended inside this folder. Use the built-in image generation tool (the imagegen skill, built-in mode). Do not use any CLI or API fallback and do not ask questions.',
    '',
    '## Steps',
    '',
  ];
  let n = 1;
  if (args.refs.length) {
    lines.push(`${n++}. View each reference image with your image viewing tool, in order: ${args.refs.join(', ')}. They show the exact product. Every image you make must match it.`);
  }
  if (args.edit) {
    lines.push(`${n++}. View \`${args.edit.name}\`. It is the edit target: keep everything about it except this change: ${args.edit.instruction}`);
  }
  const many = args.slots.length > 1;
  lines.push(
    `${n++}. Make ${args.slots.length} image${many ? 's' : ''} with the image generation tool, one call per image. Ask for ${w}x${h} pixels (aspect ${args.aspect}). The tool picks its own pixel size, so any size it returns is fine as long as the shape is close to ${args.aspect}: the images are cropped and resized afterwards. Never stop, retry or report a failure because of pixel size.`,
    '',
    'Base prompt:',
    '',
    '```',
    args.prompt,
    '```',
    '',
    `For each image, send the base prompt followed by that image's shot line${many ? '. Every image must be a clearly different photograph: a different camera angle, framing and pose, not the same shot with different lighting' : ''}:`,
    '',
    ...args.slots.map((s) => `- out/${outName(s)}: ${s.direction ? `Shot: ${s.direction}` : 'Shot: your choice of angle and framing.'}`),
    '',
    `${n++}. After each image is generated, find the new file under your Codex home folder (usually \`generated_images\`) and copy it, unchanged, to its name in the list above${many ? ', then go on to the next image' : ''}. Create \`out/\` if needed. Use a plain copy such as \`cp\`; do not convert, resize or edit the file.`,
    `${n}. When every file in the list exists (${files.join(', ')}), reply with one line per file: \`DONE <source path> -> <out path>\`.`,
    '',
    'Only if the image generation tool itself fails or is unavailable, stop and reply with one line starting with `FAILED` and the reason, quoting any limit message exactly.',
    '',
  );
  return lines.join('\n');
}
