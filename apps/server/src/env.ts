import os from 'node:os';
import path from 'node:path';

export type ConveyorEnv = 'development' | 'test' | 'production';

const envName = (process.env.CONVEYOR_ENV as ConveyorEnv | undefined) ?? 'development';

/** Data lives in ~/Library/Application Support/Conveyor/data unless overridden. */
export function defaultDataDir(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Conveyor', 'data');
}

export const env = {
  name: envName,
  isTest: envName === 'test',
  /** The server only ever binds to loopback. This is not configurable. */
  host: '127.0.0.1' as const,
  port: Number(process.env.CONVEYOR_PORT ?? 4310),
  dataDir: process.env.CONVEYOR_DATA_DIR ?? defaultDataDir(),
  /** `keychain` (default) or `memory` (tests only). */
  secrets: (process.env.CONVEYOR_SECRETS ?? 'keychain') as 'keychain' | 'memory',
  /** Keychain service name. Accounts are the SecretName values. */
  keychainService: process.env.CONVEYOR_KEYCHAIN_SERVICE ?? 'Conveyor',
} as const;

export function dataPath(...parts: string[]): string {
  return path.join(env.dataDir, ...parts);
}
