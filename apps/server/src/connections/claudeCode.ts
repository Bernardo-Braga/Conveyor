import { childEnv, keyVarsInEnvironment } from '../listing/writers/index.ts';
import { runCli } from '../listing/writers/runCli.ts';
import { VERSIONS } from '../../../../config/versions.ts';
import { result, type ConnectionTester } from './types.ts';

interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string;
  apiProvider?: string;
}

/**
 * Local check, no network request of our own. It must fail when a run would not use the
 * plan login, so it reads `claude auth status` with the same stripped
 * environment the writer uses and rejects any auth method other than the Claude plan.
 */
export const testClaudeCode: ConnectionTester = async () => {
  const env = childEnv();
  const version = await runCli('claude', ['--version'], { cwd: process.cwd(), env, timeoutMs: 20_000 });
  if (version.code !== 0) return result('claude_code', false, 'Claude Code is not installed or not on PATH. Install it, then run "claude auth login".', 0);
  const installed = version.stdout.trim().split(/\s+/)[0] ?? 'unknown';

  const status = await runCli('claude', ['auth', 'status'], { cwd: process.cwd(), env, timeoutMs: 20_000 });
  let parsed: AuthStatus | null;
  try {
    parsed = JSON.parse(status.stdout.slice(status.stdout.indexOf('{'))) as AuthStatus;
  } catch {
    parsed = null;
  }
  if (!parsed?.loggedIn) return result('claude_code', false, `Claude Code ${installed} is installed but not signed in. Run "claude auth login" and choose your Claude plan.`, 0);
  if (parsed.authMethod !== 'claude.ai') {
    return result('claude_code', false, `Claude Code is signed in with "${parsed.authMethod ?? 'unknown'}", not a Claude plan. Conveyor's writer must run on the plan login, so this would be billed per request.`, 0);
  }

  const leaked = keyVarsInEnvironment();
  const pin = installed === VERSIONS.claudeCodeCli ? '' : ` Version ${installed} differs from the tested ${VERSIONS.claudeCodeCli}; run the writer smoke test before relying on it.`;
  const warn = leaked.length ? ` Note: ${leaked.join(', ')} is set in this server's environment; Conveyor removes it before every run, so the plan login is still used.` : '';
  return result('claude_code', true, `Claude Code ${installed}, signed in with a ${parsed.subscriptionType ?? 'Claude'} plan. Listings run on that plan, not on an API key.${pin}${warn}`, 0);
};
