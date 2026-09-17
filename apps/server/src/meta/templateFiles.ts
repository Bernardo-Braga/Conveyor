import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Template } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { templates } from '../db/schema.ts';
import { dropTokenKeys } from '../http/redact.ts';
import { looksLikeTemplate, parseTemplate } from './templates.ts';

/**
 * Templates are files. The folder `<data>/templates/` holds one JSON per template in the other
 * tool's format; the database row is an index of it. Drop an export into the folder and it is
 * picked up on the next sync; save from the Templates tab and the file is rewritten.
 */
export function templatesDir(dataDir: string): string {
  return path.join(dataDir, 'templates');
}

export function trashDir(dataDir: string): string {
  return path.join(templatesDir(dataDir), 'trash');
}

export function safeFileName(name: string): string {
  return `${name.trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'template'}.json`;
}

/** First run: copy the bundled template files in so the folder is never empty. */
export function seedTemplates(dataDir: string, seedDir: string): string[] {
  const dir = templatesDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (existing.length || !fs.existsSync(seedDir)) return [];
  const copied: string[] = [];
  for (const f of fs.readdirSync(seedDir).filter((x) => x.endsWith('.json'))) {
    fs.copyFileSync(path.join(seedDir, f), path.join(dir, f));
    copied.push(f);
  }
  return copied;
}

export interface SyncResult {
  added: string[];
  updated: string[];
  missing: string[];
  skipped: { file: string; reason: string }[];
}

/**
 * Reads every JSON in the folder, upserts by the template's own `id`, and marks rows whose file
 * is gone. A file that changed on disk (mtime) replaces the stored copy; the folder wins.
 */
export function syncTemplates(db: Db, dataDir: string): SyncResult {
  const dir = templatesDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const result: SyncResult = { added: [], updated: [], missing: [], skipped: [] };
  const seen = new Set<string>();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const full = path.join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      result.skipped.push({ file, reason: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!looksLikeTemplate(raw)) {
      result.skipped.push({ file, reason: 'not the other tool\'s template format' });
      continue;
    }
    let t: Template;
    try {
      t = parseTemplate(raw);
    } catch (err) {
      result.skipped.push({ file, reason: `does not validate: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` });
      continue;
    }
    const mtime = fs.statSync(full).mtime.toISOString();
    seen.add(t.id);
    const row = db.select().from(templates).where(eq(templates.templateId, t.id)).get();
    if (!row) {
      db.insert(templates).values({ templateId: t.id, name: t.name, version: t.version, source: 'folder', json: t, filePath: full, fileMtime: mtime, fileMissing: false }).run();
      result.added.push(file);
    } else if (row.filePath !== full || row.fileMtime !== mtime || row.fileMissing) {
      db.update(templates).set({ name: t.name, version: t.version, source: 'folder', json: t, filePath: full, fileMtime: mtime, fileMissing: false, updatedAt: new Date().toISOString() }).where(eq(templates.id, row.id)).run();
      result.updated.push(file);
    }
  }
  for (const row of db.select().from(templates).all()) {
    if (row.filePath && !seen.has(row.templateId) && !row.fileMissing) {
      db.update(templates).set({ fileMissing: true }).where(eq(templates.id, row.id)).run();
      result.missing.push(path.basename(row.filePath));
    }
  }
  return result;
}

/** Writes a template to its file (or a new one named after it) and updates the index row. */
export function writeTemplateFile(db: Db, dataDir: string, t: Template, preferredPath: string | null, source = 'tab'): { path: string; row: typeof templates.$inferSelect } {
  const dir = templatesDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  let file = preferredPath && path.dirname(preferredPath) === dir ? preferredPath : path.join(dir, safeFileName(t.name));
  if (!preferredPath) {
    let n = 2;
    while (fs.existsSync(file)) file = path.join(dir, safeFileName(`${t.name} ${n++}`));
  }
  const clean = dropTokenKeys(t);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
  fs.renameSync(tmp, file);
  const mtime = fs.statSync(file).mtime.toISOString();
  const existing = db.select().from(templates).where(eq(templates.templateId, t.id)).get();
  const row = existing
    ? db.update(templates).set({ name: t.name, version: t.version, source, json: clean, filePath: file, fileMtime: mtime, fileMissing: false, updatedAt: new Date().toISOString() }).where(eq(templates.id, existing.id)).returning().get()!
    : db.insert(templates).values({ templateId: t.id, name: t.name, version: t.version, source, json: clean, filePath: file, fileMtime: mtime, fileMissing: false }).returning().get();
  return { path: file, row };
}

/** Nothing is deleted outright: the file moves to templates/trash/ and the row goes. */
export function trashTemplate(db: Db, dataDir: string, id: number): string | null {
  const row = db.select().from(templates).where(eq(templates.id, id)).get();
  if (!row) return null;
  let moved: string | null = null;
  if (row.filePath && fs.existsSync(row.filePath)) {
    fs.mkdirSync(trashDir(dataDir), { recursive: true });
    moved = path.join(trashDir(dataDir), `${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(row.filePath)}`);
    fs.renameSync(row.filePath, moved);
  }
  db.delete(templates).where(eq(templates.id, id)).run();
  return moved;
}

/** A copy with a fresh id and version 1, so both can be edited apart. */
export function duplicateTemplate(t: Template, name?: string): Template {
  const id = `tmpl_${Math.random().toString(16).slice(2, 10)}`;
  return { ...t, id, name: name?.trim() || `${t.name} copy`, version: 1 };
}
