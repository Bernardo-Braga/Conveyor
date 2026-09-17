import { useEffect, useState } from 'react';
import { ListingWriterId, WRITER_LABELS, type ImportSettings } from '@conveyor/shared';
import { api } from '../lib/api.ts';
import { Button, Field, Panel, inputClass } from './Panel.tsx';

type Form = {
  multiplier: string;
  compareAtMarkupPercent: string;
  minimumMargin: string;
  agentFee1688: string;
  shippingEstimate: string;
  cnyMode: 'fixed' | 'daily';
  cnyFixed: string;
  brandVoice: string;
  writer: ImportSettings['listing']['writer'];
  showPhotos: boolean;
  tag: string;
  includeDescriptionImages: boolean;
};

const toForm = (s: ImportSettings): Form => ({
  multiplier: String(s.pricing.multiplier),
  compareAtMarkupPercent: String(s.pricing.compareAtMarkupPercent),
  minimumMargin: (s.pricing.minimumMarginMinor / 100).toFixed(2),
  agentFee1688: (s.pricing.agentFeeMinor1688 / 100).toFixed(2),
  shippingEstimate: (s.pricing.shippingEstimateMinor / 100).toFixed(2),
  cnyMode: s.pricing.cnyRate.mode,
  cnyFixed: s.pricing.cnyRate.fixed,
  brandVoice: s.listing.brandVoice,
  writer: s.listing.writer,
  showPhotos: s.listing.showPhotos,
  tag: s.listing.tag,
  includeDescriptionImages: s.listing.includeDescriptionImages,
});

const money = (s: string) => Math.round(Number.parseFloat(s) * 100);

/** Import settings, PLAN.md section 10: pricing and listing. Money is entered in dollars and stored in minor units. */
export function ImportSettingsPanel() {
  const [settings, setSettings] = useState<ImportSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.settings<ImportSettings>('import').then((s) => {
      setSettings(s);
      setForm(toForm(s));
    }).catch(() => undefined);
  }, []);
  if (!form || !settings) return null;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const valid = [form.multiplier, form.compareAtMarkupPercent, form.minimumMargin, form.agentFee1688, form.shippingEstimate, form.cnyFixed].every((v) => /^\d+(\.\d+)?$/.test(v)) && form.tag.trim().length > 0;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const next = await api.saveSettings<ImportSettings>('import', {
        ...settings,
        pricing: {
          multiplier: Number.parseFloat(form.multiplier),
          compareAtMarkupPercent: Number.parseFloat(form.compareAtMarkupPercent),
          minimumMarginMinor: money(form.minimumMargin),
          agentFeeMinor1688: money(form.agentFee1688),
          shippingEstimateMinor: money(form.shippingEstimate),
          cnyRate: { mode: form.cnyMode, fixed: form.cnyFixed },
        },
        listing: { ...settings.listing, brandVoice: form.brandVoice, writer: form.writer, showPhotos: form.showPhotos, tag: form.tag.trim(), includeDescriptionImages: form.includeDescriptionImages },
      });
      setSettings(next);
      setForm(toForm(next));
      setMsg('Saved. New imports use these values; existing drafts are unchanged.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Import"
      action={
        <Button kind="primary" disabled={!valid || busy} onClick={save}>
          Save
        </Button>
      }
    >
      <h3 className="text-xs font-semibold text-ink-2 uppercase tracking-wide mb-3">Pricing</h3>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Multiplier" hint="Price = landed cost × multiplier, rounded up to .99">
          <input className={inputClass} inputMode="decimal" value={form.multiplier} onChange={(e) => set('multiplier', e.target.value)} />
        </Field>
        <Field label="Compare-at markup %" hint="On top of the price">
          <input className={inputClass} inputMode="decimal" value={form.compareAtMarkupPercent} onChange={(e) => set('compareAtMarkupPercent', e.target.value)} />
        </Field>
        <Field label="Minimum margin ($)" hint="Price is raised to keep this">
          <input className={inputClass} inputMode="decimal" value={form.minimumMargin} onChange={(e) => set('minimumMargin', e.target.value)} />
        </Field>
        <Field label="1688 agent fee ($)">
          <input className={inputClass} inputMode="decimal" value={form.agentFee1688} onChange={(e) => set('agentFee1688', e.target.value)} />
        </Field>
        <Field label="Shipping estimate ($)">
          <input className={inputClass} inputMode="decimal" value={form.shippingEstimate} onChange={(e) => set('shippingEstimate', e.target.value)} />
        </Field>
        <Field label="CNY rate" hint={form.cnyMode === 'daily' ? 'One request per day for the rate' : 'USD per CNY, fixed'}>
          <div className="flex gap-2">
            <select className={inputClass} value={form.cnyMode} onChange={(e) => set('cnyMode', e.target.value as Form['cnyMode'])}>
              <option value="fixed">Fixed</option>
              <option value="daily">Daily</option>
            </select>
            <input className={inputClass} inputMode="decimal" value={form.cnyFixed} onChange={(e) => set('cnyFixed', e.target.value)} disabled={form.cnyMode === 'daily'} />
          </div>
        </Field>
      </div>

      <h3 className="text-xs font-semibold text-ink-2 uppercase tracking-wide mt-6 mb-3">Listing</h3>
      <div className="grid gap-4 md:grid-cols-2 mb-4">
        <Field label="Writer" hint="Claude Code and Codex run on your own plans and cost no API requests. A usage limit hands the work to the other one.">
          <select className={inputClass} value={form.writer} onChange={(e) => set('writer', e.target.value as Form['writer'])}>
            {ListingWriterId.options.map((id) => (
              <option key={id} value={id}>
                {WRITER_LABELS[id]}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-end gap-2 text-sm pb-2">
          <input type="checkbox" checked={form.showPhotos} onChange={(e) => set('showPhotos', e.target.checked)} />
          Show the writer up to four product photos
        </label>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Brand voice" hint="Given to the writer with every listing. Tone, audience, words to avoid.">
          <textarea className={`${inputClass} min-h-28`} value={form.brandVoice} onChange={(e) => set('brandVoice', e.target.value)} />
        </Field>
        <div className="space-y-4">
          <Field label="Tag" hint="Added to every product, with the platform name">
            <input className={inputClass} value={form.tag} onChange={(e) => set('tag', e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.includeDescriptionImages} onChange={(e) => set('includeDescriptionImages', e.target.checked)} />
            Include supplier description images in the draft
          </label>
          <p className="text-xs text-ink-3">Drafts are always created as Draft in Shopify. Photos are downloaded once from the supplier and cost no RapidAPI quota.</p>
        </div>
      </div>
      {msg && <p className="text-xs text-ink-3 mt-3">{msg}</p>}
    </Panel>
  );
}
