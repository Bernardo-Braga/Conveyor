import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedCommand } from '../types.ts';

const wpath = path.win32;

export interface CommandFs {
  isFile(p: string): boolean;
  readText(p: string): string;
}

const realFs: CommandFs = {
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readText: (p) => fs.readFileSync(p, 'utf8'),
};

/** Windows environment names ignore case; a copied env object does not. */
export function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * npm installs CLIs on Windows as `.cmd` wrappers, and since Node's 2024 fix for CVE-2024-27980
 * spawn cannot run a `.cmd` without a shell. Conveyor never uses a shell, so the wrapper is read
 * instead: its last line runs node on a script next to it, and that script is run directly.
 */
export function cmdShimTarget(shimPath: string, text: string): string | null {
  const m = text.match(/"%~?dp0%?\\([^"]+?\.[cm]?js)"/i);
  return m ? wpath.join(wpath.dirname(shimPath), m[1]!) : null;
}

/**
 * Looks the name up on the child's PATH. A real `.exe` wins; a `.cmd` wrapper becomes node plus
 * its script. When nothing is found the bare name is returned, so spawn fails with ENOENT and the
 * caller reports "not installed" as it does on macOS.
 */
export function resolveWin32Command(name: string, env: NodeJS.ProcessEnv, nodePath: string = process.execPath, files: CommandFs = realFs): ResolvedCommand {
  if (/[\\/]/.test(name)) return { file: name, args: [] };
  const dirs = (envGet(env, 'PATH') ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    const exe = wpath.join(dir, `${name}.exe`);
    if (files.isFile(exe)) return { file: exe, args: [] };
    const cmd = wpath.join(dir, `${name}.cmd`);
    if (files.isFile(cmd)) {
      const script = cmdShimTarget(cmd, files.readText(cmd));
      if (!script) throw new Error(`${cmd} is not an npm wrapper Conveyor can read, and Conveyor does not run commands through a shell. Install ${name} so that ${name}.exe or an npm wrapper is on PATH.`);
      return { file: nodePath, args: [script] };
    }
  }
  return { file: name, args: [] };
}
