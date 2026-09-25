import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AgentStatus, StartAtLogin } from '../types.ts';
import { envGet } from './commands.ts';

const execFileP = promisify(execFile);
const wpath = path.win32;
export const TASK_NAME = 'Conveyor';

export interface TaskPaths {
  node: string;
  tsx: string;
  launcher: string;
  repo: string;
  dataDir: string;
  port: number;
  /** DOMAIN\user, for the logon trigger. */
  userId: string;
  /** A copy of the registered task, kept in the data folder for reference. */
  taskXml: string;
  /** Written by the launcher while it runs; how status finds the server without parsing schtasks output, which is localised. */
  pidFile: string;
  system32: string;
}

export function taskPaths(dataDir: string, port: number, env: NodeJS.ProcessEnv = process.env): TaskPaths {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
  return {
    node: process.execPath,
    tsx: path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    launcher: path.join(repo, 'apps', 'server', 'src', 'platform', 'win32', 'loginLauncher.ts'),
    repo,
    dataDir,
    port,
    userId: `${envGet(env, 'USERDOMAIN') ?? os.hostname()}\\${os.userInfo().username}`,
    taskXml: path.join(dataDir, 'conveyor-task.xml'),
    pidFile: path.join(dataDir, 'server.pid'),
    system32: wpath.join(envGet(env, 'SystemRoot') ?? 'C:\\Windows', 'System32'),
  };
}

/** Quotes one argument the way CreateProcess splits them (backslashes only matter before a quote). */
export function quoteWinArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A per-user scheduled task that starts at logon and restarts after a crash. conhost --headless
 * keeps a console window from opening; node then runs the launcher on the tsx loader, which sets
 * the environment, writes server.log and the pid file, and runs the server. No shell is involved.
 */
export function taskXmlFor(p: TaskPaths): string {
  const args = ['--headless', p.node, p.tsx, p.launcher, '--data-dir', p.dataDir, '--port', String(p.port)].map(quoteWinArg).join(' ');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Runs the Conveyor server on 127.0.0.1 at login.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${esc(p.userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${esc(p.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(wpath.join(p.system32, 'conhost.exe'))}</Command>
      <Arguments>${esc(args)}</Arguments>
      <WorkingDirectory>${esc(p.repo)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function runningPid(pidFile: string): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export async function taskStatus(p: TaskPaths, run: typeof execFileP = execFileP): Promise<AgentStatus> {
  let installed: boolean;
  try {
    await run(wpath.join(p.system32, 'schtasks.exe'), ['/Query', '/TN', TASK_NAME]);
    installed = true;
  } catch {
    installed = false;
  }
  const pid = runningPid(p.pidFile);
  return { installed, loaded: pid != null, plist: p.taskXml, pid, webBuilt: fs.existsSync(path.join(p.repo, 'apps', 'web', 'dist', 'index.html')) };
}

/** Registers the task from its XML (UTF-16, as schtasks expects) and starts it now. */
export async function installTask(p: TaskPaths, run: typeof execFileP = execFileP): Promise<AgentStatus> {
  const schtasks = wpath.join(p.system32, 'schtasks.exe');
  fs.mkdirSync(path.dirname(p.taskXml), { recursive: true });
  fs.writeFileSync(p.taskXml, Buffer.from(`\ufeff${taskXmlFor(p)}`, 'utf16le'));
  await run(schtasks, ['/Create', '/TN', TASK_NAME, '/XML', p.taskXml, '/F']);
  if (runningPid(p.pidFile) == null) await run(schtasks, ['/Run', '/TN', TASK_NAME]);
  return taskStatus(p, run);
}

export async function uninstallTask(p: TaskPaths, run: typeof execFileP = execFileP): Promise<AgentStatus> {
  const pid = runningPid(p.pidFile);
  if (pid != null) await run(wpath.join(p.system32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F']).catch(() => undefined);
  fs.rmSync(p.pidFile, { force: true });
  await run(wpath.join(p.system32, 'schtasks.exe'), ['/Delete', '/TN', TASK_NAME, '/F']).catch(() => undefined);
  fs.rmSync(p.taskXml, { force: true });
  return taskStatus(p, run);
}

export const scheduledTask: StartAtLogin = {
  status: (dataDir, port) => taskStatus(taskPaths(dataDir, port)),
  install: (dataDir, port) => installTask(taskPaths(dataDir, port)),
  uninstall: (dataDir, port) => uninstallTask(taskPaths(dataDir, port)),
};
