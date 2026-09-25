import type { ChildProcess } from 'node:child_process';

/** Start-at-login state, as the Settings page shows it. */
export interface AgentStatus {
  installed: boolean;
  loaded: boolean;
  /** The file that registers the service (a LaunchAgent plist on macOS). */
  plist: string;
  pid: number | null;
  webBuilt: boolean;
}

export interface StartAtLogin {
  status(dataDir: string, port: number): Promise<AgentStatus>;
  install(dataDir: string, port: number): Promise<AgentStatus>;
  uninstall(dataDir: string, port: number): Promise<AgentStatus>;
}

/** A command ready for spawn: the file to run and any arguments that go before the caller's. */
export interface ResolvedCommand {
  file: string;
  args: string[];
}

/** What differs between operating systems. Everything else in Conveyor is shared. */
export interface Platform {
  name: 'darwin' | 'win32';
  /** Where data lives when CONVEYOR_DATA_DIR is not set. */
  defaultDataDir(): string;
  /** The OS key store, as named in user-facing text. */
  keyStoreName: string;
  /** Zips the contents of `folder` (not the folder itself) into `file`. No shell. */
  zipFolder(folder: string, file: string): Promise<void>;
  /**
   * Turns a CLI name (`claude`, `codex`, `exiftool`) into something spawn can run without a
   * shell. `env` is the child's environment, whose PATH is searched.
   */
  resolveCommand(name: string, env: NodeJS.ProcessEnv): ResolvedCommand;
  /** Stops a child that ran out of time, including anything it started. */
  stopProcess(child: ChildProcess): void;
  /** Runs the server at login on 127.0.0.1, serving the built web app. */
  startAtLogin: StartAtLogin;
}
