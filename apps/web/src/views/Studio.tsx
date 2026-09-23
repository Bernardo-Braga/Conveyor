import { useCallback, useEffect, useMemo, useState } from 'react';
import { ASPECT_LABEL, ASPECTS, ORIGIN_LABEL, type Aspect, type BatchView, type CreativeView, type ProductView, type PromptTemplateView } from '@conveyor/shared';
import { Badge, Button, Panel, inputClass } from '../components/Panel.tsx';
import { ShopifyPhotoPicker } from '../components/ShopifyPhotoPicker.tsx';
import { ApiError, line, studio } from '../lib/api.ts';
import type { LiveState } from '../lib/events.ts';
import { formatDateTime, sentence } from '../lib/format.ts';

const STUDIO_STATES = new Set<ProductView['state']>(['editing_in_shopify', 'from_shopify', 'generating', 'review', 'ready_to_launch', 'paused_in_meta', 'live', 'needs_attention']);

/**
 * Station 3. Pick a product that is in Shopify, generate a batch (at most one Shopify query),
 * then review: A approves, X rejects, R regenerates, E edits with an instruction.
 */
export function StudioView({ live }: { live: LiveState }) {
  const [products, setProducts] = useState<ProductView[]>([]);
  const [productId, setProductId] = useState<number | null>(null);
  const [batches, setBatches] = useState<BatchView[]>([]);
  const [templates, setTemplates] = useState<PromptTemplateView[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [formats, setFormats] = useState<Aspect[]>([...ASPECTS]);
  const [count, setCount] = useState('4');
  const [selected, setSelected] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fromShopify, setFromShopify] = useState(false);

  useEffect(() => {
    line.products().then((all) => {
      const eligible = all.filter((p) => p.shopifyProductId && STUDIO_STATES.has(p.state));
      setProducts(eligible);
      setProductId((cur) => cur ?? eligible[0]?.id ?? null);
    }).catch(() => undefined);
    studio.templates().then((t) => {
      setTemplates(t);
      const d = t.find((x) => x.isDefault) ?? t[0];
      if (d) {
        setTemplateId(d.id);
        setFormats(d.formats);
        setCount(String(d.countPerFormat));
      }
    }).catch(() => undefined);
  }, []);

  const refresh = useCallback(() => {
    if (productId == null) return Promise.resolve();
    return studio.batches(productId).then(setBatches).catch(() => undefined);
  }, [productId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const jobKey = [...live.jobs.values()].filter((j) => j.type === 'generate_batch' || j.type === 'shopify_media' || j.type === 'import_shopify_photos').map((j) => `${j.id}:${j.status}:${JSON.stringify(j.progress)}`).join(',');
  useEffect(() => {
    void refresh();
  }, [jobKey, refresh]);

  const product = products.find((p) => p.id === productId) ?? null;
  const running = [...live.jobs.values()].find((j) => j.type === 'generate_batch' && j.productId === productId && (j.status === 'running' || j.status === 'queued'));
  const progress = running?.progress as { done?: number; total?: number } | null | undefined;
  const all = useMemo(() => batches.flatMap((b) => b.creatives), [batches]);
  const finished = all.filter((c) => c.status === 'finished');
  const approvedCount = finished.filter((c) => c.approval === 'approved').length;
  const toShopifyCount = finished.filter((c) => c.approval === 'approved' && !c.shopifyMediaId).length;
  const sendingToShopify = [...live.jobs.values()].some((j) => j.type === 'shopify_media' && j.productId === productId && (j.status === 'running' || j.status === 'queued'));

  const act = async (fn: () => Promise<unknown>, note?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      if (note) setNotice(note);
      await refresh();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  // Keyboard: arrows move, A approve, X reject, R regenerate, E edit. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || (e.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      const list = finished;
      const idx = list.findIndex((c) => c.id === selected);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setSelected(list[Math.min(list.length - 1, idx + 1)]?.id ?? null);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setSelected(list[Math.max(0, idx - 1)]?.id ?? null);
      else if (selected != null) {
        const cur = list.find((c) => c.id === selected);
        if (!cur) return;
        if (e.key === 'a' || e.key === 'A') void act(() => studio.act(cur.id, cur.approval === 'approved' ? 'unapprove' : 'approve'));
        else if (e.key === 'x' || e.key === 'X') void act(() => studio.act(cur.id, cur.approval === 'rejected' ? 'unapprove' : 'reject'));
        else if (e.key === 'r' || e.key === 'R') void act(() => studio.regenerate(cur.id), 'Regenerating one image. No API request.');
        else if (e.key === 'e' || e.key === 'E') setEditing({ id: cur.id, text: '' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const snapshotFresh = product?.snapshotAt ? Date.now() - new Date(product.snapshotAt).getTime() < 10 * 60 * 1000 : false;

  return (
    <div className="space-y-6">
      <Panel
        title="Generate creatives"
        action={
          product && (
            <span className="text-xs text-ink-3">
              {snapshotFresh ? 'Snapshot is fresh: 0 API requests' : '1 Shopify query for the snapshot'} · Codex runs on your ChatGPT plan
            </span>
          )
        }
      >
        {products.length === 0 && <p className="text-sm text-ink-3">No product is in Shopify yet. Import a link or add one from Shopify, then write its listing.</p>}
        {products.length > 0 && (
          <div className="grid gap-3 md:grid-cols-[2fr_2fr_1fr_1fr_auto] items-end">
            <label className="block">
              <span className="block text-xs font-medium text-ink-2 mb-1">Product</span>
              <select className={inputClass} value={productId ?? ''} onChange={(e) => setProductId(Number(e.target.value))}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title ?? p.shopifyHandle} · {sentence(p.state)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-ink-2 mb-1">Prompt</span>
              <select
                className={inputClass}
                value={templateId ?? ''}
                onChange={(e) => {
                  const t = templates.find((x) => x.id === Number(e.target.value));
                  setTemplateId(t?.id ?? null);
                  if (t) {
                    setFormats(t.formats);
                    setCount(String(t.countPerFormat));
                  }
                }}
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} v{t.version}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className="block text-xs font-medium text-ink-2 mb-1">Formats</span>
              <div className="flex gap-2">
                {ASPECTS.map((a) => (
                  <label key={a} className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={formats.includes(a)} onChange={(e) => setFormats((f) => (e.target.checked ? [...ASPECTS].filter((x) => x === a || f.includes(x)) : f.filter((x) => x !== a)))} />
                    {a}
                  </label>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="block text-xs font-medium text-ink-2 mb-1">Per format</span>
              <input className={inputClass} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
            </label>
            <Button kind="primary" disabled={busy || !!running || !productId || !formats.length || !/^\d+$/.test(count)} onClick={() => act(() => studio.generate(productId!, { promptTemplateId: templateId, formats, countPerFormat: Number(count) }), 'Batch started. Images appear as they finish.')}>
              {running ? `Generating ${progress?.done ?? 0}/${progress?.total ?? formats.length * Number(count || 0)}` : `Generate ${formats.length * Number(count || 0)} images`}
            </Button>
          </div>
        )}
        {notice && <p className="text-sm text-ink-2 mt-3">{notice}</p>}
        {product?.failure && (
          <p className="text-xs text-red mt-3">
            <strong>{product.failure.step}</strong>: {product.failure.message} {product.failure.suggestion}
          </p>
        )}
      </Panel>

      {product && (
        <Panel
          title="Use a photo from Shopify"
          action={
            <Button kind="quiet" onClick={() => setFromShopify((v) => !v)}>
              {fromShopify ? 'Hide' : 'Choose photos'}
            </Button>
          }
        >
          {!fromShopify && <p className="text-sm text-ink-3">Bring the product's own Shopify photos in as creatives, to launch alongside or instead of the generated ones.</p>}
          {fromShopify && <ShopifyPhotoPicker productId={product.id} busy={busy} onDone={refresh} />}
        </Panel>
      )}

      {product && (
        <Panel
          title="Review"
          action={
            <span className="text-xs text-ink-3 flex items-center gap-3">
              <span>
                {finished.length} finished · {approvedCount} approved · keys: A approve, X reject, R regenerate, E edit, arrows move
              </span>
              {approvedCount > 0 && (
                <Button kind="quiet" disabled={busy || sendingToShopify || toShopifyCount === 0} title="2 Shopify requests plus one upload per image" onClick={() => act(() => studio.toShopify(product.id), `Adding ${toShopifyCount} image${toShopifyCount === 1 ? '' : 's'} to the Shopify product.`)}>
                  {sendingToShopify ? 'Adding to Shopify' : toShopifyCount === 0 ? 'Approved images are in Shopify' : `Add ${toShopifyCount} approved to Shopify`}
                </Button>
              )}
            </span>
          }
        >
          {batches.length === 0 && <p className="text-sm text-ink-3">No batches yet.</p>}
          <div className="space-y-6">
            {batches.map((b) => (
              <section key={b.id}>
                <header className="flex items-center gap-2 mb-2 text-xs text-ink-3">
                  <span className="font-medium text-ink-2">Batch #{b.id}</span>
                  <Badge tone={b.status === 'done' ? 'green' : b.status === 'running' ? 'cobalt' : b.status === 'partial' || b.status === 'handoff' ? 'amber' : b.status === 'failed' ? 'red' : 'grey'}>{sentence(b.status)}</Badge>
                  <span>
                    {b.finished}/{b.total} · {ORIGIN_LABEL[b.engine]} · {b.apiRequests} API request{b.apiRequests === 1 ? '' : 's'} · {formatDateTime(b.createdAt)}
                  </span>
                  {b.replacesCreativeId && <span>· replaces #{b.replacesCreativeId}</span>}
                  {b.note && <span className="text-amber">· {b.note}</span>}
                </header>
                {b.formats.map((aspect) => {
                  const items = b.creatives.filter((c) => c.aspect === aspect);
                  if (!items.length) return null;
                  return (
                    <div key={aspect} className="mb-3">
                      <p className="text-xs text-ink-3 mb-1">{ASPECT_LABEL[aspect]}</p>
                      <div className="grid gap-3 grid-cols-2 md:grid-cols-4 lg:grid-cols-6">
                        {items.map((c) => (
                          <Tile key={c.id} c={c} selected={selected === c.id} onSelect={() => setSelected(c.id)} onEdit={() => setEditing({ id: c.id, text: '' })} act={act} busy={busy} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        </Panel>
      )}

      {editing && (
        <Panel title={`Edit image #${editing.id}`} action={<Button kind="quiet" onClick={() => setEditing(null)}>Cancel</Button>}>
          <p className="text-sm text-ink-2 mb-2">Describe the one change to make. The image is sent back to the engine as the edit target, with the original prompt. No API request.</p>
          <div className="flex gap-2">
            <input className={inputClass} autoFocus value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} placeholder="e.g. plain white background, remove the second cup" />
            <Button
              kind="primary"
              disabled={!editing.text.trim() || busy}
              onClick={() => {
                const { id, text } = editing;
                setEditing(null);
                void act(() => studio.regenerate(id, text.trim()), 'Edit queued as a one-image batch.');
              }}
            >
              Send back
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Tile({ c, selected, onSelect, onEdit, act, busy }: { c: CreativeView; selected: boolean; onSelect: () => void; onEdit: () => void; act: (fn: () => Promise<unknown>, note?: string) => Promise<void>; busy: boolean }) {
  const ratio = c.aspect === '1:1' ? 'aspect-square' : c.aspect === '4:5' ? 'aspect-[4/5]' : 'aspect-[9/16]';
  const ring = selected ? 'ring-2 ring-cobalt' : c.approval === 'approved' ? 'ring-2 ring-green' : c.approval === 'rejected' ? 'ring-2 ring-red opacity-60' : 'ring-1 ring-line';
  return (
    <figure className={`rounded-md overflow-hidden bg-panel-2 ${ring} cursor-pointer`} onClick={onSelect} tabIndex={0} onFocus={onSelect}>
      <div className={`${ratio} w-full bg-panel-2 flex items-center justify-center`}>
        {c.status === 'finished' && c.finishedUrl ? (
          <img src={c.finishedUrl} alt={c.fileName ?? ''} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <span className={`text-xs ${c.status === 'failed' ? 'text-red' : 'text-ink-3'}`}>{c.status === 'failed' ? 'Not made' : c.status === 'generating' ? 'Generating' : 'Waiting'}</span>
        )}
      </div>
      <figcaption className="px-2 py-1.5 text-[11px] text-ink-3 flex items-center gap-1">
        <span className="truncate flex-1" title={c.fileName ?? ''}>
          {c.fileName ?? `${c.aspect} #${c.slot}`}
        </span>
        {c.approval === 'approved' && <Badge tone="green">A</Badge>}
        {c.approval === 'rejected' && <Badge tone="red">X</Badge>}
        {c.shopifyMediaId && (
          <span title="On the Shopify product">
            <Badge tone="grey">S</Badge>
          </span>
        )}
        {c.flags.length > 0 && <Badge tone="amber">{c.flags.join(',')}</Badge>}
      </figcaption>
      {c.status === 'finished' && (
        <div className="px-2 pb-2 flex gap-1">
          <Button kind="quiet" className="!px-2 !py-0.5 text-xs" disabled={busy} onClick={(e) => (e.stopPropagation(), void act(() => studio.act(c.id, c.approval === 'approved' ? 'unapprove' : 'approve')))}>
            {c.approval === 'approved' ? 'Unapprove' : 'Approve'}
          </Button>
          <Button kind="quiet" className="!px-2 !py-0.5 text-xs" disabled={busy} onClick={(e) => (e.stopPropagation(), void act(() => studio.act(c.id, c.approval === 'rejected' ? 'unapprove' : 'reject')))}>
            {c.approval === 'rejected' ? 'Unreject' : 'Reject'}
          </Button>
          <Button kind="quiet" className="!px-2 !py-0.5 text-xs" disabled={busy} onClick={(e) => (e.stopPropagation(), void act(() => studio.regenerate(c.id), 'Regenerating one image.'))}>
            R
          </Button>
          <Button kind="quiet" className="!px-2 !py-0.5 text-xs" disabled={busy} onClick={(e) => (e.stopPropagation(), onEdit())}>
            E
          </Button>
        </div>
      )}
    </figure>
  );
}
