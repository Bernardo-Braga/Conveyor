import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDataDir } from '../src/env.ts';
import { platform } from '../src/platform/index.ts';

describe('platform', () => {
  it('picks the module for this OS, and the data folder comes from it', () => {
    expect(platform.name).toBe(process.platform);
    expect(defaultDataDir()).toBe(platform.defaultDataDir());
    if (process.platform === 'darwin') {
      expect(defaultDataDir()).toBe(path.join(os.homedir(), 'Library', 'Application Support', 'Conveyor', 'data'));
      expect(platform.keyStoreName).toBe('the macOS Keychain');
    }
  });
});
