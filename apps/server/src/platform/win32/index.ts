import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Platform } from '../types.ts';
import { envGet, resolveWin32Command } from './commands.ts';
import { scheduledTask } from './startAtLogin.ts';

const execFileP = promisify(execFile);
const system32 = () => path.win32.join(envGet(process.env, 'SystemRoot') ?? 'C:\\Windows', 'System32');

/**
 * Local, not Roaming, AppData: the database and product photos grow large and should not follow
 * a roaming profile around.
 */
export function win32DataDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = envGet(env, 'LOCALAPPDATA') ?? path.win32.join(os.homedir(), 'AppData', 'Local');
  return path.win32.join(base, 'Conveyor', 'data');
}

/**
 * Zips with the bsdtar that ships in System32 (Windows 10 1803 and later). The folder's entries
 * are named one by one so the archive has no leading "./". execFile, never a shell.
 */
export async function tarZip(folder: string, file: string, tar: string, run: typeof execFileP = execFileP): Promise<void> {
  const entries = fs.readdirSync(folder).sort();
  await run(tar, ['-a', '-c', '-f', file, '-C', folder, ...entries]);
}

export const win32: Platform = {
  name: 'win32',
  defaultDataDir: () => win32DataDir(),
  keyStoreName: 'Windows Credential Manager',
  zipFolder: (folder, file) => tarZip(folder, file, path.win32.join(system32(), 'tar.exe')),
  resolveCommand: (name, env) => resolveWin32Command(name, env),
  // A .cmd wrapper resolves to node running the CLI's script, which starts the real binary, so the
  // whole tree has to go. taskkill /T /F is the Windows way; there is no SIGTERM to send first.
  stopProcess: (child) => {
    if (child.pid === undefined) return;
    execFile(path.win32.join(system32(), 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], () => child.kill());
  },
  startAtLogin: scheduledTask,
};
