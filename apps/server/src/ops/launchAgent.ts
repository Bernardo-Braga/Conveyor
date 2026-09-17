import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
export const LABEL = 'com.conveyor.server';

export interface AgentPaths {
  node: string;
  tsx: string;
  main: string;
  repo: string;
  dataDir: string;
  port: number;
  plist: string;
}

export function agentPaths(dataDir: string, port: number): AgentPaths {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  return {
    node: process.execPath,
    tsx: path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    main: path.join(repo, 'apps', 'server', 'src', 'main.ts'),
    repo,
    dataDir,
    port,
    plist: path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A user LaunchAgent that starts the server at login and keeps it alive. ProgramArguments run
 * node directly on the tsx loader, so no shell is involved; the server binds 127.0.0.1 as always.
 */
export function plistFor(p: AgentPaths): string {
  const pathEnv = ['/opt/homebrew/bin', '/opt/homebrew/opt/node/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(os.homedir(), '.local', 'bin')].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(p.node)}</string>
    <string>${esc(p.tsx)}</string>
    <string>${esc(p.main)}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(p.repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(pathEnv)}</string>
    <key>CONVEYOR_DATA_DIR</key><string>${esc(p.dataDir)}</string>
    <key>CONVEYOR_PORT</key><string>${p.port}</string>
    <key>CONVEYOR_ENV</key><string>production</string>
    <key>HOME</key><string>${esc(os.homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(path.join(p.dataDir, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(p.dataDir, 'server.log'))}</string>
</dict>
</plist>
`;
}

export interface AgentStatus {
  installed: boolean;
  loaded: boolean;
  plist: string;
  pid: number | null;
  webBuilt: boolean;
}

export async function agentStatus(p: AgentPaths, run: typeof execFileP = execFileP): Promise<AgentStatus> {
  const installed = fs.existsSync(p.plist);
  let loaded: boolean;
  let pid: number | null = null;
  try {
    const { stdout } = await run('/bin/launchctl', ['print', `gui/${os.userInfo().uid}/${LABEL}`]);
    loaded = true;
    pid = Number(stdout.match(/\bpid = (\d+)/)?.[1] ?? '') || null;
  } catch {
    loaded = false;
  }
  return { installed, loaded, plist: p.plist, pid, webBuilt: fs.existsSync(path.join(p.repo, 'apps', 'web', 'dist', 'index.html')) };
}

/** Writes the plist and bootstraps it. The built web app must exist, since nothing serves Vite at login. */
export async function installAgent(p: AgentPaths, run: typeof execFileP = execFileP): Promise<AgentStatus> {
  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  fs.writeFileSync(p.plist, plistFor(p));
  const domain = `gui/${os.userInfo().uid}`;
  await run('/bin/launchctl', ['bootout', `${domain}/${LABEL}`]).catch(() => undefined);
  await run('/bin/launchctl', ['bootstrap', domain, p.plist]);
  return agentStatus(p, run);
}

export async function uninstallAgent(p: AgentPaths, run: typeof execFileP = execFileP): Promise<AgentStatus> {
  await run('/bin/launchctl', ['bootout', `gui/${os.userInfo().uid}/${LABEL}`]).catch(() => undefined);
  fs.rmSync(p.plist, { force: true });
  return agentStatus(p, run);
}
