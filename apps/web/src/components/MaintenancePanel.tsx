import { useEffect, useState } from 'react';
import { ops, type AgentStatus, type BackupInfo } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';
import { Badge, Button, Panel } from './Panel.tsx';

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

/** Backups and start at login. */
export function MaintenancePanel() {
  const [backups, setBackups] = useState<{ dir: string; backups: BackupInfo[] } | null>(null);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [info, setInfo] = useState<{ dataDir: string; port: number; env: string; node: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => Promise.all([ops.backups().then(setBackups), ops.agent().then(setAgent), ops.info().then(setInfo)]).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);
  const act = async (fn: () => Promise<unknown>, note: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(note);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Maintenance">
      {info && (
        <p className="text-xs text-ink-3 mb-4 break-all">
          Data: <code>{info.dataDir}</code> · port {info.port} · {info.env} · Node {info.node}. Backing up the data folder backs up everything except keys, which stay in the Keychain.
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-ink-2 uppercase tracking-wide">Backups</h3>
            <Button kind="primary" disabled={busy} onClick={() => act(() => ops.backupNow(), 'Backup written. The ten newest are kept.')}>
              Back up now
            </Button>
          </div>
          <p className="text-xs text-ink-3 mb-2">One zip: a consistent copy of the database, the templates folder and every product folder. Worker scratch is left out.</p>
          <ul className="text-xs divide-y divide-line border border-line rounded-md">
            {backups?.backups.map((b) => (
              <li key={b.name} className="px-3 py-1.5 flex justify-between">
                <span className="truncate">{b.name}</span>
                <span className="text-ink-3">
                  {mb(b.bytes)} · {formatDateTime(b.createdAt)}
                </span>
              </li>
            ))}
            {backups && backups.backups.length === 0 && <li className="px-3 py-2 text-ink-3">No backups yet.</li>}
          </ul>
          {backups && <p className="text-xs text-ink-3 mt-1 break-all">{backups.dir}</p>}
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-ink-2 uppercase tracking-wide">Start at login</h3>
            {agent && (agent.loaded ? (
              <Button disabled={busy} onClick={() => act(() => ops.uninstallAgent(), 'Removed. Conveyor no longer starts at login.')}>
                Turn off
              </Button>
            ) : (
              <Button kind="primary" disabled={busy || !agent.webBuilt} onClick={() => act(() => ops.installAgent(), 'Installed. Conveyor starts at login and stays running.')}>
                Turn on
              </Button>
            ))}
          </div>
          {agent && (
            <p className="text-xs text-ink-2 mb-2 flex items-center gap-2">
              {agent.loaded ? <Badge tone="green">Running as a LaunchAgent{agent.pid ? ` · pid ${agent.pid}` : ''}</Badge> : agent.installed ? <Badge tone="amber">Installed, not loaded</Badge> : <Badge tone="grey">Off</Badge>}
            </p>
          )}
          <p className="text-xs text-ink-3">
            A user LaunchAgent runs the server on 127.0.0.1 and serves the built web app at <code>http://127.0.0.1:{info?.port ?? 4310}</code>, so the dev server is not needed.
            {agent && !agent.webBuilt && <span className="text-amber"> Build the web app first: <code>pnpm build</code>.</span>}
          </p>
          {agent && <p className="text-xs text-ink-3 mt-1 break-all">{agent.plist}</p>}
        </div>
      </div>
      {msg && <p className="text-xs text-ink-3 mt-3">{msg}</p>}
    </Panel>
  );
}
