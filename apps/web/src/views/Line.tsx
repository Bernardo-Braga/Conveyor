import { useCallback, useEffect, useState } from 'react';
import type { AddToLineResult, ProductView } from '@conveyor/shared';
import { Badge, Button, Panel, inputClass } from '../components/Panel.tsx';
import { Track } from '../components/Track.tsx';
import { ApiError, line } from '../lib/api.ts';
import type { LiveState } from '../lib/events.ts';
import { formatDateTime, formatMoney, sentence } from '../lib/format.ts';

type Notice = { tone: 'cobalt' | 'amber' | 'green' | 'red' | 'grey'; text: string };

/** The Line: every product and where it is on the track. */
export function LineView({ live }: { live: LiveState }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [search, setSearch] = useState<Extract<AddToLineResult, { kind: 'search' }> | null>(null);
  const [items, setItems] = useState<ProductView[]>([]);
  const [highlight, setHighlight] = useState<number | null>(null);

  const refresh = useCallback(() => line.products().then(setItems).catch(() => undefined), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Any job change may have moved a product; the list is local and cheap to re-read.
  const jobKey = [...live.jobs.values()].map((j) => `${j.id}:${j.status}:${j.currentStep}`).join(',');
  useEffect(() => {
    void refresh();
  }, [jobKey, refresh]);

  const handle = (r: AddToLineResult) => {
    setSearch(null);
    if (r.kind === 'importing') {
      setNotice({ tone: 'cobalt', text: 'Added. One supplier request is on its way; the row updates live.' });
      setText('');
      setHighlight(r.productId);
    } else if (r.kind === 'duplicate') {
      setNotice({ tone: 'amber', text: 'Already on the line. No request was made.' });
      setHighlight(r.productId);
    } else if (r.kind === 'unsupported') {
      setNotice({ tone: 'red', text: r.message });
    } else {
      setSearch(r);
      setNotice(r.results.length ? { tone: 'grey', text: `One Shopify query. ${r.results.length} match${r.results.length === 1 ? '' : 'es'} for “${r.query}”. Adding one costs one more query.` } : { tone: 'amber', text: `No Shopify products match “${r.query}”. One query used.` });
    }
    void refresh();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      handle(await line.add(text));
    } catch (err) {
      setNotice({ tone: 'red', text: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Panel>
        <form className="flex gap-3" onSubmit={submit}>
          <input className={inputClass} placeholder="Paste an AliExpress or 1688 link, or type a product name" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <Button kind="primary" type="submit" disabled={busy || !text.trim()}>
            {busy ? 'Working' : 'Add to the line'}
          </Button>
        </form>
        {notice && <p className={`text-sm mt-3 ${notice.tone === 'red' ? 'text-red' : notice.tone === 'amber' ? 'text-amber' : notice.tone === 'cobalt' ? 'text-cobalt' : 'text-ink-2'}`}>{notice.text}</p>}
        {search && search.results.length > 0 && (
          <ul className="mt-4 divide-y divide-line border border-line rounded-panel overflow-hidden">
            {search.results.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-3 py-2 bg-panel-2">
                {h.image ? <img src={h.image} alt="" className="w-10 h-10 rounded object-cover bg-panel" /> : <div className="w-10 h-10 rounded bg-panel" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{h.title}</p>
                  <p className="text-xs text-ink-3">
                    {h.handle} · {sentence(h.status.toLowerCase())} · updated {formatDateTime(h.updatedAt)}
                  </p>
                </div>
                {h.onLine ? (
                  <Badge tone="grey">On the line</Badge>
                ) : (
                  <Button
                    onClick={async () => {
                      setBusy(true);
                      try {
                        handle(await line.fromShopify(h.id));
                      } finally {
                        setBusy(false);
                      }
                    }}
                    disabled={busy}
                  >
                    Add
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Products" action={<span className="text-xs text-ink-3">{items.length ? `${items.length} on the line` : ''}</span>}>
        {items.length === 0 && <p className="text-sm text-ink-3">No products yet. The first link you paste will appear here with its track.</p>}
        <ul className="divide-y divide-line -mx-5">
          {items.map((p) => (
            <ProductRow key={p.id} p={p} highlighted={highlight === p.id} onChange={refresh} />
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function stateTone(state: ProductView['state']) {
  if (state === 'live') return 'green';
  if (state === 'needs_attention') return 'red';
  if (state === 'editing_in_shopify' || state === 'from_shopify' || state === 'review' || state === 'ready_to_launch' || state === 'paused_in_meta') return 'amber';
  return 'cobalt';
}

function ProductRow({ p, highlighted, onChange }: { p: ProductView; highlighted: boolean; onChange: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`flex items-center gap-4 px-5 py-3 ${highlighted ? 'bg-cobalt-soft/40' : ''}`}>
      {p.thumbnail ? <img src={p.thumbnail} alt="" className="w-14 h-14 rounded-md object-cover bg-panel-2 shrink-0" loading="lazy" /> : <div className="w-14 h-14 rounded-md bg-panel-2 shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-medium truncate">{p.title ?? (p.itemId ? `${p.platform} ${p.itemId}` : p.shopifyProductId ?? 'Product')}</p>
          <Badge tone={stateTone(p.state)}>{sentence(p.state)}</Badge>
        </div>
        <p className="text-xs text-ink-3 mt-0.5 flex flex-wrap gap-x-3">
          {p.platform && <span>{p.platform === '1688' ? '1688' : 'AliExpress'}</span>}
          {p.origin === 'shopify' && <span>From Shopify</span>}
          {p.costMinor != null && p.currency && <span>Cost from {formatMoney(p.costMinor, p.currency)}</span>}
          {p.moq != null && <span>MOQ {p.moq}</span>}
          {p.variantCount > 0 && <span>{p.variantCount} variant{p.variantCount === 1 ? '' : 's'}</span>}
          {p.imageCount > 0 && <span>{p.imageCount} image{p.imageCount === 1 ? '' : 's'}</span>}
          {p.shopifyHandle && <span>{p.shopifyHandle}</span>}
        </p>
        {p.failure && (
          <p className="text-xs text-red mt-1">
            <strong>{p.failure.step}</strong>: {p.failure.message}
            {p.failure.suggestion && <span className="text-ink-2"> {p.failure.suggestion}</span>}
            {p.failure.requestId && <span className="text-ink-3"> · request {p.failure.requestId}</span>}
          </p>
        )}
      </div>
      <Track state={p.state} compact />
      <div className="flex items-center gap-1 shrink-0">
        {p.failure && (
          <Button disabled={busy} onClick={() => act(() => line.retry(p.id))}>
            Retry
          </Button>
        )}
        {p.platform && p.state !== 'importing' && (
          <Button kind="quiet" disabled={busy} title="One RapidAPI request" onClick={() => act(() => line.refreshSupplier(p.id))}>
            Refresh supplier data
          </Button>
        )}
        <Button kind="quiet" disabled={busy} onClick={() => act(() => line.remove(p.id))}>
          Remove
        </Button>
      </div>
    </li>
  );
}
