import { useCallback, useEffect, useState } from 'react';
import type { ShopifyPhotoList } from '@conveyor/shared';
import { Badge, Button } from './Panel.tsx';
import { ApiError, line, studio } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';

/**
 * Pick photos from the product's own Shopify media and bring them in as creatives, so a launch
 * can use the store's photography instead of only generated images. Each becomes one 1:1 JPEG,
 * approved and ready to choose. Listing costs nothing; importing re-reads Shopify only when the
 * snapshot is 10 minutes old or more, then downloads one file per photo from the image CDN.
 */
export function ShopifyPhotoPicker({ productId, busy, onDone }: { productId: number; busy: boolean; onDone: () => void | Promise<void> }) {
  const [list, setList] = useState<ShopifyPhotoList | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(() => studio.shopifyPhotos(productId).then(setList).catch(() => setList(null)), [productId]);
  useEffect(() => {
    setChosen([]);
    void load();
  }, [load]);

  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const run = async (fn: () => Promise<unknown>, note: string) => {
    setWorking(true);
    setNotice(null);
    try {
      await fn();
      setNotice(note);
      await load();
      await onDone();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setWorking(false);
    }
  };

  const importChosen = () =>
    run(async () => {
      await studio.importShopifyPhotos(productId, chosen);
      setChosen([]);
    }, `Importing ${chosen.length} photo${chosen.length === 1 ? '' : 's'}. They arrive approved and join this product's chosen creatives, ready to launch.`);

  if (!list) return <p className="text-sm text-ink-3">Could not read this product's Shopify photos.</p>;

  const available = list.photos.filter((p) => !p.creativeId);
  const disabled = busy || working;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs text-ink-3">
        <span>
          {list.photos.length} photo{list.photos.length === 1 ? '' : 's'} on the Shopify product
          {list.fetchedAt ? ` · read ${formatDateTime(list.fetchedAt)}` : ''}
          {list.stale ? ' · importing re-reads it (1 query)' : ' · snapshot is fresh, 0 queries'}
        </span>
        <Button kind="quiet" className="!px-2 !py-0.5" disabled={disabled} onClick={() => run(() => line.refreshShopify(productId), 'Reading the product back from Shopify.')}>
          Read again
        </Button>
        {available.length > 0 && (
          <Button kind="quiet" className="!px-2 !py-0.5" disabled={disabled} onClick={() => setChosen(chosen.length === available.length ? [] : available.map((p) => p.id))}>
            {chosen.length === available.length ? 'Clear' : 'Choose all'}
          </Button>
        )}
      </div>

      {list.photos.length === 0 && (
        <p className="text-sm text-ink-3">
          This product has no photos in Shopify yet. Add some to the product, then use "Read again".
        </p>
      )}

      {list.photos.length > 0 && (
        <ul className="grid gap-3 grid-cols-3 sm:grid-cols-4 lg:grid-cols-6">
          {list.photos.map((p) => {
            const already = p.creativeId != null;
            const picked = chosen.includes(p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={disabled || already}
                  onClick={() => toggle(p.id)}
                  title={already ? `Already imported as ${p.fileName}` : p.square ? 'Square: the 1:1 frame keeps all of it' : `${p.width}×${p.height}: the 1:1 frame will crop it`}
                  className={`block w-full text-left rounded-md overflow-hidden border-2 transition ${already ? 'border-line opacity-50 cursor-default' : picked ? 'border-cobalt' : 'border-line opacity-70 hover:opacity-100'}`}
                >
                  <span className="relative block aspect-square bg-panel-2">
                    <img src={p.url} alt={p.altText ?? ''} className="w-full h-full object-cover" loading="lazy" />
                    {picked && <span className="absolute top-1 left-1 w-5 h-5 rounded-full bg-cobalt text-cobalt-ink text-xs font-medium flex items-center justify-center tabular-nums">{chosen.indexOf(p.id) + 1}</span>}
                    {already && (
                      <span className="absolute top-1 right-1">
                        <Badge tone="green">In</Badge>
                      </span>
                    )}
                    {!already && !p.square && (
                      <span className="absolute bottom-1 right-1">
                        <Badge tone="amber">Crops</Badge>
                      </span>
                    )}
                  </span>
                  <span className="block px-1.5 py-1 text-[11px] text-ink-3 truncate">
                    {already ? (p.fileName ?? 'imported') : p.width && p.height ? `${p.width}×${p.height}` : 'photo'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center gap-3 mt-3">
        <Button kind="primary" disabled={disabled || !chosen.length} onClick={importChosen}>
          {working ? 'Importing' : `Import ${chosen.length || ''} photo${chosen.length === 1 ? '' : 's'}`.replace('  ', ' ')}
        </Button>
        <span className="text-xs text-ink-3">
          Each becomes a 1:1 creative at 1080×1080, cleaned of metadata, approved and added to this product's launch. {chosen.length} download{chosen.length === 1 ? '' : 's'} from the Shopify image CDN, which costs no Admin quota.
        </span>
      </div>
      {notice && <p className="text-sm text-ink-2 mt-2">{notice}</p>}
    </div>
  );
}
