import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERSIONS } from '../../../../config/versions.ts';
import { runCli } from '../listing/writers/runCli.ts';
import { result, type ConnectionTester } from './types.ts';

export interface CodexCheck {
  installed: boolean;
  version: string | null;
  pinned: string;
  signedIn: boolean;
  authFile: string;
}

/** Local only: no network request. Reads the CLI version and whether an auth file exists. */
export async function checkCodex(codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')): Promise<CodexCheck> {
  const authFile = path.join(codexHome, 'auth.json');
  const res = await runCli('codex', ['--version'], { cwd: process.cwd(), env: process.env, timeoutMs: 10_000 });
  const version = res.code === 0 ? res.stdout.trim().replace(/^codex-cli\s+/, '') || null : null;
  return { installed: version != null, version, pinned: VERSIONS.codexCli, signedIn: fs.existsSync(authFile), authFile };
}

export const testCodex: ConnectionTester = async () => {
  const c = await checkCodex();
  if (!c.installed) return result('codex', false, 'Codex CLI is not installed or not on PATH. Install it and sign in with ChatGPT.', 0);
  if (!c.signedIn) return result('codex', false, `Codex CLI ${c.version} found, but no sign-in. Run "codex login" in a terminal.`, 0);
  const pinNote = c.version === c.pinned ? '' : ` Version ${c.version} differs from the tested ${c.pinned}; run the smoke test before relying on it.`;
  return result('codex', true, `Codex CLI ${c.version} is installed and signed in.${pinNote}`, 0);
};
