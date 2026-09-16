import { STATIONS, trackForState, type ProductState, type Station, type StopStatus } from '@conveyor/shared';

const LABELS: Record<Station, string> = { import: 'Import', listing: 'Listing', creatives: 'Creatives', launch: 'Launch' };

/** The four-stop progress track. Cobalt for progress, amber for "waiting on you", green for live. */
export function Track({ state, compact = false }: { state: ProductState; compact?: boolean }) {
  const stops = trackForState(state);
  return (
    <div className={`track ${compact ? 'w-56' : 'w-full max-w-md'}`} role="img" aria-label={`Progress: ${state.replace(/_/g, ' ')}`}>
      {STATIONS.map((s) => (
        <Stop key={s} label={LABELS[s]} status={stops[s]} compact={compact} />
      ))}
    </div>
  );
}

function Stop({ label, status, compact }: { label: string; status: StopStatus; compact: boolean }) {
  return (
    <div className="track-stop" data-status={status}>
      <div className="track-dot" />
      {!compact && <div className="track-label">{label}</div>}
    </div>
  );
}
