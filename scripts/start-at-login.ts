/**
 * Start at login from the terminal: `pnpm start-at-login install|uninstall|status`.
 * Same LaunchAgent the Settings page installs. Build the web app first (`pnpm build`).
 */
import { agentPaths, agentStatus, installAgent, uninstallAgent } from '../apps/server/src/ops/launchAgent.ts';
import { env } from '../apps/server/src/env.ts';

const cmd = process.argv[2] ?? 'status';
const paths = agentPaths(env.dataDir, env.port);
const run = cmd === 'install' ? installAgent : cmd === 'uninstall' ? uninstallAgent : agentStatus;
run(paths)
  .then((s) => {
    console.log(JSON.stringify(s, null, 2));
    if (cmd === 'install' && !s.webBuilt) console.log('Note: apps/web/dist is missing; run pnpm build so the agent can serve the web app.');
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
