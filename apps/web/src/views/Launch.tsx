import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CampaignView, LaunchPreview, ProductView, TemplateView } from '@conveyor/shared';
import { Badge, Button, Panel, inputClass } from '../components/Panel.tsx';
import { ApiError, launch, line } from '../lib/api.ts';
import type { LiveState } from '../lib/events.ts';
import { formatDateTime, formatMoney, sentence } from '../lib/format.ts';

const LAUNCH_STATES = new Set<ProductView['state']>(['ready_to_launch', 'review', 'paused_in_meta', 'live', 'needs_attention']);

/**
 * Station 4. New campaign: a template plus the structure it produces, the checks, the operation
 * and request count, then one button that creates everything PAUSED. Activation is a second,
 * separate button. The board editor and live editing arrive in phase 7.
 */
export function LaunchView({ live }: { live: LiveState }) {
  const [products, setProducts] = useState<ProductView[]>([]);
  const [productId, setProductId] = useState<number | null>(null);
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [preview, setPreview] = useState<LaunchPreview | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<{ creativeId: string; html: string | null }[] | null>(null);

  const loadTemplates = useCallback(
    () =>
      launch.templates().then(({ templates: t }) => {
        setTemplates(t);
        setTemplateId((cur) => cur ?? t.find((x) => x.isDefault)?.id ?? t[0]?.id ?? null);
      }).catch(() => undefined),
    [],
  );
  useEffect(() => {
    line.products().then((all) => {
      const eligible = all.filter((p) => p.shopifyProductId && LAUNCH_STATES.has(p.state));
      setProducts(eligible);
      setProductId((cur) => cur ?? eligible[0]?.id ?? null);
    }).catch(() => undefined);
    void loadTemplates();
  }, [loadTemplates]);

  const refresh = useCallback(async () => {
    if (productId == null) return;
    await launch.campaigns(productId).then(setCampaigns).catch(() => undefined);
    if (templateId != null) await launch.preview(productId, templateId, acknowledged).then(setPreview).catch((e) => setNotice(e instanceof ApiError ? e.message : 'Could not build the preview.'));
  }, [productId, templateId, acknowledged]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const jobKey = [...live.jobs.values()].filter((j) => ['launch', 'activate_campaign', 'find_interests', 'pull_insights'].includes(j.type)).map((j) => `${j.id}:${j.status}`).join(',');
  useEffect(() => {
    void refresh();
  }, [jobKey, refresh]);

  const running = [...live.jobs.values()].find((j) => (j.type === 'launch' || j.type === 'activate_campaign') && j.productId === productId && (j.status === 'running' || j.status === 'queued'));
  const product = products.find((p) => p.id === productId) ?? null;
  const blockers = useMemo(() => preview?.checks.filter((c) => c.level === 'block') ?? [], [preview]);
  const warnings = useMemo(() => preview?.checks.filter((c) => c.level === 'warn') ?? [], [preview]);
  const infos = useMemo(() => preview?.checks.filter((c) => c.level === 'info') ?? [], [preview]);

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

  const unmatched = preview?.structure.adSets.filter((s) => s.interestKind === 'unmatched' && s.suggestions.length) ?? [];

  return (
    <div className="space-y-6">
      <Panel
        title="New campaign"
        action={
          <a className="text-xs text-cobalt" href="#Templates">
            Manage templates
          </a>
        }
      >
        {products.length === 0 && <p className="text-sm text-ink-3">No product is ready to launch. Approve at least one creative in the Studio first.</p>}
        {products.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
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
              <span className="block text-xs font-medium text-ink-2 mb-1">Template</span>
              <div className="flex gap-2">
                <select className={inputClass} value={templateId ?? ''} onChange={(e) => setTemplateId(Number(e.target.value))}>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} v{t.version} · {t.mode} · {t.adSetCount} × {t.adsPerAdSet}
                      {t.isDefault ? ' · default' : ''}
                    </option>
                  ))}
                </select>
                {templateId != null && (
                  <>
                    <a className="px-2 py-1.5 text-xs rounded-md border border-line whitespace-nowrap" href={launch.exportUrl(templateId)} download>
                      Export for my other tool
                    </a>
                    <a className="px-2 py-1.5 text-xs rounded-md border border-line whitespace-nowrap" href={launch.exportUrl(templateId, true)} download>
                      Backup
                    </a>
                  </>
                )}
              </div>
            </label>
          </div>
        )}
        {templates.length === 0 && <p className="text-sm text-amber mt-3">No template yet. Drop your other tool's JSON into the templates folder, or add one on the Templates tab (0 requests).</p>}
        {notice && <p className="text-sm text-ink-2 mt-3">{notice}</p>}
      </Panel>

      {preview && product && (
        <>
          <Panel
            title="Checks"
            action={
              <span className="text-xs text-ink-3">
                {preview.operations} operations · {preview.imageUploads} image upload{preview.imageUploads === 1 ? '' : 's'} · {preview.requests} request{preview.requests === 1 ? '' : 's'}
              </span>
            }
          >
            <ul className="space-y-1.5 text-sm">
              {blockers.map((c) => (
                <li key={c.id} className="text-red">
                  ✕ {c.message}
                </li>
              ))}
              {warnings.map((c) => (
                <li key={c.id} className="text-amber flex items-start gap-2">
                  <span>! {c.message}</span>
                  {c.acknowledgeable && (
                    <label className="flex items-center gap-1 text-xs text-ink-2 whitespace-nowrap">
                      <input type="checkbox" checked={acknowledged.includes(c.id)} onChange={(e) => setAcknowledged((a) => (e.target.checked ? [...a, c.id] : a.filter((x) => x !== c.id)))} /> Fine, launch anyway
                    </label>
                  )}
                </li>
              ))}
              {infos.map((c) => (
                <li key={c.id} className="text-ink-2">
                  · {c.message}
                </li>
              ))}
              {preview.notes.map((n, i) => (
                <li key={i} className="text-ink-3">
                  · {n}
                </li>
              ))}
            </ul>
            {unmatched.length > 0 && (
              <div className="mt-4 space-y-2">
                {unmatched.map((s) => (
                  <div key={s.index} className="text-sm">
                    <span className="font-medium">{s.name}</span>: no exact match for “{s.interestLabel}”. Pick one:
                    <span className="ml-2 inline-flex flex-wrap gap-1">
                      {s.suggestions.map((sg) => (
                        <Button key={sg.id} kind="quiet" className="!px-2 !py-0.5 text-xs" disabled={busy} onClick={() => act(() => launch.pickInterest(s.interestLabel!, sg), `Cached “${s.interestLabel}” as ${sg.name}. 0 requests.`)}>
                          {sg.name}
                        </Button>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-4 flex items-center gap-3">
              <Button kind="primary" disabled={busy || !!running || !preview.canLaunch} onClick={() => act(() => launch.start(product.id, preview.templateId, acknowledged), 'Launching. Everything is created paused.')}>
                {running ? sentence(running.currentStep ?? running.status) : `Create ${preview.mode} campaign, paused`}
              </Button>
              <span className="text-xs text-ink-3">{preview.structure.adSets.length} ad sets · {preview.structure.adSets.reduce((n, s) => n + s.ads.length, 0)} ads · nothing is activated by this button</span>
            </div>
          </Panel>

          <Panel title={`Structure · ${preview.structure.campaignName}`} action={<span className="text-xs text-ink-3">Board editing arrives in phase 7</span>}>
            <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
              {preview.structure.adSets.map((s) => (
                <div key={s.index} className="border border-line rounded-panel p-3 bg-panel-2 text-xs">
                  <p className="font-medium text-sm truncate" title={s.name}>
                    {s.name}
                  </p>
                  <p className="text-ink-3 mt-0.5">
                    {s.budgetMinor != null ? `${formatMoney(s.budgetMinor)} per day` : 'Campaign budget'}
                    {s.countryOverride && ` · ${s.countryOverride}`}
                    {s.ageBand && ` · ${s.ageBand[0]}–${s.ageBand[1]}`}
                  </p>
                  <p className="mt-1">
                    {s.interestKind === 'broad' && <Badge tone="grey">Broad</Badge>}
                    {s.interestKind === 'placeholder' && <Badge tone="amber">Placeholder</Badge>}
                    {s.interestKind === 'unmatched' && <Badge tone="amber">Needs a pick</Badge>}
                    {s.interests.map((i) => (
                      <Badge key={i.id} tone="cobalt">
                        {i.name}
                      </Badge>
                    ))}
                  </p>
                  <ul className="mt-2 space-y-0.5 text-ink-2">
                    {s.ads.map((a, i) => (
                      <li key={i} className="truncate" title={a.fileName}>
                        {a.fileName}
                      </li>
                    ))}
                    {!s.ads.length && <li className="text-red">No ads</li>}
                  </ul>
                </div>
              ))}
            </div>
          </Panel>
        </>
      )}

      {campaigns.length > 0 && (
        <Panel title="Campaigns" action={<Button kind="quiet" disabled={busy} onClick={() => act(() => launch.refreshInsights(), 'Insights refresh queued: one query.')}>Refresh insights</Button>}>
          <div className="space-y-4">
            {campaigns.map((c) => (
              <section key={c.id} className="border border-line rounded-panel p-4">
                <header className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sm">{c.name}</span>
                  <Badge tone={c.status === 'active' ? 'green' : c.status === 'paused' ? 'amber' : c.status === 'failed' ? 'red' : 'cobalt'}>{sentence(c.status)}</Badge>
                  <span className="text-xs text-ink-3">
                    {c.mode} · {c.completed}/{c.operations} objects · {c.metaCampaignId ?? 'no Meta ID yet'} · {formatDateTime(c.createdAt)}
                  </span>
                  <span className="ml-auto flex gap-1">
                    {c.status === 'failed' && (
                      <Button disabled={busy || !!running} onClick={() => act(() => launch.resume(c.id), 'Resuming: only the missing objects are sent.')}>
                        Resume
                      </Button>
                    )}
                    {c.metaCampaignId && (
                      <Button kind="quiet" disabled={busy} onClick={() => act(async () => setPreviews(await launch.previews(c.id, 'MOBILE_FEED_STANDARD')))}>
                        Preview placements
                      </Button>
                    )}
                    {c.status === 'paused' && c.metaCampaignId && (
                      <Button kind="primary" disabled={busy || !!running} onClick={() => act(() => launch.activate(c.id), 'Activating: one request.')}>
                        Activate
                      </Button>
                    )}
                    {c.status === 'active' && (
                      <Button disabled={busy || !!running} onClick={() => act(() => launch.pause(c.id), 'Pausing: one request.')}>
                        Pause
                      </Button>
                    )}
                  </span>
                </header>
                {c.lastError && <p className="text-xs text-red mt-2">{c.lastError}</p>}
                <div className="mt-3 grid gap-2 md:grid-cols-3 lg:grid-cols-5 text-xs">
                  {c.adSets.map((s) => (
                    <div key={s.id} className="bg-panel-2 rounded-md p-2">
                      <p className="font-medium truncate" title={s.name}>
                        {s.name}
                      </p>
                      <p className="text-ink-3">
                        {s.budgetMinor != null ? `${formatMoney(s.budgetMinor)}/day` : 'campaign budget'} · {s.ads.length} ads · {s.metaId ? 'in Meta' : 'not created'}
                      </p>
                      {s.ads.some((a) => a.insights) && (
                        <ul className="mt-1 text-ink-2">
                          {s.ads.filter((a) => a.insights).map((a) => {
                            const i = a.insights as { spendMinor?: number; purchases?: number; purchaseRoas?: number | null; ctr?: number | null };
                            return (
                              <li key={a.id} className="truncate">
                                {a.name}: {formatMoney(i.spendMinor ?? 0)} · {i.purchases ?? 0} purch. · ROAS {i.purchaseRoas ?? '–'} · CTR {i.ctr?.toFixed(2) ?? '–'}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </Panel>
      )}

      {previews && (
        <Panel title="Placement previews" action={<Button kind="quiet" onClick={() => setPreviews(null)}>Close</Button>}>
          <div className="grid gap-3 md:grid-cols-3">
            {previews.map((p) => (
              <div key={p.creativeId} className="border border-line rounded-md overflow-hidden bg-panel-2 min-h-40" dangerouslySetInnerHTML={{ __html: p.html ?? '<p class="p-3 text-xs">No preview</p>' }} />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
