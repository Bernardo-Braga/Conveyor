import { useEffect, useState } from 'react';
import { FillRule, type AdSetupSettings } from '@conveyor/shared';
import { api } from '../lib/api.ts';
import { Button, Field, Panel, inputClass } from './Panel.tsx';

const FILL_LABELS: Record<AdSetupSettings['fillRule'], string> = {
  one_per_ad: 'Same creatives in every ad set (default)',
  rotate: 'Rotate creatives across all ad slots',
  one_per_adset: 'One creative per ad set',
  by_format: 'By format: 9:16 into Reels and Stories ad sets',
  manual: 'Manual (board, phase 7)',
};

/** Ad setup: the Conveyor-side choices around a template. */
export function AdSetupPanel() {
  const [s, setS] = useState<AdSetupSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api.settings<AdSetupSettings>('adsetup').then(setS).catch(() => undefined);
  }, []);
  if (!s) return null;
  return (
    <Panel
      title="Ad setup"
      action={
        <Button
          kind="primary"
          onClick={async () => {
            try {
              setS(await api.saveSettings<AdSetupSettings>('adsetup', s));
              setMsg('Saved.');
            } catch (e) {
              setMsg(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Save
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Fill rule" hint="How approved creatives are placed into ads">
          <select className={inputClass} value={s.fillRule} onChange={(e) => setS({ ...s, fillRule: FillRule.parse(e.target.value) })}>
            {FillRule.options.map((f) => (
              <option key={f} value={f}>
                {FILL_LABELS[f]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="URL parameters" hint="{{campaign}} is filled at launch">
          <input className={inputClass} value={s.urlParams} onChange={(e) => setS({ ...s, urlParams: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.readInterestsFromNames} onChange={(e) => setS({ ...s, readInterestsFromNames: e.target.checked })} />
          Read interests from ad set names
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.keepTimeOfDay} onChange={(e) => setS({ ...s, keepTimeOfDay: e.target.checked })} />
          When a template's start time is in the past, keep its time of day and use the next occurrence
        </label>
        <p className="text-xs text-ink-3 md:col-span-2">Create paused: always on. Ad set budget sharing: always off for ABO. Activation is a separate button on the Launch view.</p>
      </div>
      {msg && <p className="text-xs text-ink-3 mt-3">{msg}</p>}
    </Panel>
  );
}
