import { desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import { costs, products, requests } from '../db/schema.ts';
import { env } from '../env.ts';
import { createBackup, listBackups, pruneBackups } from './backup.ts';
import { agentPaths, agentStatus, installAgent, uninstallAgent } from './launchAgent.ts';

export function opsRoutes(ctx: AppContext) {
  const r = new Hono();

  /** The Requests page (PLAN.md section 12): the ledger by day and service, by product, and the raw tail. */
  r.get('/ledger/overview', (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 14)));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const byDay = ctx.db
      .select({ day: sql<string>`substr(${requests.at}, 1, 10)`, service: requests.service, count: sql<number>`count(*)`, failed: sql<number>`sum(case when ${requests.ok} then 0 else 1 end)`, avgMs: sql<number>`round(avg(${requests.durationMs}))` })
      .from(requests)
      .where(sql`${requests.at} >= ${since}`)
      .groupBy(sql`1`, requests.service)
      .orderBy(sql`1 desc`)
      .all();
    const byService = ctx.db
      .select({ service: requests.service, total: sql<number>`count(*)`, failed: sql<number>`sum(case when ${requests.ok} then 0 else 1 end)`, today: sql<number>`sum(case when substr(${requests.at},1,10) = substr(${sql.raw(`'${new Date().toISOString()}'`)},1,10) then 1 else 0 end)` })
      .from(requests)
      .groupBy(requests.service)
      .all();
    const quota = ctx.db.select({ service: requests.service, quotaRemaining: requests.quotaRemaining, at: requests.at }).from(requests).where(sql`${requests.quotaRemaining} is not null`).orderBy(desc(requests.id)).limit(1).get() ?? null;
    return c.json({ days, byDay, byService, lastQuota: quota });
  });

  /** Per-product request and cost totals. Cost rows record plan runs (amount 0) and API usage. */
  r.get('/ledger/products', (c) => {
    const reqRows = ctx.db.select({ productId: requests.productId, service: requests.service, count: sql<number>`count(*)` }).from(requests).where(sql`${requests.productId} is not null`).groupBy(requests.productId, requests.service).all();
    // Costs are keyed by job; the job's product comes from the ledger. Aggregated here rather than in SQL.
    const jobProduct = new Map<number, number>();
    for (const r of ctx.db.select({ jobId: requests.jobId, productId: requests.productId }).from(requests).where(sql`${requests.jobId} is not null and ${requests.productId} is not null`).all()) jobProduct.set(r.jobId!, r.productId!);
    const costRows: { productId: number | null; service: string; runs: number; amountMinor: number }[] = [];
    for (const c of ctx.db.select().from(costs).all()) {
      const productId = c.jobId != null ? (jobProduct.get(c.jobId) ?? null) : null;
      const row = costRows.find((x) => x.productId === productId && x.service === c.service);
      if (row) {
        row.runs += 1;
        row.amountMinor += c.amountMinor;
      } else costRows.push({ productId, service: c.service, runs: 1, amountMinor: c.amountMinor });
    }
    const rows = ctx.db.select({ id: products.id, title: products.title, state: products.state, handle: products.shopifyHandle }).from(products).orderBy(desc(products.id)).all();
    return c.json(
      rows.map((p) => ({
        ...p,
        requests: Object.fromEntries(reqRows.filter((x) => x.productId === p.id).map((x) => [x.service, x.count])),
        totalRequests: reqRows.filter((x) => x.productId === p.id).reduce((n, x) => n + x.count, 0),
        runs: Object.fromEntries(costRows.filter((x) => x.productId === p.id).map((x) => [x.service, x.runs])),
        costMinor: costRows.filter((x) => x.productId === p.id).reduce((n, x) => n + (x.amountMinor ?? 0), 0),
      })),
    );
  });

  r.get('/ledger/recent', (c) => {
    const limit = Math.min(500, Number(c.req.query('limit') ?? 100));
    const service = c.req.query('service');
    const q = ctx.db.select().from(requests).orderBy(desc(requests.id)).limit(limit);
    return c.json(service ? q.where(eq(requests.service, service)).all() : q.all());
  });

  // Backups: one zip of the database (online backup), templates and product folders. No keys.
  r.get('/ops/backups', (c) => c.json({ dir: `${ctx.dataDir}/backups`, backups: listBackups(ctx.dataDir) }));
  r.post('/ops/backups', async (c) => {
    const info = await createBackup(ctx.opened.sqlite, ctx.dataDir);
    const pruned = pruneBackups(ctx.dataDir, 10);
    return c.json({ ...info, pruned }, 201);
  });

  // Start at login: a user LaunchAgent that runs the server on 127.0.0.1 and serves the built web app.
  r.get('/ops/launch-agent', async (c) => c.json(await agentStatus(agentPaths(ctx.dataDir, env.port))));
  r.post('/ops/launch-agent', async (c) => {
    if (env.isTest) return c.json({ error: 'Not available in tests' }, 400);
    return c.json(await installAgent(agentPaths(ctx.dataDir, env.port)));
  });
  r.delete('/ops/launch-agent', async (c) => {
    if (env.isTest) return c.json({ error: 'Not available in tests' }, 400);
    return c.json(await uninstallAgent(agentPaths(ctx.dataDir, env.port)));
  });

  r.get('/ops/info', (c) => c.json({ dataDir: ctx.dataDir, port: env.port, env: env.name, version: process.env.npm_package_version ?? null, node: process.version }));
  return r;
}
