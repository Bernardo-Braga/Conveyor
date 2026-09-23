import { useEffect, useState } from 'react';
import { ASPECTS, BUILTIN_PROMPT_VARIABLES, PROMPT_9x16_RULE, PROMPT_FIXED_RULES, type Aspect, type PromptTemplateView, type ReferenceRule } from '@conveyor/shared';
import { studio } from '../lib/api.ts';
import { Badge, Button, Field, Panel, inputClass } from './Panel.tsx';

type Draft = { id: number | null; name: string; body: string; formats: Aspect[]; countPerFormat: string; referenceRule: ReferenceRule; isDefault: boolean };

/** Image prompts, PLAN.md section 10: versioned bodies with variable chips. */
export function PromptTemplatesPanel() {
  const [list, setList] = useState<PromptTemplateView[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => studio.templates().then(setList).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  const edit = (t?: PromptTemplateView) =>
    setDraft(t ? { id: t.id, name: t.name, body: t.body, formats: t.formats, countPerFormat: String(t.countPerFormat), referenceRule: t.referenceRule, isDefault: t.isDefault } : { id: null, name: '', body: '', formats: [...ASPECTS], countPerFormat: '4', referenceRule: 'first_3_shopify_images', isDefault: false });

  const save = async () => {
    if (!draft) return;
    const body = { name: draft.name, body: draft.body, formats: draft.formats, countPerFormat: Number(draft.countPerFormat), referenceRule: draft.referenceRule, isDefault: draft.isDefault };
    try {
      await (draft.id ? studio.saveTemplate(draft.id, body) : studio.createTemplate(body));
      setDraft(null);
      setMsg('Saved as a new version. Earlier batches keep the version they used.');
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const vars = draft ? [...new Set([...draft.body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!))] : [];

  return (
    <Panel title="Image prompts" action={<Button onClick={() => edit()}>New prompt</Button>}>
      <ul className="divide-y divide-line mb-4">
        {list.map((t) => (
          <li key={t.id} className="py-2 flex items-center gap-3 text-sm">
            <span className="font-medium">{t.name}</span>
            <span className="text-xs text-ink-3">v{t.version} · {t.formats.join(', ')} · {t.countPerFormat} per format · {t.referenceRule.replace(/_/g, ' ')}</span>
            {t.isDefault && <Badge tone="cobalt">Default</Badge>}
            <span className="ml-auto flex gap-1">
              {!t.isDefault && (
                <Button kind="quiet" onClick={() => studio.setDefaultTemplate(t.id).then(load)}>
                  Make default
                </Button>
              )}
              <Button kind="quiet" onClick={() => edit(t)}>
                Edit
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {draft && (
        <div className="border border-line rounded-panel p-4 bg-panel-2 space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Name">
              <input className={inputClass} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} disabled={!!draft.id} />
            </Field>
            <Field label="Images per format">
              <input className={inputClass} inputMode="numeric" value={draft.countPerFormat} onChange={(e) => setDraft({ ...draft, countPerFormat: e.target.value })} />
            </Field>
            <Field label="Reference images" hint="Downloaded once per product from Shopify">
              <select className={inputClass} value={draft.referenceRule} onChange={(e) => setDraft({ ...draft, referenceRule: e.target.value as ReferenceRule })}>
                <option value="first_3_shopify_images">First 3 Shopify images</option>
                <option value="first_shopify_image">First Shopify image</option>
                <option value="none">None</option>
              </select>
            </Field>
          </div>
          <Field label="Prompt" hint="Variables: built-in chips below, or your own such as {{scene}} or {{audience}}, filled per batch. Each image in a batch gets its own shot (angle and framing) from a built-in list. To choose them yourself, end the prompt with a line reading Shots: and then one shot per line.">
            <textarea className={`${inputClass} min-h-36 font-mono text-xs`} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </Field>
          <div className="flex flex-wrap gap-1">
            {BUILTIN_PROMPT_VARIABLES.map((v) => (
              <button key={v} type="button" className={`px-2 py-0.5 rounded-full text-xs border ${vars.includes(v) ? 'border-cobalt text-cobalt bg-cobalt-soft' : 'border-line text-ink-2'}`} onClick={() => setDraft({ ...draft, body: `${draft.body}{{${v}}}` })}>
                {`{{${v}}}`}
              </button>
            ))}
            {vars.filter((v) => !(BUILTIN_PROMPT_VARIABLES as readonly string[]).includes(v)).map((v) => (
              <Badge key={v} tone="amber">{`{{${v}}} custom`}</Badge>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="flex gap-2">
              {ASPECTS.map((a) => (
                <label key={a} className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={draft.formats.includes(a)} onChange={(e) => setDraft({ ...draft, formats: e.target.checked ? [...ASPECTS].filter((x) => x === a || draft.formats.includes(x)) : draft.formats.filter((x) => x !== a) })} />
                  {a}
                </label>
              ))}
            </span>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} /> Default
            </label>
            <span className="ml-auto flex gap-2">
              <Button kind="quiet" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button kind="primary" disabled={!draft.name.trim() || draft.body.trim().length < 10 || !draft.formats.length} onClick={save}>
                Save version
              </Button>
            </span>
          </div>
          <p className="text-xs text-ink-3">Always appended: “{PROMPT_FIXED_RULES}” and, for 9:16, “{PROMPT_9x16_RULE}”</p>
        </div>
      )}
      {msg && <p className="text-xs text-ink-3 mt-2">{msg}</p>}
    </Panel>
  );
}
