import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { childEnv, keyVarsInEnvironment } from '../src/listing/writers/childEnv.ts';
import { cmdShimTarget, resolveWin32Command, type CommandFs } from '../src/platform/win32/commands.ts';
import { tarZip, win32DataDir } from '../src/platform/win32/index.ts';
import { TASK_NAME, installTask, quoteWinArg, taskPaths, taskXmlFor, uninstallTask } from '../src/platform/win32/startAtLogin.ts';

const execFileP = promisify(execFile);

// The wrapper npm writes for a global install (cmd-shim), as found next to codex.cmd.
const CODEX_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

function fakeFs(files: Record<string, string>): CommandFs {
  return { isFile: (p) => p in files, readText: (p) => files[p] ?? '' };
}

describe('Windows command resolution', () => {
  const npmDir = 'C:\\Users\\x\\AppData\\Roaming\\npm';
  const localBin = 'C:\\Users\\x\\.local\\bin';
  const node = 'C:\\Program Files\\nodejs\\node.exe';

  it('reads the script out of an npm .cmd wrapper and runs it with node, never a shell', () => {
    expect(cmdShimTarget(`${npmDir}\\codex.cmd`, CODEX_SHIM)).toBe(`${npmDir}\\node_modules\\@openai\\codex\\bin\\codex.js`);
    const r = resolveWin32Command('codex', { Path: `C:\\Windows\\System32;${npmDir}` }, node, fakeFs({ [`${npmDir}\\codex.cmd`]: CODEX_SHIM }));
    expect(r).toEqual({ file: node, args: [`${npmDir}\\node_modules\\@openai\\codex\\bin\\codex.js`] });
  });

  it('prefers a real .exe earlier on PATH, and reads PATH whatever its case', () => {
    const r = resolveWin32Command('claude', { pAtH: `${localBin};${npmDir}` }, node, fakeFs({ [`${localBin}\\claude.exe`]: '', [`${npmDir}\\claude.cmd`]: CODEX_SHIM }));
    expect(r).toEqual({ file: `${localBin}\\claude.exe`, args: [] });
  });

  it('refuses a .cmd it cannot read rather than falling back to a shell', () => {
    expect(() => resolveWin32Command('tool', { PATH: npmDir }, node, fakeFs({ [`${npmDir}\\tool.cmd`]: '@echo off\r\ncall something.bat %*' }))).toThrow(/does not run commands through a shell/);
  });

  it('returns the bare name when nothing is installed, so spawn reports ENOENT as on macOS', () => {
    expect(resolveWin32Command('codex', { PATH: npmDir }, node, fakeFs({}))).toEqual({ file: 'codex', args: [] });
  });
});

describe('Windows data folder', () => {
  it('lives in Local AppData', () => {
    expect(win32DataDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toBe('C:\\Users\\x\\AppData\\Local\\Conveyor\\data');
  });
});

describe('key stripping ignores case, as Windows does', () => {
  it('drops a lower-case ANTHROPIC_API_KEY and reports it', () => {
    const env = childEnv({ anthropic_api_key: 'sk-x', Path: 'C:\\bin' });
    expect(env).toEqual({ Path: 'C:\\bin' });
    expect(keyVarsInEnvironment({ Anthropic_Base_Url: 'https://x' })).toEqual(['Anthropic_Base_Url']);
  });
});

describe('Windows start at login', () => {
  it('quotes arguments the way CreateProcess splits them', () => {
    expect(quoteWinArg('plain')).toBe('plain');
    expect(quoteWinArg('C:\\Program Files\\nodejs\\node.exe')).toBe('"C:\\Program Files\\nodejs\\node.exe"');
    expect(quoteWinArg('C:\\with space\\')).toBe('"C:\\with space\\\\"');
    expect(quoteWinArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWinArg('')).toBe('""');
  });

  it('the task runs node on the launcher under a headless console, at logon, restarting on failure, with no shell', () => {
    const dataDir = 'C:\\Users\\x\\AppData\\Local\\Conveyor\\data';
    const p = { ...taskPaths(dataDir, 4310, { USERDOMAIN: 'PC', SystemRoot: 'C:\\Windows' }), node: 'C:\\Program Files\\nodejs\\node.exe' };
    const xml = taskXmlFor(p);
    expect(xml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>');
    expect(xml).toContain('--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot;');
    expect(xml).toContain('loginLauncher.ts --data-dir C:\\Users\\x\\AppData\\Local\\Conveyor\\data --port 4310');
    expect(xml).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>PC\\/);
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).not.toMatch(/cmd\.exe|powershell/i);
  });

  it('install registers the task from a UTF-16 file and starts it; uninstall deletes it', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-task-'));
    const p = taskPaths(dataDir, 4310, { USERDOMAIN: 'PC', SystemRoot: 'C:\\Windows' });
    const calls: string[][] = [];
    let registered = false;
    const run = (async (file: string, args: readonly string[]) => {
      calls.push([file, ...args]);
      if (args[0] === '/Create') registered = true;
      if (args[0] === '/Delete') registered = false;
      if (args[0] === '/Query' && !registered) throw new Error('not found');
      return { stdout: '', stderr: '' };
    }) as unknown as Parameters<typeof installTask>[1];

    const st = await installTask(p, run);
    expect(st).toMatchObject({ installed: true, loaded: false, pid: null });
    const bytes = fs.readFileSync(p.taskXml);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(bytes.toString('utf16le')).toContain('<Task version="1.2"');
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ['C:\\Windows\\System32\\schtasks.exe', '/Create', '/TN'],
      ['C:\\Windows\\System32\\schtasks.exe', '/Run', '/TN'],
      ['C:\\Windows\\System32\\schtasks.exe', '/Query', '/TN'],
    ]);
    expect(calls[0]).toContain(TASK_NAME);

    // A running server is found through the launcher's pid file.
    fs.writeFileSync(p.pidFile, String(process.pid));
    calls.length = 0;
    const down = await uninstallTask({ ...p, pidFile: path.join(dataDir, 'none.pid') }, run);
    expect(down.installed).toBe(false);
    expect(calls.some((c) => c[1] === '/Delete')).toBe(true);
    expect(fs.existsSync(p.taskXml)).toBe(false);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('Windows backup zip', () => {
  // macOS ships the same bsdtar as Windows' System32\tar.exe, so the real command runs here.
  it.runIf(process.platform === 'darwin')('zips the folder contents with no leading ./', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-zip-'));
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(path.join(staging, 'products', '1'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'README.txt'), 'hello');
    fs.writeFileSync(path.join(staging, 'products', '1', 'photo.jpg'), 'x');
    const file = path.join(dir, 'out.zip');
    await tarZip(staging, file, '/usr/bin/tar');
    expect(fs.readFileSync(file).subarray(0, 2).toString()).toBe('PK');
    const { stdout } = await execFileP('/usr/bin/unzip', ['-Z1', file]);
    const names = stdout.trim().split('\n').sort();
    expect(names).toContain('README.txt');
    expect(names).toContain('products/1/photo.jpg');
    expect(names.some((n) => n.startsWith('./'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
