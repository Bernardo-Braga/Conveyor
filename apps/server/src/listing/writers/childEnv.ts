/**
 * Claude Code and Codex must run on the user's plan login, never on an API key
 * (PLAN.md section 7 and section 13). `ANTHROPIC_API_KEY` in particular takes
 * precedence over the plan login in print mode, so every key is removed from the
 * child environment before either CLI starts.
 */
const BANNED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_API_KEY_HELPER',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

/** Also drop anything that merely looks like a key, so a new provider variable cannot leak in. */
const SUSPICIOUS = /(^|_)(API_KEY|APIKEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|CREDENTIALS)(_|$)/i;

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if ((BANNED as readonly string[]).includes(k)) continue;
    if (SUSPICIOUS.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export const BANNED_ENV_KEYS: readonly string[] = BANNED;

/** Names of key-like variables currently set, for the Connections warning. */
export function keyVarsInEnvironment(base: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(base).filter((k) => base[k] !== undefined && ((BANNED as readonly string[]).includes(k) || SUSPICIOUS.test(k)));
}
