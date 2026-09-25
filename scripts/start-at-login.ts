/**
 * Start at login from the terminal: `pnpm start-at-login install|uninstall|status`.
 * Same login service the Settings page installs (a LaunchAgent on macOS). Build the web app first (`pnpm build`).
 */
import { platform } from '../apps/server/src/platform/index.ts';
import { env } from '../apps/server/src/env.ts';

const cmd = process.argv[2] ?? 'status';
const { startAtLogin } = platform;
const run = cmd === 'install' ? startAtLogin.install : cmd === 'uninstall' ? startAtLogin.uninstall : startAtLogin.status;
run(env.dataDir, env.port)
  .then((s) => {
    console.log(JSON.stringify(s, null, 2));
    if (cmd === 'install' && !s.webBuilt) console.log('Note: apps/web/dist is missing; run pnpm build so the agent can serve the web app.');
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
