import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { platform } from '../platform/index.ts';

export interface BackupInfo {
  file: string;
  name: string;
  bytes: number;
  createdAt: string;
}

export function backupsDir(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

/**
 * A backup is one zip: a consistent copy of the database (SQLite's online backup, not a file
 * copy, so a running server is fine), the templates folder and every product folder. Worker
 * scratch folders and earlier backups are left out. Keys live in the OS key store and are
 * never included.
 */
export async function createBackup(sqlite: Database.Database, dataDir: string, opts: { now?: Date; zipFolder?: typeof platform.zipFolder } = {}): Promise<BackupInfo> {
  const now = opts.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const staging = path.join(dataDir, 'backups', `.staging-${stamp}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    await sqlite.backup(path.join(staging, 'conveyor.sqlite'));
    for (const folder of ['templates', 'products']) {
      const src = path.join(dataDir, folder);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(staging, folder), { recursive: true, filter: (p) => !p.includes(`${path.sep}trash${path.sep}`) && !p.endsWith('.tmp') });
    }
    fs.writeFileSync(path.join(staging, 'README.txt'), ['Conveyor backup', `Created ${now.toISOString()}`, '', 'Restore: stop Conveyor, replace conveyor.sqlite, templates/ and products/ in the data directory with these, start Conveyor.', `Keys are not included; they stay in ${platform.keyStoreName}.`, ''].join('\n'));
    const file = path.join(backupsDir(dataDir), `conveyor-backup-${stamp}.zip`);
    await (opts.zipFolder ?? platform.zipFolder)(staging, file);
    const stat = fs.statSync(file);
    return { file, name: path.basename(file), bytes: stat.size, createdAt: now.toISOString() };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function listBackups(dataDir: string): BackupInfo[] {
  const dir = backupsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: path.join(dir, f), name: f, bytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keeps the newest `keep` backups. */
export function pruneBackups(dataDir: string, keep = 10): string[] {
  const removed: string[] = [];
  for (const b of listBackups(dataDir).slice(keep)) {
    fs.unlinkSync(b.file);
    removed.push(b.name);
  }
  return removed;
}
