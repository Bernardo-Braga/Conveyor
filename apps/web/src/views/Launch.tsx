import { useCallback, useEffect, useMemo, useState } from 'react';
import { NO_OVERRIDES, overriddenFields, type CampaignView, type CreativeView, type LaunchAdSet, type LaunchOverrides, type LaunchPlanView, type LaunchPreview, type LaunchStructure, type LiveCampaign, type LiveChange, type LiveDiff, type ProductView, type TemplateView } from '@conveyor/shared';
import { Board } from '../components/Board.tsx';
import { ClearLaunchSettings, LaunchSettings, LaunchSettingsSummary } from '../components/LaunchSettings.tsx';
import { Badge, Button, Panel, inputClass } from '../components/Panel.tsx';
import { ShopifyPhotoPicker } from '../components/ShopifyPhotoPicker.tsx';
import { TemplateEditor, type Json } from '../components/TemplateEditor.tsx';
import { ApiError, launch, line, studio } from '../lib/api.ts';
import type { LiveState } from '../lib/events.ts';
import { formatDateTime, formatMoney, sentence } from '../lib/format.ts';

/** What the current fill rule does with the chosen images, in the same words the template uses. */
const FILL_RULE_COPY: Record<string, string> = {
  one_per_ad: 'Every ad set gets the same images, one per ad.',
  rotate: 'The images are spread across every ad slot in turn.',
  one_per_adset: 'Each ad set gets one image.',
  by_format: '9:16 images go to Reels and Stories ad sets, the rest elsewhere.',
  manual: 'The ad slots are left for you to fill on the board.',
};

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
  const [board, setBoard] = useState<LaunchStructure | null>(null);
  const [creatives, setCreatives] = useState<CreativeView[]>([]);
  const [saveName, setSaveName] = useState('');
  const [targetingChecks, setTargetingChecks] = useState<{ adSet: string; ok: boolean; message: string | null; estimate: { users_lower?: number; users_upper?: number } | null }[] | null>(null);
  const [plan, setPlan] = useState<LaunchPlanView | null>(null);
  const [planDoc, setPlanDoc] = useState<Json | null>(null);
  const [planDirty, setPlanDirty] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [fromShopify, setFromShopify] = useState(false);

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
    if (templateId != null) {
      await launch.plan(productId, templateId).then((p) => {
        setPlan(p);
        // A refresh never throws away edits that have not been saved yet.
        setPlanDoc((cur) => (planDirty && cur ? cur : (p.template as Json)));
      }).catch(() => undefined);
      const req = board ? launch.previewStructure(productId, templateId, acknowledged, board) : launch.preview(productId, templateId, acknowledged);
      await req.then(setPreview).catch((e) => setNotice(e instanceof ApiError ? e.message : 'Could not build the preview.'));
    }
    await studio.batches(productId).then((bs) => setCreatives(bs.flatMap((b) => b.creatives).filter((c) => c.status === 'finished' && c.approval === 'approved'))).catch(() => undefined);
  }, [productId, templateId, acknowledged, board, planDirty]);
  useEffect(() => {
    setBoard(null);
    setPlanDirty(false);
    setPlanDoc(null);
  }, [productId, templateId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const jobKey = [...live.jobs.values()].filter((j) => ['launch', 'activate_campaign', 'find_interests', 'pull_insights', 'pull_product', 'import_shopify_photos'].includes(j.type)).map((j) => `${j.id}:${j.status}`).join(',');
  useEffect(() => {
    void refresh();
  }, [jobKey, refresh]);

  const running = [...live.jobs.values()].find((j) => (j.type === 'launch' || j.type === 'activate_campaign') && j.productId === productId && (j.status === 'running' || j.status === 'queued'));
  const product = products.find((p) => p.id === productId) ?? null;
  // The budget box in step 3 is labelled from the template: whose budget it is, and per day or lifetime.
  const templateDoc = plan?.template as { campaign?: { budget?: { mode?: string; lifetime_budget_minor?: number | null } }; adset?: { budget?: { lifetime_budget_minor?: number | null } } } | undefined;
  const templateMode = preview?.mode ?? (templateDoc?.campaign?.budget?.mode === 'ABO' ? 'ABO' : 'CBO');
  const templateLifetime = templateMode === 'CBO' ? templateDoc?.campaign?.budget?.lifetime_budget_minor != null : templateDoc?.adset?.budget?.lifetime_budget_minor != null;
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

  /** Choosing a creative is saved at once, so what the grid shows is what the launch sends. */
  const toggleCreative = (creativeId: number) => {
    if (productId == null || templateId == null || !plan) return;
    const next = plan.creativeIds.includes(creativeId) ? plan.creativeIds.filter((x) => x !== creativeId) : [...plan.creativeIds, creativeId];
    void act(() => launch.savePlan(productId, { templateId, creativeIds: next }));
  };
  const chooseCreatives = (ids: number[]) => {
    if (productId == null || templateId == null) return;
    void act(() => launch.savePlan(productId, { templateId, creativeIds: ids }));
  };
  /** The launch settings save as soon as a box is left, so the preview below always matches. */
  const saveOverrides = (next: LaunchOverrides) => {
    if (productId == null || templateId == null) return;
    void act(() => launch.savePlan(productId, { templateId, overrides: next }));
  };
  const savePlanTemplate = () => {
    if (productId == null || templateId == null || !planDoc) return;
    void act(async () => {
      await launch.savePlan(productId, { templateId, template: planDoc });
      setPlanDirty(false);
    }, 'Saved for this product. The template file is unchanged.');
  };

  return (
    <div className="space-y-6">
      <Panel
        title="1 · Product and template"
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

      {plan && product && (
        <Panel
          title="2 · Creatives"
          action={
            <span className="flex items-center gap-2 text-xs text-ink-3">
              <span className="tabular-nums">
                {plan.creativeIds.length} chosen · {plan.slots} fill{plan.slots === 1 ? 's' : ''} the ads
              </span>
              <Button kind="quiet" disabled={busy} onClick={() => chooseCreatives(plan.creatives.filter((c) => c.approval === 'approved').map((c) => c.id))}>
                Choose every approved
              </Button>
              <Button kind="quiet" disabled={busy || !plan.creativeIds.length} onClick={() => chooseCreatives([])}>
                Clear
              </Button>
              <Button kind="quiet" disabled={busy} onClick={() => setFromShopify((v) => !v)}>
                {fromShopify ? 'Hide Shopify photos' : 'Add from Shopify'}
              </Button>
            </span>
          }
        >
          {fromShopify && (
            <div className="mb-4 pb-4 border-b border-line">
              <ShopifyPhotoPicker productId={product.id} busy={busy} onDone={refresh} />
            </div>
          )}
          {plan.creatives.length === 0 && !fromShopify && (
            <p className="text-sm text-ink-3">No finished images for this product yet. Generate a batch in the Studio, or use "Add from Shopify" to launch with the product's own photos.</p>
          )}
          {plan.creatives.length > 0 && (
            <>
              <p className="text-xs text-ink-3 mb-3">
                These go to Meta, in this order. {FILL_RULE_COPY[plan.fillRule]} Click to choose or drop one; choosing an image approves it.
              </p>
              <ul className="grid gap-3 grid-cols-3 sm:grid-cols-4 lg:grid-cols-6">
                {plan.creatives.map((c) => {
                  const order = plan.creativeIds.indexOf(c.id);
                  const chosen = order >= 0;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggleCreative(c.id)}
                        className={`block w-full text-left rounded-md overflow-hidden border-2 transition ${chosen ? 'border-cobalt' : 'border-line opacity-70 hover:opacity-100'}`}
                      >
                        <span className="relative block aspect-square bg-panel-2">
                          {c.finishedUrl && <img src={c.finishedUrl} alt={c.fileName ?? ''} className="w-full h-full object-cover" loading="lazy" />}
                          <span className={`absolute top-1 left-1 w-5 h-5 rounded-full text-xs font-medium flex items-center justify-center tabular-nums ${chosen ? 'bg-cobalt text-cobalt-ink' : 'bg-panel text-ink-3 border border-line'}`}>{chosen ? order + 1 : ''}</span>
                          {order >= plan.slots && chosen && <span className="absolute top-1 right-1 text-[10px] px-1 rounded bg-amber-soft text-amber">spare</span>}
                        </span>
                        <span className="block px-1.5 py-1 text-[11px] text-ink-3 truncate">
                          {c.aspect} · {c.approval === 'approved' ? 'approved' : sentence(c.approval)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {plan.creativeIds.length < plan.slots && (
                <p className="text-sm text-amber mt-3">
                  {plan.creativeIds.length} chosen where {plan.slots} are needed. Each ad set gets as many as there are, so some ads will be missing. Choose more, or lower the ads per ad set in step 4.
                </p>
              )}
            </>
          )}
        </Panel>
      )}

      {plan && product && (
        <Panel
          title="3 · This launch"
          action={
            <span className="flex items-center gap-2">
              <LaunchSettingsSummary changed={overriddenFields(plan.overrides)} />
              <ClearLaunchSettings disabled={busy || !overriddenFields(plan.overrides).length} onClear={() => saveOverrides(NO_OVERRIDES)} />
            </span>
          }
        >
          <p className="text-xs text-ink-3 mb-3">
            The few things that change every time. An empty box follows {plan.templateName}; what you type here belongs to this product and never reaches the template file.
          </p>
          <LaunchSettings overrides={plan.overrides} defaults={plan.defaults} mode={templateMode} lifetime={templateLifetime} busy={busy} onSave={saveOverrides} />
        </Panel>
      )}

      {plan && planDoc && product && (
        <Panel
          title="4 · Everything else in the template"
          action={
            <span className="flex items-center gap-2">
              {planDirty && <Badge tone="amber">Unsaved</Badge>}
              {plan.edited && !planDirty && <Badge tone="cobalt">Edited for this product</Badge>}
              <Button kind="quiet" onClick={() => setShowEditor((v) => !v)}>
                {showEditor ? 'Hide' : 'Edit'}
              </Button>
              {showEditor && (
                <>
                  <Button kind="quiet" disabled={busy || !plan.edited} onClick={() => act(async () => { await launch.resetPlan(product.id); setPlanDirty(false); setPlanDoc(null); }, 'Back to the template as it is in the folder.')}>
                    Start again from the template
                  </Button>
                  <Button kind="quiet" disabled={busy || !planDoc} onClick={() => act(() => launch.saveTemplate(plan.templateId, planDoc), 'Written back to the template file, for every product.')}>
                    Save to the template file
                  </Button>
                  <Button kind="primary" disabled={busy || !planDirty} onClick={savePlanTemplate}>
                    Save for this product
                  </Button>
                </>
              )}
            </span>
          }
        >
          {!showEditor && (
            <p className="text-sm text-ink-2">
              {plan.templateName}: {preview?.mode ?? ''} · {preview?.structure.adSets.length ?? plan.template.adset_count as number} ad sets × {String(plan.template.ads_per_adset)} ads.{' '}
              {plan.edited ? 'Edited for this product; the template file is untouched.' : 'Straight from the template file.'} Open it to go over every setting before launching.
            </p>
          )}
          {showEditor && (
            <TemplateEditor
              doc={planDoc}
              onChange={(next) => {
                setPlanDoc(next);
                setPlanDirty(true);
              }}
              note={
                <p className="text-xs text-ink-3 mb-3">
                  Changes here belong to this product until you write them back to the file. Save them before launching; the launch reads what is saved.
                </p>
              }
            />
          )}
        </Panel>
      )}

      {preview && product && (
        <>
          <Panel
            title="5 · Checks and launch"
            action={
              <span className="text-xs text-ink-3">
                {preview.operations} operations · {preview.imageUploads} image upload{preview.imageUploads === 1 ? '' : 's'} · {preview.requests} request{preview.requests === 1 ? '' : 's'}
                {preview.snapshotAt ? ` · Shopify read ${formatDateTime(preview.snapshotAt)}${preview.snapshotFresh ? '' : ', over 10 minutes ago'}` : ''}
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
              <Button kind="primary" disabled={busy || !!running || !preview.canLaunch || planDirty} onClick={() => act(() => launch.start(product.id, preview.templateId, acknowledged, board), 'Launching. Everything is created paused.')}>
                {running ? sentence(running.currentStep ?? running.status) : `Create ${preview.mode} campaign, paused`}
              </Button>
              {planDirty && <span className="text-xs text-amber">Save the template changes in step 4 first.</span>}
              <span className="text-xs text-ink-3">{preview.structure.adSets.length} ad sets · {preview.structure.adSets.reduce((n, s) => n + s.ads.length, 0)} ads · nothing is activated by this button</span>
              <Button kind="quiet" disabled={busy} title="One Shopify query" onClick={() => act(() => line.refreshShopify(product.id), 'Reading the product back from Shopify: one query.')}>
                Re-read from Shopify
              </Button>
              <Button kind="quiet" disabled={busy} title="One batch of delivery estimates; nothing is created" onClick={() => act(async () => setTargetingChecks((await launch.validateTargeting(product.id, preview.templateId, board)).checks), 'Targeting checked with Meta: one request.')}>
                Check targeting with Meta
              </Button>
            </div>
            {targetingChecks && (
              <ul className="mt-3 text-xs space-y-0.5">
                {targetingChecks.map((c, i) => (
                  <li key={i} className={c.ok ? 'text-green' : 'text-red'}>
                    {c.ok ? '✓' : '✕'} {c.adSet}
                    {c.ok && c.estimate?.users_lower != null && <span className="text-ink-3"> · about {c.estimate.users_lower.toLocaleString()}–{(c.estimate.users_upper ?? c.estimate.users_lower).toLocaleString()} people</span>}
                    {!c.ok && <span> · {c.message}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title={board ? '6 · Board' : `6 · Structure · ${preview.structure.campaignName}`}
            action={
              <span className="flex items-center gap-2">
                {board ? (
                  <>
                    <input className={`${inputClass} !w-48 !py-1 text-xs`} placeholder="Save as template: name" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
                    <Button kind="quiet" disabled={!saveName.trim() || busy} onClick={() => act(() => launch.saveBoard(preview.templateId, saveName.trim(), board).then(async () => { setSaveName(''); await loadTemplates(); }), 'Saved as a new template file.')}>
                      Save as template
                    </Button>
                    <Button kind="quiet" onClick={() => setBoard(null)}>
                      Discard edits
                    </Button>
                  </>
                ) : (
                  <Button kind="quiet" onClick={() => setBoard(structuredClone(preview.structure))}>
                    Edit board
                  </Button>
                )}
              </span>
            }
          >
            {board ? (
              <Board
                structure={board}
                mode={preview.mode}
                creatives={creatives}
                copies={copiesFor(preview.structure)}
                busy={busy}
                onChange={setBoard}
                onRename={async (index, name) => {
                  try {
                    const r = await launch.resolveInterest(name, product.id);
                    setNotice(r.requests ? `Interest lookup for "${r.label}": 1 request.` : 'Interest read from the cache. 0 requests.');
                    const set = board.adSets.find((x) => x.index === index)!;
                    return { ...set, name, interestKind: r.kind as LaunchAdSet['interestKind'], interestLabel: r.label, interests: r.interests, suggestions: r.suggestions };
                  } catch {
                    return null;
                  }
                }}
              />
            ) : (
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
            )}
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
                {c.metaCampaignId && <LiveEditor campaign={c} creatives={creatives} copies={preview ? copiesFor(preview.structure) : []} busy={busy} act={act} running={!!running} />}
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


function copiesFor(structure: LaunchStructure) {
  const seen = new Map<string, { label: string; primaryText: string; headline: string; description: string; destinationUrl: string }>();
  for (const s of structure.adSets) for (const a of s.ads) {
    const key = `${a.primaryText}|${a.headline}`;
    if (!seen.has(key)) seen.set(key, { label: seen.size === 0 ? 'Product copy' : `Copy ${seen.size + 1}`, primaryText: a.primaryText, headline: a.headline, description: a.description, destinationUrl: a.destinationUrl });
  }
  return [...seen.values()];
}

/** Editing a live campaign: one read, a change list, one batch. */
function LiveEditor({ campaign, creatives, copies, busy, act, running }: { campaign: CampaignView; creatives: CreativeView[]; copies: ReturnType<typeof copiesFor>; busy: boolean; act: (fn: () => Promise<unknown>, note?: string) => Promise<void>; running: boolean }) {
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<LiveCampaign | null>(null);
  const [diff, setDiff] = useState<LiveDiff[]>([]);
  const [mode, setMode] = useState<'CBO' | 'ABO'>(campaign.mode);
  const [changes, setChanges] = useState<LiveChange[]>([]);
  const [plan, setPlan] = useState<{ warnings: string[]; requests: number; operations: number } | null>(null);
  const [ack, setAck] = useState(false);
  const [draft, setDraft] = useState<{ name: string; creativeId: number | null }>({ name: '', creativeId: null });

  const load = useCallback(async () => {
    const r = await launch.live(campaign.id).catch(() => null);
    if (!r) return;
    setLive(r.live);
    setDiff(r.diff);
    setMode(r.mode);
  }, [campaign.id]);
  useEffect(() => {
    if (open) void load();
  }, [open, load, campaign.lastReadAt]);
  useEffect(() => {
    if (!live || !changes.length) return setPlan(null);
    launch.previewEdits(campaign.id, { changes, basedOn: live.readAt, acknowledgeLearning: ack }).then(setPlan).catch(() => setPlan(null));
  }, [changes, live, ack, campaign.id]);

  const add = (c: LiveChange) => setChanges((cs) => [...cs, c]);
  const setName = (s: { id: string; name: string }) => s.name;

  if (!open) {
    return (
      <div className="mt-3">
        <Button kind="quiet" onClick={() => setOpen(true)}>
          Edit live campaign
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-3 border-t border-line pt-3 space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <Button disabled={busy || running} onClick={() => act(() => launch.readCampaign(campaign.id), 'Reading from Meta: one request.')}>
          Read from Meta
        </Button>
        <span className="text-ink-3">{live ? `Last read ${new Date(live.readAt).toLocaleTimeString()} · ${live.status}` : 'Not read yet. Every edit starts with one read.'}</span>
        <Button kind="quiet" onClick={() => { setOpen(false); setChanges([]); }}>
          Close
        </Button>
      </div>
      {diff.length > 0 && (
        <div className="bg-amber-soft text-amber rounded-md p-2">
          <p className="font-medium">Changed in Meta since the previous read:</p>
          <ul>
            {diff.map((d, i) => (
              <li key={i}>
                {d.path}: {JSON.stringify(d.before)} → {JSON.stringify(d.after)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {live && (
        <>
          <div className="flex flex-wrap gap-2 items-center">
            <span className="font-medium text-sm">{live.name}</span>
            <Button kind="quiet" onClick={() => add({ type: 'campaign_status', status: live.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}>
              {live.status === 'ACTIVE' ? 'Pause campaign' : 'Resume campaign'}
            </Button>
            <Button kind="quiet" onClick={() => { const n = prompt('New campaign name', live.name); if (n) add({ type: 'rename_campaign', name: n }); }}>
              Rename
            </Button>
            {mode === 'CBO' && (
              <Button kind="quiet" onClick={() => { const v = prompt('Campaign daily budget ($)', live.dailyBudgetMinor != null ? (live.dailyBudgetMinor / 100).toFixed(2) : ''); if (v) add({ type: 'campaign_budget', dailyBudgetMinor: Math.round(Number.parseFloat(v) * 100) }); }}>
                Budget {live.dailyBudgetMinor != null ? formatMoney(live.dailyBudgetMinor) : ''}
              </Button>
            )}
          </div>
          <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {live.adSets.map((s) => (
              <div key={s.id} className="bg-panel-2 rounded-md p-2 space-y-1">
                <p className="font-medium truncate" title={setName(s)}>
                  {s.name} <span className="text-ink-3 font-normal">· {s.status}</span>
                </p>
                <p className="text-ink-3">
                  {mode === 'ABO' ? (s.dailyBudgetMinor != null ? `${formatMoney(s.dailyBudgetMinor)}/day` : 'no budget') : 'campaign budget'} · {s.interests.length ? s.interests.map((i) => i.name).join(', ') : 'broad'}
                </p>
                <div className="flex flex-wrap gap-1">
                  <Button kind="quiet" className="!px-2 !py-0.5" onClick={() => add({ type: 'adset_status', adSetId: s.id, status: s.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}>
                    {s.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                  </Button>
                  <Button kind="quiet" className="!px-2 !py-0.5" onClick={() => { const n = prompt('New ad set name', s.name); if (n) add({ type: 'rename_adset', adSetId: s.id, name: n }); }}>
                    Rename
                  </Button>
                  {mode === 'ABO' && (
                    <Button kind="quiet" className="!px-2 !py-0.5" onClick={() => { const v = prompt('Daily budget ($)', s.dailyBudgetMinor != null ? (s.dailyBudgetMinor / 100).toFixed(2) : ''); if (v) add({ type: 'adset_budget', adSetId: s.id, dailyBudgetMinor: Math.round(Number.parseFloat(v) * 100) }); }}>
                      Budget
                    </Button>
                  )}
                  <Button kind="quiet" className="!px-2 !py-0.5" onClick={() => { const v = prompt('Interests as id:name, comma separated (empty = broad)', s.interests.map((i) => `${i.id}:${i.name}`).join(', ')); if (v !== null) add({ type: 'adset_interests', adSetId: s.id, interests: v.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [id, ...rest] = x.split(':'); return { id: id!.trim(), name: rest.join(':').trim() || id!.trim() }; }) }); }}>
                    Interests
                  </Button>
                  {creatives[0] && copies[0] && (
                    <Button kind="quiet" className="!px-2 !py-0.5" onClick={() => { const c = creatives[0]!; add({ type: 'add_ad', adSetId: s.id, ad: { creativeId: c.id, fileName: c.fileName ?? '', ...copies[0]! } }); }}>
                      + ad
                    </Button>
                  )}
                </div>
                <ul className="text-ink-2">
                  {s.ads.map((a) => (
                    <li key={a.id} className="flex items-center gap-1">
                      <span className="truncate flex-1">{a.name}</span>
                      <span className="text-ink-3">{a.status}</span>
                      <button type="button" className="text-cobalt" onClick={() => add({ type: 'ad_status', adId: a.id, status: a.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}>
                        {a.status === 'ACTIVE' ? 'pause' : 'resume'}
                      </button>
                      {creatives[0] && copies[0] && (
                        <button type="button" className="text-cobalt" onClick={() => { const pick = prompt(`Replace with which creative? ${creatives.map((c) => `${c.id}=${c.fileName}`).join(', ')}`); const c = creatives.find((x) => String(x.id) === pick); if (c) add({ type: 'replace_ad_creative', adId: a.id, ad: { creativeId: c.id, fileName: c.fileName ?? '', ...copies[0]! } }); }}>
                          swap
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const c = creatives.find((x) => x.id === draft.creativeId) ?? creatives[0];
              if (!draft.name.trim() || !c || !copies[0]) return;
              const s = live.adSets[0];
              add({ type: 'add_adset', adSet: { index: live.adSets.length, name: draft.name.trim(), budgetMinor: mode === 'ABO' ? (s?.dailyBudgetMinor ?? 2000) : null, interestKind: 'broad', interestLabel: null, interests: [], suggestions: [], countryOverride: null, ageBand: null, ads: [{ creativeId: c.id, fileName: c.fileName ?? '', ...copies[0] }] } });
              setDraft({ name: '', creativeId: null });
            }}
          >
            <label className="block">
              <span className="block text-ink-2 mb-1">Add ad set</span>
              <input className={inputClass} placeholder="US - Formal Wear" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="block">
              <span className="block text-ink-2 mb-1">First ad's image</span>
              <select className={inputClass} value={draft.creativeId ?? ''} onChange={(e) => setDraft({ ...draft, creativeId: Number(e.target.value) || null })}>
                <option value="">First approved</option>
                {creatives.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fileName}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={!draft.name.trim() || !creatives.length}>
              Queue ad set
            </Button>
          </form>
          {changes.length > 0 && (
            <div className="border border-line rounded-md p-2 space-y-2">
              <p className="font-medium">Change list ({changes.length})</p>
              <ul className="text-ink-2">
                {changes.map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="flex-1">{describeChange(c, live)}</span>
                    <button type="button" className="text-ink-3" onClick={() => setChanges((cs) => cs.filter((_, k) => k !== i))}>
                      remove
                    </button>
                  </li>
                ))}
              </ul>
              {plan && (
                <p className="text-ink-3">
                  {plan.operations} operation(s) · {plan.requests} request(s) including the read
                </p>
              )}
              {plan?.warnings.length ? (
                <div className="text-amber">
                  {plan.warnings.map((w, i) => (
                    <p key={i}>! {w}</p>
                  ))}
                  <label className="flex items-center gap-1 text-ink-2 mt-1">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand these may restart learning
                  </label>
                </div>
              ) : null}
              <Button kind="primary" disabled={busy || running || (!!plan?.warnings.length && !ack)} onClick={() => act(() => launch.applyEdits(campaign.id, { changes, basedOn: live.readAt, acknowledgeLearning: ack }).then(() => setChanges([])), 'Applying: one batch.')}>
                Apply {changes.length} change{changes.length === 1 ? '' : 's'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function describeChange(c: LiveChange, live: LiveCampaign): string {
  const set = (id: string) => live.adSets.find((s) => s.id === id)?.name ?? id;
  const ad = (id: string) => live.adSets.flatMap((s) => s.ads).find((a) => a.id === id)?.name ?? id;
  switch (c.type) {
    case 'rename_campaign': return `Rename campaign to "${c.name}"`;
    case 'campaign_status': return `${c.status === 'ACTIVE' ? 'Resume' : 'Pause'} campaign`;
    case 'campaign_budget': return `Campaign budget → ${formatMoney(c.dailyBudgetMinor)}/day`;
    case 'adset_status': return `${c.status === 'ACTIVE' ? 'Resume' : 'Pause'} ${set(c.adSetId)}`;
    case 'adset_budget': return `${set(c.adSetId)} budget → ${formatMoney(c.dailyBudgetMinor)}/day`;
    case 'rename_adset': return `Rename ${set(c.adSetId)} to "${c.name}"`;
    case 'adset_interests': return `${set(c.adSetId)} interests → ${c.interests.map((i) => i.name).join(', ') || 'broad'}`;
    case 'ad_status': return `${c.status === 'ACTIVE' ? 'Resume' : 'Pause'} ad ${ad(c.adId)}`;
    case 'add_adset': return `Add ad set "${c.adSet.name}" with ${c.adSet.ads.length} ad(s)`;
    case 'add_ad': return `Add ad ${c.ad.fileName} to ${set(c.adSetId)}`;
    case 'replace_ad_creative': return `Replace the creative of ${ad(c.adId)} with ${c.ad.fileName}`;
  }
}
