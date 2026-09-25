import type { Platform } from './types.ts';

export type { AgentStatus, Platform, ResolvedCommand } from './types.ts';

/**
 * The one place that picks the OS. Each platform folder is imported only on its own OS, so a
 * release built for one platform can leave the other folders out.
 */
async function load(): Promise<Platform> {
  switch (process.platform) {
    case 'darwin':
      return (await import('./darwin/index.ts')).darwin;
    case 'win32':
      return (await import('./win32/index.ts')).win32;
    default:
      throw new Error(`Conveyor does not support ${process.platform} yet.`);
  }
}

export const platform = await load();
