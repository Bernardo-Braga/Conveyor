import { Panel } from '../components/Panel.tsx';

export function StudioView() {
  return (
    <Panel title="Creative studio">
      <p className="text-sm text-ink-3">Codex workers, the gallery and finishing arrive in phase 4. Run the smoke test first: <code className="font-mono">pnpm codex:smoke</code>.</p>
    </Panel>
  );
}
