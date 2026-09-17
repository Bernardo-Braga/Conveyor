import { useCallback, useEffect, useState } from 'react';
import type { LedgerEntry } from '@conveyor/shared';
import { Badge, Panel, inputClass } from '../components/Panel.tsx';
import { ops, type LedgerOverview, type ProductTotals } from '../lib/api.ts';
import type { LiveState } from '../lib/events.ts';
import { formatDateTime, formatMoney, formatTime, sentence } from '../lib/format.ts';

const SERVICES = ['rapidapi', 'shopify', 'meta', 'openai', 'claude', 'cdn', 'other'] as const;

/** The Requests page (PLAN.md section 12): the ledger by day, service and product, plus the raw tail. */
export function RequestsView({ live }: { live: LiveState }) {
  const [days, setDays] = useState(14);
  const [overview, setOverview] = useState<LedgerOverview | null>(null);
  const [products, setProducts] = useState<ProductTotals[]>([]);
  const [recent, setRecent] = useState<LedgerEntry[]>([]);
  const [service, setService] = useState<string>('');

  const load = useCallback(async () => {
    const [o, p, r] = await Promise.all([ops.overview(days), ops.products(), ops.recent(100, service || undefined)]);
    setOverview(o);
    setProducts(p);
    setRecent(r);
  }, [days, service]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load, live.ledgerCount]);

  const dayList = [...new Set(overview?.byDay.map((d) => d.day) ?? [])].sort().reverse();
  const cell = (day: string, s: string) => overview?.byDay.find((d) => d.day === day && d.service === s);

  return (
    <div className="space-y-6">
      <Panel
        title="Requests by service"
        action={
          <select className={`${inputClass} !w-32 !py-1 text-xs`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 14, 30, 90].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        }
      >
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4 lg:grid-cols-7 mb-4">
          {SERVICES.map((s) => {
            const row = overview?.byService.find((x) => x.service === s);
            return (
              <div key={s} className="border border-line rounded-panel px-3 py-2 bg-panel-2">
                <p className="text-xs text-ink-3">{sentence(s)}</p>
                <p className="text-xl">{row?.total ?? 0}</p>
                <p className="text-xs text-ink-3">
                  {row?.today ?? 0} today{row?.failed ? ` · ${row.failed} failed` : ''}
                </p>
              </div>
            );
          })}
        </div>
        {overview?.lastQuota && (
          <p className="text-xs text-ink-3 mb-3">
            Last RapidAPI quota seen: {overview.lastQuota.quotaRemaining} remaining at {formatDateTime(overview.lastQuota.at)}.
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="text-xs w-full">
            <thead>
              <tr className="text-left text-ink-3">
                <th className="py-1 pr-3 font-medium">Day</th>
                {SERVICES.map((s) => (
                  <th key={s} className="py-1 pr-3 font-medium">
                    {sentence(s)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dayList.map((day) => (
                <tr key={day} className="border-t border-line">
                  <td className="py-1 pr-3">{day}</td>
                  {SERVICES.map((s) => {
                    const c = cell(day, s);
                    return (
                      <td key={s} className="py-1 pr-3">
                        {c ? (
                          <span>
                            {c.count}
                            {c.failed ? <span className="text-red"> ({c.failed} failed)</span> : null}
                            <span className="text-ink-3"> · {c.avgMs} ms</span>
                          </span>
                        ) : (
                          <span className="text-ink-3">·</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!dayList.length && (
                <tr>
                  <td colSpan={8} className="py-2 text-ink-3">
                    No requests in this window.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Per product">
        <div className="overflow-x-auto">
          <table className="text-xs w-full">
            <thead>
              <tr className="text-left text-ink-3">
                <th className="py-1 pr-3 font-medium">Product</th>
                <th className="py-1 pr-3 font-medium">State</th>
                <th className="py-1 pr-3 font-medium">Requests</th>
                <th className="py-1 pr-3 font-medium">By service</th>
                <th className="py-1 pr-3 font-medium">Plan runs</th>
                <th className="py-1 pr-3 font-medium">API cost</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-t border-line">
                  <td className="py-1 pr-3 max-w-xs truncate">{p.title ?? p.handle ?? `#${p.id}`}</td>
                  <td className="py-1 pr-3">
                    <Badge tone="grey">{sentence(p.state)}</Badge>
                  </td>
                  <td className="py-1 pr-3">{p.totalRequests}</td>
                  <td className="py-1 pr-3 text-ink-2">
                    {Object.entries(p.requests)
                      .map(([s, n]) => `${s} ${n}`)
                      .join(' · ') || '·'}
                  </td>
                  <td className="py-1 pr-3 text-ink-2">
                    {Object.entries(p.runs)
                      .map(([s, n]) => `${s} ${n}`)
                      .join(' · ') || '·'}
                  </td>
                  <td className="py-1 pr-3">{p.costMinor ? formatMoney(p.costMinor) : '·'}</td>
                </tr>
              ))}
              {!products.length && (
                <tr>
                  <td colSpan={6} className="py-2 text-ink-3">
                    No products yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-3 mt-2">Plan runs are Claude Code and Codex work on your subscriptions; they are counted, not billed. API cost is what the OpenAI engine reported, and what an API listing writer would bill.</p>
      </Panel>

      <Panel
        title="Recent requests"
        action={
          <select className={`${inputClass} !w-32 !py-1 text-xs`} value={service} onChange={(e) => setService(e.target.value)}>
            <option value="">All services</option>
            {SERVICES.map((s) => (
              <option key={s} value={s}>
                {sentence(s)}
              </option>
            ))}
          </select>
        }
      >
        <div className="overflow-x-auto">
          <table className="text-xs w-full font-mono">
            <thead>
              <tr className="text-left text-ink-3 font-sans">
                <th className="py-1 pr-3 font-medium">Time</th>
                <th className="py-1 pr-3 font-medium">Service</th>
                <th className="py-1 pr-3 font-medium">Purpose</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 font-medium">ms</th>
                <th className="py-1 pr-3 font-medium">Product</th>
                <th className="py-1 pr-3 font-medium">Job</th>
                <th className="py-1 pr-3 font-medium">Request ID</th>
                <th className="py-1 pr-3 font-medium">URL</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-1 pr-3 whitespace-nowrap">{formatTime(r.at)}</td>
                  <td className="py-1 pr-3">{r.service}</td>
                  <td className="py-1 pr-3">{r.purpose}</td>
                  <td className={`py-1 pr-3 ${r.ok ? '' : 'text-red'}`}>{r.status ?? r.error ?? '–'}</td>
                  <td className="py-1 pr-3">{r.durationMs}</td>
                  <td className="py-1 pr-3">{r.productId ?? '·'}</td>
                  <td className="py-1 pr-3">{r.jobId ?? '·'}</td>
                  <td className="py-1 pr-3 max-w-[10rem] truncate" title={r.requestId ?? ''}>
                    {r.requestId ?? '·'}
                  </td>
                  <td className="py-1 pr-3 max-w-[20rem] truncate" title={r.url}>
                    {r.url}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-3 mt-2">The ledger never stores headers, bodies or query strings.</p>
      </Panel>
    </div>
  );
}
