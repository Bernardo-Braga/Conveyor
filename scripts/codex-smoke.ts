/**
 * Codex smoke test.
 *
 * Manual, run by the user: `pnpm codex:smoke [--runs 3] [--timeout 240]`.
 * It uses the ChatGPT plan through the Codex CLI and makes no API requests of its own.
 *
 * Each run gets its own worker folder under data/workers/, with a reference image and
 * a task file. Codex must view the reference, make one 1:1 image with the built-in
 * image generation tool, and copy it to out/01.png. The run passes when out/01.png is
 * a real PNG. The test passes when every run passes.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { VERSIONS } from '../config/versions.ts';
import { dataPath } from '../apps/server/src/env.ts';

const execFileP = promisify(execFile);

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? 'true');
const RUNS = Number(args.get('runs') ?? 3);
const TIMEOUT_S = Number(args.get('timeout') ?? 240); // 4-minute limit per image, as in the plan
const KEEP = args.get('keep') === 'true';

const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const GENERATED_DIR = path.join(CODEX_HOME, 'generated_images');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function taskFile(): string {
  return `# Task

You are running unattended inside this folder. Do exactly the following, in order, and nothing else.

1. View the file \`reference.png\` in this folder with your image viewing tool. It is a solid colour swatch.
2. Use your built-in image generation tool to make ONE square (1:1) photograph-style image:
   a plain white ceramic mug on a clean white background, soft studio light, with a single
   thin accent stripe in the exact colour of the reference swatch. No text, no logos, no watermark.
3. The tool saves the file somewhere under your Codex home folder (usually \`generated_images\`).
   Find that newly created file and copy it to \`out/01.png\` in this folder (create \`out/\` if needed).
   Use a shell command such as \`cp\` to copy it. Do not convert or edit it.
4. Reply with one line: \`DONE <absolute path of the source file> -> out/01.png\`.

If image generation fails or is unavailable, reply with one line starting with \`FAILED\` and the reason.
`;
}

/** A 256x256 solid-colour PNG, written without any image library. */
function solidPng(r: number, g: number, b: number, size = 256): Buffer {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

interface RunResult {
  run: number;
  ok: boolean;
  seconds: number;
  bytes: number;
  exitCode: number | null;
  note: string;
  folder: string;
}

function snapshotGenerated(): Set<string> {
  try {
    return new Set(fs.readdirSync(GENERATED_DIR));
  } catch {
    return new Set();
  }
}

async function runOnce(run: number): Promise<RunResult> {
  const folder = dataPath('workers', `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}-${run}`);
  fs.mkdirSync(path.join(folder, 'out'), { recursive: true });
  const colours: [number, number, number][] = [
    [0x1f, 0x4f, 0xd8],
    [0xd9, 0x8a, 0x06],
    [0x1f, 0x9d, 0x55],
  ];
  fs.writeFileSync(path.join(folder, 'reference.png'), solidPng(...colours[(run - 1) % colours.length]!));
  fs.writeFileSync(path.join(folder, 'TASK.md'), taskFile());
  const before = snapshotGenerated();

  const started = Date.now();
  const events = fs.createWriteStream(path.join(folder, 'events.jsonl'));
  const child = spawn(
    'codex',
    [
      'exec',
      '--cd', folder,
      '--sandbox', 'workspace-write',
      '--skip-git-repo-check',
      '--color', 'never',
      '--json',
      '-o', path.join(folder, 'last-message.txt'),
      'Read TASK.md in this folder and do exactly what it says.',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME } },
  );
  child.stdout.pipe(events);
  const stderr: string[] = [];
  child.stderr.on('data', (d: Buffer) => stderr.push(d.toString()));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, TIMEOUT_S * 1000);

  const exitCode = await new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  clearTimeout(timer);
  events.end();
  fs.writeFileSync(path.join(folder, 'stderr.txt'), stderr.join(''));
  const seconds = Math.round((Date.now() - started) / 10) / 100;

  const outFile = path.join(folder, 'out', '01.png');
  let ok = false;
  let bytes = 0;
  let note = '';
  if (timedOut) note = `timed out after ${TIMEOUT_S}s`;
  else if (!fs.existsSync(outFile)) {
    const last = fs.existsSync(path.join(folder, 'last-message.txt')) ? fs.readFileSync(path.join(folder, 'last-message.txt'), 'utf8').trim() : '';
    note = `out/01.png missing. Last message: ${last.slice(0, 200) || '(none)'}`;
  } else {
    const buf = fs.readFileSync(outFile);
    bytes = buf.length;
    if (!buf.subarray(0, 8).equals(PNG_SIG)) note = 'out/01.png is not a PNG';
    else if (bytes < 10_000) note = `out/01.png is suspiciously small (${bytes} bytes)`;
    else ok = true;
  }
  const newGenerated = [...snapshotGenerated()].filter((f) => !before.has(f));
  if (newGenerated.length) note += `${note ? '; ' : ''}tool wrote ${newGenerated.length} file(s) under ${GENERATED_DIR}`;
  if (ok && !KEEP) {
    // Keep the evidence, drop nothing: the folder is small. (--keep is accepted for symmetry.)
  }
  return { run, ok, seconds, bytes, exitCode, note, folder };
}

async function main() {
  let version = 'not found';
  try {
    version = (await execFileP('codex', ['--version'])).stdout.trim().replace(/^codex-cli\s+/, '');
  } catch {
    console.error('Codex CLI is not installed or not on PATH.');
    process.exit(2);
  }
  const pinNote = version === VERSIONS.codexCli ? 'matches the pinned version' : `pinned is ${VERSIONS.codexCli}; update config/versions.ts if this passes`;
  console.log(`Codex CLI ${version} (${pinNote}). ${RUNS} run(s), ${TIMEOUT_S}s limit each. Folders under ${dataPath('workers')}.\n`);

  const results: RunResult[] = [];
  for (let i = 1; i <= RUNS; i++) {
    process.stdout.write(`Run ${i}/${RUNS}… `);
    const r = await runOnce(i);
    results.push(r);
    console.log(`${r.ok ? 'passed' : 'FAILED'} in ${r.seconds}s${r.bytes ? `, ${r.bytes} bytes` : ''}${r.note ? ` (${r.note})` : ''}`);
    if (!r.ok) console.log(`  See ${r.folder}`);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${RUNS} passed.`);
  console.log(passed === RUNS ? 'Codex non-interactive image generation confirmed.' : 'Not confirmed. Inspect events.jsonl and stderr.txt in the failed folders.');
  process.exit(passed === RUNS ? 0 : 1);
}

void main();
