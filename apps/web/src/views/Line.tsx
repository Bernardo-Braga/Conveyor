import { useState } from 'react';
import { PRODUCT_STATES, type ProductState } from '@conveyor/shared';
import { Button, Panel, inputClass } from '../components/Panel.tsx';
import { Track } from '../components/Track.tsx';
import { sentence } from '../lib/format.ts';

/** The Line: every product and where it is on the track. Import arrives in phase 2. */
export function LineView() {
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState<ProductState>('editing_in_shopify');

  return (
    <div className="space-y-6">
      <Panel>
        <form
          className="flex gap-3"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <input className={inputClass} placeholder="Paste an AliExpress or 1688 link, or type a product name" value={link} onChange={(e) => setLink(e.target.value)} disabled />
          <Button kind="primary" type="submit" disabled>
            Add to the line
          </Button>
        </form>
        <p className="text-xs text-ink-3 mt-2">Import arrives in phase 2. Nothing is sent from this bar yet.</p>
      </Panel>

      <Panel title="Progress track" action={<span className="text-xs text-ink-3">Design check</span>}>
        <div className="flex flex-col gap-5">
          <Track state={preview} />
          <div className="flex flex-wrap gap-1.5">
            {PRODUCT_STATES.map((s) => (
              <button
                key={s}
                onClick={() => setPreview(s)}
                className={`px-2 py-1 text-xs rounded-md border ${preview === s ? 'border-cobalt text-cobalt bg-cobalt-soft' : 'border-line text-ink-2 hover:bg-panel-2'}`}
              >
                {sentence(s)}
              </button>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="Products">
        <p className="text-sm text-ink-3">No products yet. The first link you paste will appear here with its track.</p>
      </Panel>
    </div>
  );
}
