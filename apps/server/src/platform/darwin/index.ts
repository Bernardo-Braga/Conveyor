import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Platform } from '../types.ts';
import { launchAgent } from './startAtLogin.ts';

const execFileP = promisify(execFile);

export const darwin: Platform = {
  name: 'darwin',
  defaultDataDir: () => path.join(os.homedir(), 'Library', 'Application Support', 'Conveyor', 'data'),
  keyStoreName: 'the macOS Keychain',
  // ditto is the macOS archiver; execFile, never a shell.
  zipFolder: async (folder, file) => {
    await execFileP('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', folder, file]);
  },
  // PATH lookup in spawn already finds the CLIs as they install on macOS.
  resolveCommand: (name) => ({ file: name, args: [] }),
  stopProcess: (child) => {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  },
  startAtLogin: launchAgent,
};
