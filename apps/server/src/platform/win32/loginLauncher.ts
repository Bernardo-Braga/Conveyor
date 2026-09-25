/**
 * What the Windows scheduled task runs at login: `loginLauncher.ts --data-dir <dir> --port <n>`.
 * A task cannot set environment variables or redirect output, so this does both, then runs the
 * server as a child and exits with its code, so the task's restart-on-failure applies. The pid
 * file lets Settings show the server as running without parsing schtasks output.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`loginLauncher: missing ${name}`);
  return v;
}

const dataDir = arg('--data-dir');
const port = arg('--port');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const pidFile = path.join(dataDir, 'server.pid');

fs.mkdirSync(dataDir, { recursive: true });
const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
fs.writeFileSync(pidFile, String(process.pid));

const child = spawn(process.execPath, [path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(repo, 'apps', 'server', 'src', 'main.ts')], {
  cwd: repo,
  env: { ...process.env, CONVEYOR_DATA_DIR: dataDir, CONVEYOR_PORT: port, CONVEYOR_ENV: 'production' },
  stdio: ['ignore', log, log],
  windowsHide: true,
});

child.on('exit', (code) => {
  fs.rmSync(pidFile, { force: true });
  process.exit(code ?? 1);
});
