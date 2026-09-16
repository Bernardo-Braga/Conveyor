import { useEffect, useState } from 'react';
import type { ImportSettings, QuotaView } from '@conveyor/shared';
import { api, line } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';
import { Badge, Button, Field, Panel, inputClass } from './Panel.tsx';

/** RapidAPI quota per platform, read from response headers only, and the pause threshold. */
export function QuotaPanel({ refreshKey }: { refreshKey: string }) {
  const [quota, setQuota] = useState<QuotaView[]>([]);
  const [settings, setSettings] = useState<ImportSettings | null>(null);
  const [threshold, setThreshold] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    Promise.all([line.quota(), api.settings<ImportSettings>('import')]).then(([q, s]) => {
      setQuota(q);
      setSettings(s);
      setThreshold(String(s.quotaPauseThreshold));
    }).catch(() => undefined);
  useEffect(() => {
    void load();
  }, [refreshKey]);

  return (
    <Panel title="Import quota">
      <p className="text-sm text-ink-2 mb-3">Remaining requests come from RapidAPI response headers. Conveyor never makes a quota or test call, so the count is unknown until the first import. Imports pause below the threshold.</p>
      <div className="grid gap-3 md:grid-cols-2 mb-4">
        {quota.map((q) => (
          <div key={q.platform} className="border border-line rounded-panel px-4 py-3 bg-panel-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{q.platform === '1688' ? '1688' : 'AliExpress'}</span>
              {q.paused ? <Badge tone="amber">Paused</Badge> : q.remaining == null ? <Badge tone="grey">Unknown</Badge> : <Badge tone="green">Ready</Badge>}
            </div>
            <p className="text-2xl mt-1">{q.remaining ?? '—'}</p>
            <p className="text-xs text-ink-3">{q.updatedAt ? `Seen ${formatDateTime(q.updatedAt)}${q.resetAt ? `, resets ${formatDateTime(q.resetAt)}` : ''}` : 'No import yet'}</p>
          </div>
        ))}
      </div>
      <div className="flex items-end gap-2 max-w-sm">
        <Field label="Pause threshold" hint="Default 50">
          <input className={inputClass} inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </Field>
        <Button
          kind="primary"
          disabled={!settings || !/^\d+$/.test(threshold)}
          onClick={async () => {
            if (!settings) return;
            try {
              await api.saveSettings('import', { ...settings, quotaPauseThreshold: Number(threshold) });
              setMsg('Saved.');
              await load();
            } catch (e) {
              setMsg(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Save
        </Button>
      </div>
      {msg && <p className="text-xs text-ink-3 mt-2">{msg}</p>}
    </Panel>
  );
}
