import { useState } from 'react';
import type { CreativeView, InterestRef, LaunchAd, LaunchAdSet, LaunchStructure } from '@conveyor/shared';
import { Badge, Button, inputClass } from './Panel.tsx';
import { formatMoney } from '../lib/format.ts';

export interface BoardProps {
  structure: LaunchStructure;
  mode: 'CBO' | 'ABO';
  creatives: CreativeView[];
  /** The product's saved copy and the template's example copy. */
  copies: { label: string; primaryText: string; headline: string; description: string; destinationUrl: string }[];
  onChange: (next: LaunchStructure) => void;
  /** Re-reads the interest for a renamed ad set (0 requests when cached, else 1 batch). */
  onRename: (index: number, name: string) => Promise<LaunchAdSet | null>;
  busy: boolean;
}

/**
 * The structure editor: one column per ad set, one card per ad.
 * Everything here is local until "Create campaign" or "Save as template".
 */
export function Board({ structure, mode, creatives, copies, onChange, onRename, busy }: BoardProps) {
  const [renaming, setRenaming] = useState<{ index: number; name: string } | null>(null);
  const [interestInput, setInterestInput] = useState<{ index: number; text: string } | null>(null);
  const update = (index: number, patch: Partial<LaunchAdSet>) => onChange({ ...structure, adSets: structure.adSets.map((s) => (s.index === index ? { ...s, ...patch } : s)) });
  const defaultCopy = copies[0];

  const addAdSet = () => {
    const index = Math.max(-1, ...structure.adSets.map((s) => s.index)) + 1;
    const template = structure.adSets[0];
    onChange({ ...structure, adSets: [...structure.adSets, { index, name: `${structure.campaignName} – US - Broad`, budgetMinor: mode === 'ABO' ? (template?.budgetMinor ?? 2000) : null, interestKind: 'broad', interestLabel: null, interests: [], suggestions: [], countryOverride: null, ageBand: null, ads: template ? template.ads.map((a) => ({ ...a })) : [] }] });
  };
  const addAd = (index: number) => {
    const set = structure.adSets.find((s) => s.index === index)!;
    const used = new Set(set.ads.map((a) => a.creativeId));
    const next = creatives.find((c) => !used.has(c.id)) ?? creatives[0];
    if (!next || !defaultCopy) return;
    update(index, { ads: [...set.ads, { creativeId: next.id, fileName: next.fileName ?? `creative-${next.id}.jpg`, primaryText: defaultCopy.primaryText, headline: defaultCopy.headline, description: defaultCopy.description, destinationUrl: defaultCopy.destinationUrl }] });
  };
  const setAd = (index: number, j: number, patch: Partial<LaunchAd>) => {
    const set = structure.adSets.find((s) => s.index === index)!;
    update(index, { ads: set.ads.map((a, k) => (k === j ? { ...a, ...patch } : a)) });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input className={`${inputClass} max-w-md`} value={structure.campaignName} onChange={(e) => onChange({ ...structure, campaignName: e.target.value })} />
        <Button onClick={addAdSet} disabled={busy}>
          Add ad set
        </Button>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {structure.adSets.map((s) => (
          <div key={s.index} className="w-64 shrink-0 border border-line rounded-panel bg-panel-2 p-3 space-y-2 text-xs">
            {renaming?.index === s.index ? (
              <form
                className="flex gap-1"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const name = renaming.name.trim();
                  setRenaming(null);
                  if (!name || name === s.name) return;
                  const re = await onRename(s.index, name);
                  update(s.index, { name, ...(re ? { interestKind: re.interestKind, interestLabel: re.interestLabel, interests: re.interests, suggestions: re.suggestions } : {}) });
                }}
              >
                <input className={inputClass} autoFocus value={renaming.name} onChange={(e) => setRenaming({ index: s.index, name: e.target.value })} />
                <Button kind="primary" type="submit" className="!px-2">
                  OK
                </Button>
              </form>
            ) : (
              <p className="font-medium text-sm truncate cursor-text" title="Click to rename; the interest is re-read from the name" onClick={() => setRenaming({ index: s.index, name: s.name })}>
                {s.name}
              </p>
            )}
            <p className="text-ink-3">
              {mode === 'ABO' ? (
                <label className="flex items-center gap-1">
                  $<input className={`${inputClass} !w-20 !py-0.5`} inputMode="decimal" value={s.budgetMinor != null ? (s.budgetMinor / 100).toFixed(2) : ''} onChange={(e) => update(s.index, { budgetMinor: Math.round(Number.parseFloat(e.target.value || '0') * 100) || null })} /> per day
                </label>
              ) : (
                'Campaign budget'
              )}
            </p>
            <div className="flex flex-wrap gap-1 items-center">
              {s.interestKind === 'broad' && !s.interests.length && <Badge tone="grey">Broad</Badge>}
              {s.interestKind === 'placeholder' && <Badge tone="amber">Placeholder</Badge>}
              {s.interestKind === 'unmatched' && <Badge tone="amber">No exact match</Badge>}
              {s.interests.map((i) => (
                <span key={i.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cobalt-soft text-cobalt">
                  {i.name}
                  <button type="button" onClick={() => update(s.index, { interests: s.interests.filter((x) => x.id !== i.id) })} title="Remove">
                    ×
                  </button>
                </span>
              ))}
              {s.suggestions.length > 0 && !s.interests.length && (
                <select className={`${inputClass} !py-0.5`} value="" onChange={(e) => { const pick = s.suggestions.find((x) => x.id === e.target.value); if (pick) update(s.index, { interests: [pick], interestKind: 'picked' }); }}>
                  <option value="">Pick a suggestion</option>
                  {s.suggestions.map((sg) => (
                    <option key={sg.id} value={sg.id}>
                      {sg.name}
                    </option>
                  ))}
                </select>
              )}
              {interestInput?.index === s.index ? (
                <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); const [id, ...rest] = interestInput.text.split(':'); const ref: InterestRef = { id: (id ?? '').trim(), name: rest.join(':').trim() || (id ?? '').trim() }; if (ref.id) update(s.index, { interests: [...s.interests, ref], interestKind: 'picked' }); setInterestInput(null); }}>
                  <input className={`${inputClass} !py-0.5`} autoFocus placeholder="id:name" value={interestInput.text} onChange={(e) => setInterestInput({ index: s.index, text: e.target.value })} />
                </form>
              ) : (
                <button type="button" className="text-cobalt" onClick={() => setInterestInput({ index: s.index, text: '' })}>
                  + interest
                </button>
              )}
            </div>
            <div className="space-y-2">
              {s.ads.map((a, j) => {
                const c = creatives.find((x) => x.id === a.creativeId);
                return (
                  <div key={j} className="border border-line rounded-md bg-panel p-2 space-y-1">
                    <div className="flex gap-2">
                      {c?.finishedUrl ? <img src={c.finishedUrl} alt="" className="w-14 h-14 object-cover rounded" /> : <div className="w-14 h-14 rounded bg-panel-2" />}
                      <div className="flex-1 min-w-0 space-y-1">
                        <select className={`${inputClass} !py-0.5`} value={a.creativeId} onChange={(e) => { const nc = creatives.find((x) => x.id === Number(e.target.value)); if (nc) setAd(s.index, j, { creativeId: nc.id, fileName: nc.fileName ?? a.fileName }); }}>
                          {creatives.map((cr) => (
                            <option key={cr.id} value={cr.id}>
                              {cr.fileName}
                            </option>
                          ))}
                        </select>
                        <select className={`${inputClass} !py-0.5`} value={copies.findIndex((cp) => cp.primaryText === a.primaryText && cp.headline === a.headline)} onChange={(e) => { const cp = copies[Number(e.target.value)]; if (cp) setAd(s.index, j, { primaryText: cp.primaryText, headline: cp.headline, description: cp.description }); }}>
                          {copies.map((cp, k) => (
                            <option key={k} value={k}>
                              {cp.label}
                            </option>
                          ))}
                          <option value={-1}>Custom</option>
                        </select>
                      </div>
                    </div>
                    <p className="text-ink-2 line-clamp-2" title={a.primaryText}>
                      <strong>{a.headline}</strong> {a.primaryText}
                    </p>
                    <button type="button" className="text-ink-3 hover:text-red" onClick={() => update(s.index, { ads: s.ads.filter((_, k) => k !== j) })}>
                      Remove ad
                    </button>
                  </div>
                );
              })}
              <Button kind="quiet" className="!px-2 !py-0.5" disabled={!creatives.length} onClick={() => addAd(s.index)}>
                + ad
              </Button>
            </div>
            <button type="button" className="text-ink-3 hover:text-red" onClick={() => onChange({ ...structure, adSets: structure.adSets.filter((x) => x.index !== s.index) })}>
              Remove ad set
            </button>
            {s.budgetMinor != null && <p className="text-ink-3">{formatMoney(s.budgetMinor)}/day</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
