import { spawn } from 'node:child_process';
import { platform } from '../../platform/index.ts';
import type { RunCli } from './types.ts';

const MAX_OUTPUT = 32 * 1024 * 1024;

/**
 * Runs a local CLI. No shell, so nothing in a product title can be interpreted as a command.
 * The platform turns the name into something spawn can run (on Windows, npm's .cmd wrappers
 * need resolving; see platform/win32/commands.ts).
 *
 * stdin is ignored on purpose: `codex exec` waits on stdin whenever it is an open pipe, even
 * with a prompt argument, and hangs for the whole timeout. Confirmed 16 September 2026.
 */
export const runCli: RunCli = (file, args, opts) =>
  new Promise((resolve) => {
    let cmd;
    try {
      cmd = platform.resolveCommand(file, opts.env);
    } catch (err) {
      resolve({ stdout: '', stderr: err instanceof Error ? err.message : String(err), code: null, timedOut: false });
      return;
    }
    const child = spawn(cmd.file, [...cmd.args, ...args], { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const take = (buf: Buffer, into: string) => (into.length > MAX_OUTPUT ? into : into + buf.toString());
    child.stdout.on('data', (b: Buffer) => (stdout = take(b, stdout)));
    child.stderr.on('data', (b: Buffer) => (stderr = take(b, stderr)));

    const timer = setTimeout(() => {
      timedOut = true;
      platform.stopProcess(child);
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
