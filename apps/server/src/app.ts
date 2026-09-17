import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desc, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { ZodError } from 'zod';
import { ConnectionService, SecretName, SetSecretBody, SettingsSection } from '@conveyor/shared';
import { VERSIONS } from '../../../config/versions.ts';
import { connectionStatuses } from './connections/index.ts';
import { productRoutes } from './products/routes.ts';
import { imageRoutes } from './images/routes.ts';
import { metaRoutes } from './meta/routes.ts';
import type { AppContext } from './context.ts';
import { requests } from './db/schema.ts';
import { env } from './env.ts';
import { sseHandler } from './events/sse.ts';
import { redact } from './http/redact.ts';

const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

export function createApp(ctx: AppContext, opts: { serveWeb?: boolean } = {}) {
  const app = new Hono();

  app.onError(async (err, c) => {
    if (err instanceof ZodError) return c.json({ error: 'Invalid input', issues: err.issues }, 400);
    const secrets = await ctx.secrets.allValues();
    const message = redact(err instanceof Error ? err.message : String(err), secrets);
    if (!env.isTest) console.error(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path}: ${message}`);
    return c.json({ error: message }, 500);
  });

  const api = new Hono();

  api.get('/health', (c) => c.json({ ok: true, env: env.name, dataDir: env.dataDir, versions: VERSIONS, time: new Date().toISOString() }));
  api.get('/versions', (c) => c.json(VERSIONS));
  api.get('/events', sseHandler(ctx.bus));

  // Jobs
  api.get('/jobs', (c) => c.json(ctx.worker.list(Number(c.req.query('limit') ?? 50))));
  api.get('/jobs/:id', (c) => c.json(ctx.worker.view(Number(c.req.param('id')))));
  api.post('/jobs/:id/retry', (c) => c.json(ctx.worker.retry(Number(c.req.param('id')))));

  // Ledger (never headers or bodies: the table has none)
  api.get('/ledger', (c) => c.json(ctx.db.select().from(requests).orderBy(desc(requests.id)).limit(Number(c.req.query('limit') ?? 200)).all()));
  api.get('/ledger/summary', (c) =>
    c.json(
      ctx.db
        .select({
          day: sql<string>`substr(${requests.at}, 1, 10)`,
          service: requests.service,
          count: sql<number>`count(*)`,
          failed: sql<number>`sum(case when ${requests.ok} then 0 else 1 end)`,
        })
        .from(requests)
        .groupBy(sql`1`, requests.service)
        .orderBy(sql`1 desc`)
        .all(),
    ),
  );

  // Settings
  api.get('/settings/:section', (c) => c.json(ctx.settings.get(SettingsSection.parse(c.req.param('section')))));
  api.put('/settings/:section', async (c) => c.json(ctx.settings.set(SettingsSection.parse(c.req.param('section')), await c.req.json())));

  // Secrets: the browser learns set/unset and the last four characters, nothing more.
  api.get('/secrets', async (c) => c.json(await ctx.secrets.status()));
  api.put('/secrets/:name', async (c) => {
    const name = SecretName.parse(c.req.param('name'));
    const { value } = SetSecretBody.parse(await c.req.json());
    await ctx.secrets.set(name, value);
    return c.json({ ok: true });
  });
  api.delete('/secrets/:name', async (c) => {
    await ctx.secrets.delete(SecretName.parse(c.req.param('name')));
    return c.json({ ok: true });
  });

  // Connections
  api.get('/connections', async (c) => c.json(await connectionStatuses(ctx)));
  api.post('/connections/:service/test', (c) => {
    const service = ConnectionService.parse(c.req.param('service'));
    return c.json(ctx.worker.enqueue('connection_test', { service }), 202);
  });

  api.route('/', productRoutes(ctx));
  api.route('/', imageRoutes(ctx));
  api.route('/', metaRoutes(ctx));
  app.route('/api', api);
  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.text('Not found', 404)));

  // Built web app, when present. In development Vite serves it and proxies /api here.
  if ((opts.serveWeb ?? !env.isTest) && fs.existsSync(WEB_DIST)) {
    app.use('/*', serveStatic({ root: path.relative(process.cwd(), WEB_DIST) }));
    app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.html(fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8'))));
  }

  return app;
}
