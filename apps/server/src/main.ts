import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { createContext } from './context.ts';
import { env } from './env.ts';

const ctx = createContext();
const app = createApp(ctx);
ctx.worker.start();

const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
  console.log(`Conveyor server on http://${info.address}:${info.port} (${env.name}), data in ${env.dataDir}`);
});

async function shutdown(signal: string) {
  console.log(`\n${signal}: stopping`);
  server.close();
  await ctx.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
