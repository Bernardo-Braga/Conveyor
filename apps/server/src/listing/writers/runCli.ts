import { spawn } from 'node:child_process';
import type { RunCli } from './types.ts';

const MAX_OUTPUT = 32 * 1024 * 1024;

/**
 * Runs a local CLI. No shell, so nothing in a product title can be interpreted as a command
 * (CLAUDE.md hard rule 7).
 *
 * stdin is ignored on purpose: `codex exec` waits on stdin whenever it is an open pipe, even
 * with a prompt argument, and hangs for the whole timeout. Confirmed 16 September 2026.
 */
export const runCli: RunCli = (file, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(file, [...args], { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const take = (buf: Buffer, into: string) => (into.length > MAX_OUTPUT ? into : into + buf.toString());
    child.stdout.on('data', (b: Buffer) => (stdout = take(b, stdout)));
    child.stderr.on('data', (b: Buffer) => (stderr = take(b, stderr)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, opts.timeoutMs);

    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    };
    child.on('close', finish);
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      finish(null);
    });
  });
