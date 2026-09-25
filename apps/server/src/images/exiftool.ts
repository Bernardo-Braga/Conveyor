import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from '../platform/index.ts';

const execFileP = promisify(execFile);

/** exiftool.exe on Windows, the Homebrew script on macOS; resolved without a shell either way. */
function exiftool(args: string[], opts: { timeout: number; maxBuffer?: number }) {
  const cmd = platform.resolveCommand('exiftool', process.env);
  return execFileP(cmd.file, [...cmd.args, ...args], { ...opts, windowsHide: true });
}

/** Groups a clean JPEG may carry. Anything else means metadata survived. */
export const ALLOWED_GROUPS: ReadonlySet<string> = new Set(['SourceFile', 'ExifTool', 'System', 'File', 'JFIF', 'Composite']);

let available: boolean | null = null;

/** The check is optional when exiftool is not installed. */
export async function exiftoolAvailable(): Promise<boolean> {
  if (available !== null) return available;
  try {
    await exiftool(['-ver'], { timeout: 10_000 });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

/** Runs `exiftool -json -G1 -a` with execFile, never a shell. */
export async function exiftoolGroups(filePath: string): Promise<string[]> {
  const { stdout } = await exiftool(['-json', '-G1', '-a', filePath], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  const first = (JSON.parse(stdout) as Record<string, unknown>[])[0] ?? {};
  return [...new Set(Object.keys(first).map((k) => k.split(':')[0]!))];
}

export async function exiftoolClean(filePath: string): Promise<{ ok: true; groups: string[] } | { ok: false; extra: string[]; groups: string[] }> {
  const groups = await exiftoolGroups(filePath);
  const extra = groups.filter((g) => !ALLOWED_GROUPS.has(g));
  return extra.length ? { ok: false, extra, groups } : { ok: true, groups };
}
