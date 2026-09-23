import { useEffect, useState } from 'react';
import type { ImageSettings } from '@conveyor/shared';
import { api } from '../lib/api.ts';
import { Button, Field, Panel, inputClass } from './Panel.tsx';

/** Image engine settings, PLAN.md section 10. */
export function ImageSettingsPanel() {
  const [s, setS] = useState<ImageSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api.settings<ImageSettings>('images').then(setS).catch(() => undefined);
  }, []);
  if (!s) return null;
  const save = async () => {
    try {
      setS(await api.saveSettings<ImageSettings>('images', s));
      setMsg('Saved. Batches already running keep their settings.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Panel title="Image engine" action={<Button kind="primary" onClick={save}>Save</Button>}>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Engine" hint="Codex workers run on your ChatGPT plan and make no API requests">
          <select className={inputClass} value={s.engine} onChange={(e) => setS({ ...s, engine: e.target.value as ImageSettings['engine'] })}>
            <option value="codex">Codex workers (default)</option>
            <option value="openai">OpenAI API (gpt-image-2, billed per request)</option>
          </select>
        </Field>
        <Field label="Codex workers" hint="1 to 4 concurrent processes, each in its own folder">
          <input className={inputClass} inputMode="numeric" value={s.codex.workers} onChange={(e) => setS({ ...s, codex: { ...s.codex, workers: Number(e.target.value) || 1 } })} />
        </Field>
        <Field label="Images per task" hint="One task per format is faster; one per image isolates failures">
          <select className={inputClass} value={s.codex.imagesPerTask} onChange={(e) => setS({ ...s, codex: { ...s.codex, imagesPerTask: e.target.value as 'one' | 'format' } })}>
            <option value="format">All of a format</option>
            <option value="one">One</option>
          </select>
        </Field>
        <Field label="Time limit per image (s)" hint="Default 240">
          <input className={inputClass} inputMode="numeric" value={s.codex.timeLimitPerImageSec} onChange={(e) => setS({ ...s, codex: { ...s.codex, timeLimitPerImageSec: Number(e.target.value) || 240 } })} />
        </Field>
        <label className="flex items-end gap-2 text-sm pb-2">
          <input type="checkbox" checked={s.codex.handoffToOpenAI} onChange={(e) => setS({ ...s, codex: { ...s.codex, handoffToOpenAI: e.target.checked } })} />
          Hand off to OpenAI after a plan limit or two failures
        </label>
        <Field label="OpenAI quality" hint="Backup engine, gpt-image-2, one request per format">
          <select className={inputClass} value={s.openai.quality} onChange={(e) => setS({ ...s, openai: { ...s.openai, quality: e.target.value as ImageSettings['openai']['quality'] } })}>
            {['low', 'medium', 'high', 'auto'].map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Finished JPEG quality" hint="Always JPEG, 4:4:4 chroma, metadata removed">
          <input className={inputClass} inputMode="numeric" value={s.finished.quality} onChange={(e) => setS({ ...s, finished: { ...s.finished, quality: Number(e.target.value) || 90 } })} />
        </Field>
        <label className="flex items-end gap-2 text-sm pb-2">
          <input type="checkbox" checked={s.finished.exiftoolCheck} onChange={(e) => setS({ ...s, finished: { ...s.finished, exiftoolCheck: e.target.checked } })} />
          Check every finished file with exiftool when installed
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.shopify.addApproved} onChange={(e) => setS({ ...s, shopify: { ...s.shopify, addApproved: e.target.checked } })} />
          Also add approved images to the Shopify product (2 Shopify requests plus one upload per approval; off means Meta only, with the Studio button to send by hand)
        </label>
      </div>
      {msg && <p className="text-xs text-ink-3 mt-3">{msg}</p>}
    </Panel>
  );
}
