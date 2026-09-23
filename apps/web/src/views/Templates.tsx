import { useCallback, useEffect, useState } from 'react';
import type { TemplateView } from '@conveyor/shared';
import { Badge, Button, Panel, inputClass } from '../components/Panel.tsx';
import { TemplateEditor, type Json } from '../components/TemplateEditor.tsx';
import { ApiError, launch, type TemplateList } from '../lib/api.ts';
import { formatDateTime, formatMoney } from '../lib/format.ts';


/**
 * The templates folder, editable. Each template is a JSON file in the other tool's format under
 * the data directory; this tab edits the fields that matter and writes the file back. Anything
 * not shown is kept as is (the format passes through).
 */
export function TemplatesView() {
  const [list, setList] = useState<TemplateList | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [doc, setDoc] = useState<Json | null>(null);
  const [view, setView] = useState<TemplateView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const l = await launch.templates().catch(() => null);
    if (!l) return;
    setList(l);
    setSelected((cur) => cur ?? l.templates.find((t) => t.isDefault)?.id ?? l.templates[0]?.id ?? null);
    const notes = [...l.sync.added.map((f) => `added ${f}`), ...l.sync.updated.map((f) => `updated ${f}`), ...l.sync.missing.map((f) => `missing ${f}`), ...l.sync.skipped.map((s) => `skipped ${s.file}: ${s.reason}`)];
    if (notes.length) setMsg(`Folder sync: ${notes.join('; ')}`);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (selected == null) return;
    launch.template(selected).then(({ view: v, json }) => {
      setView(v);
      setDoc(json);
      setDirty(false);
    }).catch(() => undefined);
  }, [selected]);

  const act = async (fn: () => Promise<unknown>, note?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (note) setMsg(note);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      if (!doc || selected == null) return;
      const r = await launch.saveTemplate(selected, doc);
      setDoc(r.json);
      setView(r.view);
      setDirty(false);
      await load();
    }, 'Saved to the file.');

  const [proposal, setProposal] = useState<{ signature: string; mapping: Record<string, { from: string | null; value?: unknown }>; preview: Record<string, unknown>; problems: string[]; writer: string; raw: Record<string, unknown> } | null>(null);
  const importFile = (file: File) =>
    act(async () => {
      const raw = JSON.parse(await file.text()) as Record<string, unknown>;
      const r = await launch.importTemplate(raw);
      if (r.kind === 'imported') {
        await load();
        setSelected(r.template.id);
        setMsg(`Added to the folder (${r.format} format). ${r.notes.join(' ')}`);
      } else if (r.kind === 'proposal') {
        setProposal({ ...r, raw });
        setMsg(`Unknown format. ${r.writer} proposed a mapping; check it below and confirm.`);
      } else setMsg(r.message);
    });
  const confirmProposal = () =>
    act(async () => {
      if (!proposal) return;
      const r = await launch.confirmImport({ signature: proposal.signature, mapping: proposal.mapping, raw: proposal.raw });
      if (r.kind === 'imported') {
        setProposal(null);
        await load();
        setSelected(r.template.id);
        setMsg(`Imported. ${r.notes.join(' ')}`);
      }
    });


  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_1fr] items-start">
      <Panel
        title="Templates"
        action={
          <label className="text-xs text-cobalt cursor-pointer">
            Add file
            <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
          </label>
        }
      >
        {list && (
          <p className="text-xs text-ink-3 mb-3 break-all">
            Folder: <code>{list.folder.dir}</code>. Drop the other tool's exports here; they appear on the next visit.
          </p>
        )}
        <ul className="divide-y divide-line -mx-5">
          {list?.templates.map((t) => (
            <li key={t.id}>
              <button className={`w-full text-left px-5 py-2.5 hover:bg-panel-2 ${selected === t.id ? 'bg-cobalt-soft/40' : ''}`} onClick={() => setSelected(t.id)}>
                <p className="text-sm font-medium flex items-center gap-2">
                  <span className="truncate">{t.name}</span>
                  {t.isDefault && <Badge tone="cobalt">Default</Badge>}
                  {t.fileMissing && <Badge tone="amber">File missing</Badge>}
                </p>
                <p className="text-xs text-ink-3">
                  v{t.version} · {t.mode} · {t.adSetCount} × {t.adsPerAdSet} · {t.mode === 'CBO' ? `${formatMoney(t.campaignBudgetMinor ?? 0)}/day campaign` : `${formatMoney(t.adSetBudgetMinor ?? 0)}/day per ad set`}
                </p>
                <p className="text-xs text-ink-3 truncate">{t.fileName ?? 'stored only'}</p>
              </button>
            </li>
          ))}
          {list && list.templates.length === 0 && <li className="px-5 py-3 text-sm text-ink-3">No templates in the folder yet.</li>}
        </ul>
      </Panel>

      {proposal && (
        <Panel title="Proposed mapping" action={<span className="flex gap-2"><Button kind="quiet" onClick={() => setProposal(null)}>Discard</Button><Button kind="primary" disabled={busy || proposal.problems.some((p) => !/^note/i.test(p) && /empty|nothing found/i.test(p))} onClick={confirmProposal}>Confirm and save profile</Button></span>}>
          <p className="text-sm text-ink-2 mb-3">One writer run proposed how this file maps onto the template. Edit a source path or value, then confirm. Files of the same shape will import with 0 requests from then on.</p>
          {proposal.problems.length > 0 && (
            <ul className="text-xs text-amber mb-3 space-y-0.5">
              {proposal.problems.map((p, i) => (
                <li key={i}>! {p}</li>
              ))}
            </ul>
          )}
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr] text-xs">
            <span className="font-medium text-ink-2">Template field</span>
            <span className="font-medium text-ink-2">From (path in your file)</span>
            <span className="font-medium text-ink-2">Or a fixed value</span>
            {Object.entries(proposal.mapping).map(([target, rule]) => (
              <>
                <code key={`${target}-t`} className="py-1.5">{target}</code>
                <input key={`${target}-f`} className={inputClass} value={rule.from ?? ''} onChange={(e) => setProposal({ ...proposal, mapping: { ...proposal.mapping, [target]: { ...rule, from: e.target.value || null } } })} />
                <input key={`${target}-v`} className={inputClass} value={rule.value == null ? '' : String(rule.value)} onChange={(e) => setProposal({ ...proposal, mapping: { ...proposal.mapping, [target]: { ...rule, value: e.target.value === '' ? undefined : e.target.value } } })} />
              </>
            ))}
          </div>
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-ink-2">Preview of the template this produces</summary>
            <pre className="mt-2 p-2 bg-panel-2 rounded-md overflow-x-auto max-h-64">{JSON.stringify(proposal.preview, null, 2)}</pre>
          </details>
        </Panel>
      )}

      {doc && view && (
        <Panel
          title={view.name}
          action={
            <span className="flex items-center gap-2">
              {dirty && <Badge tone="amber">Unsaved</Badge>}
              <Button kind="quiet" disabled={busy} onClick={() => act(() => launch.duplicateTemplate(view.id).then(async (t) => { await load(); setSelected(t.id); }), 'Duplicated as a new file.')}>
                Duplicate
              </Button>
              {!view.isDefault && (
                <Button kind="quiet" disabled={busy} onClick={() => act(() => launch.setDefaultTemplate(view.id).then(load), 'Set as the default template.')}>
                  Make default
                </Button>
              )}
              <a className="px-3 py-1.5 text-sm rounded-md border border-line" href={launch.exportUrl(view.id)} download>
                Export for my other tool
              </a>
              <a className="px-3 py-1.5 text-sm rounded-md border border-line" href={launch.exportUrl(view.id, true)} download>
                Backup
              </a>
              <Button kind="quiet" disabled={busy} onClick={() => act(() => launch.deleteTemplate(view.id).then(async () => { setSelected(null); setDoc(null); await load(); }), 'Moved to templates/trash.')}>
                Remove
              </Button>
              <Button kind="primary" disabled={busy || !dirty} onClick={save}>
                Save to file
              </Button>
            </span>
          }
        >
          <p className="text-xs text-ink-3 mb-3">
            {view.fileName ? `File ${view.fileName}` : 'Not linked to a file yet; saving creates one'} · updated {formatDateTime(view.updatedAt)} · id {view.templateId}. Fields not shown here are kept exactly as exported.
          </p>
          <TemplateEditor doc={doc} onChange={(next) => { setDoc(next); setDirty(true); }} />
          {msg && <p className="text-xs text-ink-3 mt-3">{msg}</p>}
        </Panel>
      )}
      {!doc && msg && <p className="text-xs text-ink-3">{msg}</p>}
    </div>
  );
}
