import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCAN = ['apps/server/src', 'scripts'];
const ONLY_HTTP_PATH = path.join('apps', 'server', 'src', 'http', 'ledgerClient.ts');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(d.name) ? [p] : [];
  });
}

/**
 * Every outside request goes through http/ledgerClient.ts.
 * ESLint enforces this too; this test is the second lock on the door.
 */
describe('one HTTP path', () => {
  const files = SCAN.flatMap((d) => walk(path.join(ROOT, d)));

  it('finds server sources to scan', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('calls fetch only in ledgerClient.ts', () => {
    const offenders = files
      .filter((f) => !f.endsWith(ONLY_HTTP_PATH))
      .filter((f) => /(^|[^.\w])fetch\s*\(/.test(stripComments(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('imports no other HTTP clients and never keytar', () => {
    const banned = /from\s+['"](undici|node-fetch|axios|got|node:http|node:https|http|https|keytar)['"]/;
    const offenders = files.filter((f) => banned.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('never calls a shell', () => {
    const banned = /\b(exec|execSync|spawnSync)\s*\(|shell:\s*true/;
    const offenders = files.filter((f) => banned.test(stripComments(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
