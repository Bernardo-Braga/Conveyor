import { useCallback, useEffect, useState } from 'react';
import type { ConnectionSettings, ConnectionStatus, SecretName, SecretStatus } from '@conveyor/shared';
import { Badge, Button, Field, Panel, inputClass } from '../components/Panel.tsx';
import { api } from '../lib/api.ts';
import type { LiveState } from '../lib/events.ts';
import { formatDateTime } from '../lib/format.ts';
import { QuotaPanel } from '../components/QuotaPanel.tsx';
import { ImportSettingsPanel } from '../components/ImportSettingsPanel.tsx';
import { ImageSettingsPanel } from '../components/ImageSettingsPanel.tsx';
import { PromptTemplatesPanel } from '../components/PromptTemplatesPanel.tsx';

const SECRET_LABELS: Record<SecretName, string> = {
  rapidapi_key: 'RapidAPI key',
  claude_api_key: 'Claude API key',
  openai_api_key: 'OpenAI API key',
  shopify_client_id: 'Shopify client ID',
  shopify_client_secret: 'Shopify client secret',
  meta_access_token: 'Meta access token',
};

const SERVICE_LABELS: Record<ConnectionStatus['service'], string> = {
  rapidapi: 'RapidAPI',
  claude_code: 'Claude Code',
  claude: 'Claude API',
  shopify: 'Shopify',
  openai: 'OpenAI',
  codex: 'Codex CLI',
  meta: 'Meta',
};

/** Conveyor works without these; a blank row is not a problem. */
const OPTIONAL: ReadonlySet<ConnectionStatus['service']> = new Set(['claude', 'openai']);

export function SettingsView({ live }: { live: LiveState }) {
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [conn, setConn] = useState<ConnectionSettings | null>(null);
  const [statuses, setStatuses] = useState<ConnectionStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, c, st] = await Promise.all([api.secrets(), api.settings<ConnectionSettings>('connections'), api.connections()]);
      setSecrets(s);
      setConn(c);
      setStatuses(st);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-read connection status when a connection test job finishes.
  const finished = [...live.jobs.values()].filter((j) => j.type === 'connection_test' && (j.status === 'done' || j.status === 'failed')).map((j) => `${j.id}:${j.status}`).join(',');
  useEffect(() => {
    if (finished) void refresh();
  }, [finished, refresh]);

  return (
    <div className="space-y-6">
      {error && <div className="px-4 py-2 rounded-md bg-red-soft text-red text-sm">{error}</div>}

      <Panel title="Connections">
        <p className="text-sm text-ink-2 mb-4">
          Keys are stored in the macOS Keychain and never leave this Mac. Claude Code and Codex run on your own plans, so their tests are local and need no key. The other tests make one read-only call each. RapidAPI has no test: its status comes from the last import.
        </p>
        <div className="divide-y divide-line">
          {statuses.map((s) => (
            <ConnectionRow key={s.service} status={s} live={live} />
          ))}
        </div>
      </Panel>

      <Panel title="Keys">
        <div className="grid gap-4 md:grid-cols-2">
          {secrets.map((s) => (
            <SecretField key={s.name} status={s} onChange={refresh} />
          ))}
        </div>
      </Panel>

      {conn && <ConnectionSettingsForm value={conn} onSaved={refresh} />}

      <QuotaPanel refreshKey={finished} />

      <ImportSettingsPanel />

      <ImageSettingsPanel />

      <PromptTemplatesPanel />
    </div>
  );
}

function ConnectionRow({ status, live }: { status: ConnectionStatus; live: LiveState }) {
  const [busy, setBusy] = useState(false);
  const running = [...live.jobs.values()].some((j) => j.type === 'connection_test' && (j.status === 'running' || j.status === 'queued') && (j.progress as { service?: string } | null)?.service === status.service);
  const last = status.last;
  return (
    <div className="py-3 flex items-start gap-4">
      <div className="w-28 shrink-0 text-sm font-medium pt-1">
        {SERVICE_LABELS[status.service]}
        {OPTIONAL.has(status.service) && <span className="block text-xs font-normal text-ink-3">Optional</span>}
      </div>
      <div className="flex-1 min-w-0 text-sm">
        {!status.configured && <p className="text-ink-3">{OPTIONAL.has(status.service) ? `Not set up. ${status.missing.join(', ')} would be needed.` : `Missing: ${status.missing.join(', ')}`}</p>}
        {last && (
          <p className={last.ok ? 'text-ink-2' : 'text-red'}>
            {last.detail}
            <span className="text-ink-3"> · {formatDateTime(last.checkedAt)}{last.requests ? ` · ${last.requests} request${last.requests === 1 ? '' : 's'}` : ' · no request'}</span>
          </p>
        )}
        {status.configured && !last && <p className="text-ink-3">Not tested yet.</p>}
      </div>
      <div className="shrink-0 flex items-center gap-2 pt-0.5">
        {last && <Badge tone={last.ok ? 'green' : 'red'}>{last.ok ? 'Working' : 'Failed'}</Badge>}
        {status.service !== 'rapidapi' && (
          <Button
            disabled={!status.configured || busy || running}
            onClick={async () => {
              setBusy(true);
              try {
                await api.testConnection(status.service);
              } finally {
                setBusy(false);
              }
            }}
          >
            {running || busy ? 'Testing' : 'Test'}
          </Button>
        )}
      </div>
    </div>
  );
}

function SecretField({ status, onChange }: { status: SecretStatus; onChange: () => Promise<void> }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Field label={SECRET_LABELS[status.name]} hint={status.set ? `Set, ending in ${status.hint}${status.updatedAt ? `, updated ${formatDateTime(status.updatedAt)}` : ''}` : 'Not set'}>
      <div className="flex gap-2">
        <input className={inputClass} type="password" autoComplete="off" placeholder={status.set ? 'Replace' : 'Paste the key'} value={value} onChange={(e) => setValue(e.target.value)} />
        <Button
          kind="primary"
          disabled={!value.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.setSecret(status.name, value.trim());
              setValue('');
              await onChange();
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </Button>
        {status.set && (
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.deleteSecret(status.name);
                await onChange();
              } finally {
                setBusy(false);
              }
            }}
          >
            Clear
          </Button>
        )}
      </div>
    </Field>
  );
}

function ConnectionSettingsForm({ value, onSaved }: { value: ConnectionSettings; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState(value);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => setForm(value), [value]);
  const set = (path: 'shopify' | 'meta', key: string, v: string) => setForm((f) => ({ ...f, [path]: { ...f[path], [key]: v } }));

  return (
    <Panel
      title="Accounts"
      action={
        <Button
          kind="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              await api.saveSettings('connections', form);
              await onSaved();
              setMsg('Saved.');
            } catch (e) {
              setMsg(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Shopify store domain" hint="my-store.myshopify.com">
          <input className={inputClass} value={form.shopify.storeDomain} onChange={(e) => set('shopify', 'storeDomain', e.target.value)} />
        </Field>
        <Field label="Meta ad account ID" hint="act_123…">
          <input className={inputClass} value={form.meta.adAccountId} onChange={(e) => set('meta', 'adAccountId', e.target.value)} />
        </Field>
        <Field label="Meta Page ID">
          <input className={inputClass} value={form.meta.pageId} onChange={(e) => set('meta', 'pageId', e.target.value)} />
        </Field>
        <Field label="Instagram account ID">
          <input className={inputClass} value={form.meta.instagramUserId} onChange={(e) => set('meta', 'instagramUserId', e.target.value)} />
        </Field>
        <Field label="Pixel ID">
          <input className={inputClass} value={form.meta.pixelId} onChange={(e) => set('meta', 'pixelId', e.target.value)} />
        </Field>
        <Field label="Test ad account ID" hint="Used by the phase 6 launch test only">
          <input className={inputClass} value={form.meta.testAdAccountId} onChange={(e) => set('meta', 'testAdAccountId', e.target.value)} />
        </Field>
      </div>
      {msg && <p className="text-xs text-ink-3 mt-3">{msg}</p>}
    </Panel>
  );
}
