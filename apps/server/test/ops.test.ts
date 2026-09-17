import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { costs, products, requests } from '../src/db/schema.ts';
import { createBackup, listBackups, pruneBackups } from '../src/ops/backup.ts';
import { LABEL, agentPaths, agentStatus, plistFor } from '../src/ops/launchAgent.ts';
import { templatesDir } from '../src/meta/templateFiles.ts';
import { testContext } from './helpers.ts';

describe('Requests page data', () => {
  it('summarises by day and service, per product, and lists the tail without headers or bodies', async () => {
    const ctx = testContext();
    const app = createApp(ctx);
    const pid = ctx.db.insert(products).values({ origin: 'link', platform: 'aliexpress', itemId: '1', state: 'review', title: 'Mug' }).returning({ id: products.id }).get().id;
    const now = new Date().toISOString();
    ctx.db.insert(requests).values([
      { at: now, service: 'rapidapi', purpose: 'item_detail', productId: pid, jobId: 1, method: 'GET', url: 'https://x/a', status: 200, ok: true, durationMs: 120, quotaRemaining: 97 },
      { at: now, service: 'shopify', purpose: 'product_set', productId: pid, jobId: 2, method: 'POST', url: 'https://x/b', status: 200, ok: true, durationMs: 300 },
      { at: now, service: 'shopify', purpose: 'access_token', productId: null, jobId: 2, method: 'POST', url: 'https://x/t', status: 500, ok: false, durationMs: 50, error: 'HTTP 500' },
    ]).run();
    ctx.db.insert(costs).values([{ jobId: 2, service: 'claude_code', units: { attempts: 1 }, amountMinor: 3 }, { jobId: 9, service: 'openai', units: {}, amountMinor: 120 }]).run();

    const overview = (await (await app.request('/api/ledger/overview?days=7')).json()) as { byService: { service: string; total: number; failed: number; today: number }[]; byDay: { service: string; count: number }[]; lastQuota: { quotaRemaining: number } };
    expect(overview.byService.find((s) => s.service === 'shopify')).toMatchObject({ total: 2, failed: 1, today: 2 });
    expect(overview.byDay.find((d) => d.service === 'rapidapi')?.count).toBe(1);
    expect(overview.lastQuota.quotaRemaining).toBe(97);

    const per = (await (await app.request('/api/ledger/products')).json()) as { id: number; totalRequests: number; requests: Record<string, number>; runs: Record<string, number>; costMinor: number }[];
    expect(per[0]).toMatchObject({ id: pid, totalRequests: 2, requests: { rapidapi: 1, shopify: 1 }, runs: { claude_code: 1 }, costMinor: 3 });

    const recent = (await (await app.request('/api/ledger/recent?service=shopify')).json()) as Record<string, unknown>[];
    expect(recent).toHaveLength(2);
    expect(Object.keys(recent[0]!)).not.toContain('headers');
    expect(Object.keys(recent[0]!)).not.toContain('body');
    await ctx.close();
  });
});

describe('backups', () => {
  it('writes one zip with a consistent database copy, templates and products, then prunes to the newest ten', async () => {
    const ctx = testContext();
    fs.mkdirSync(templatesDir(ctx.dataDir), { recursive: true });
    fs.writeFileSync(path.join(templatesDir(ctx.dataDir), 'a.json'), '{}');
    fs.mkdirSync(path.join(ctx.dataDir, 'products', '1'), { recursive: true });
    fs.writeFileSync(path.join(ctx.dataDir, 'products', '1', 'photo-0.jpg'), 'x');
    fs.mkdirSync(path.join(ctx.dataDir, 'workers', 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(ctx.dataDir, 'workers', 'scratch', 'big.bin'), 'y');
    await ctx.secrets.set('meta_access_token', 'EAANeverInBackup000000000');
    ctx.db.insert(products).values({ origin: 'link', state: 'importing', title: 'Backed up' }).run();

    const info = await createBackup(ctx.opened.sqlite, ctx.dataDir, { now: new Date('2026-09-17T12:00:00Z') });
    expect(info.name).toBe('conveyor-backup-2026-09-17T12-00-00.zip');
    expect(info.bytes).toBeGreaterThan(500);
    const listing = fs.readdirSync(path.join(ctx.dataDir, 'backups'));
    expect(listing).toEqual([info.name]); // staging folder cleaned up

    // Inspect the archive with ditto (extract to a temp dir).
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-unzip-'));
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => execFile('/usr/bin/ditto', ['-x', '-k', info.file, out], (err) => (err ? reject(err) : resolve())));
    // ditto archives the staging folder's contents, so they land directly in `out`.
    const base = out;
    const files = fs.readdirSync(base).filter((f) => !f.startsWith('.')).sort();
    expect(files).toEqual(['README.txt', 'conveyor.sqlite', 'products', 'templates']);
    expect(fs.existsSync(path.join(base, 'workers'))).toBe(false);
    const Database = (await import('better-sqlite3')).default;
    const copy = new Database(path.join(base, 'conveyor.sqlite'), { readonly: true });
    expect((copy.prepare('select title from products').get() as { title: string }).title).toBe('Backed up');
    const dump = fs.readFileSync(path.join(base, 'conveyor.sqlite'));
    expect(dump.includes('NeverInBackup')).toBe(false);
    copy.close();
    fs.rmSync(out, { recursive: true, force: true });

    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(ctx.dataDir, 'backups', `conveyor-backup-2026-01-${String(i + 1).padStart(2, '0')}T00-00-00.zip`), 'z');
    expect(listBackups(ctx.dataDir)).toHaveLength(13);
    const pruned = pruneBackups(ctx.dataDir, 10);
    expect(pruned).toHaveLength(3);
    expect(listBackups(ctx.dataDir)).toHaveLength(10);
    await ctx.close();
  });
});

describe('start at login', () => {
  it('the plist runs node on the tsx loader with no shell, binds the data dir and port, and status reads launchctl', async () => {
    const p = agentPaths('/Users/x/Library/Application Support/Conveyor/data', 4310);
    const plist = plistFor(p);
    expect(plist).toContain(`<string>${LABEL}</string>`);
    expect(plist).toContain('<string>' + p.node + '</string>');
    expect(plist).toContain('tsx/dist/cli.mjs');
    expect(plist).toContain('apps/server/src/main.ts');
    expect(plist).toContain('<key>CONVEYOR_DATA_DIR</key><string>/Users/x/Library/Application Support/Conveyor/data</string>');
    expect(plist).toContain('<key>CONVEYOR_PORT</key><string>4310</string>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).not.toMatch(/\/bin\/(ba|z)?sh/);
    expect(p.plist.endsWith(`Library/LaunchAgents/${LABEL}.plist`)).toBe(true);

    const fakeRun = (async (_file: string, args: readonly string[]) => {
      if (args[0] === 'print') return { stdout: `${LABEL} = {\n\tpid = 4242\n\tstate = running\n}`, stderr: '' };
      return { stdout: '', stderr: '' };
    }) as unknown as Parameters<typeof agentStatus>[1];
    const st = await agentStatus(p, fakeRun);
    expect(st).toMatchObject({ loaded: true, pid: 4242, installed: false });
    const down = (async () => {
      throw new Error('not found');
    }) as unknown as Parameters<typeof agentStatus>[1];
    expect((await agentStatus(p, down)).loaded).toBe(false);
  });
});
