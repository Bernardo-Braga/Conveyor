import { useEffect, useState } from 'react';
import { ActivityDrawer } from './components/ActivityDrawer.tsx';
import { Button } from './components/Panel.tsx';
import { api } from './lib/api.ts';
import { useServerEvents } from './lib/events.ts';
import { LaunchView } from './views/Launch.tsx';
import { TemplatesView } from './views/Templates.tsx';
import { LineView } from './views/Line.tsx';
import { SettingsView } from './views/Settings.tsx';
import { StudioView } from './views/Studio.tsx';

const VIEWS = ['Line', 'Studio', 'Launch', 'Templates', 'Settings'] as const;
type View = (typeof VIEWS)[number];

export function App() {
  const [view, setView] = useState<View>(() => (VIEWS.find((v) => v === location.hash.slice(1)) ?? 'Line'));
  const [drawer, setDrawer] = useState(false);
  const [health, setHealth] = useState<{ ok: boolean } | null>(null);
  const live = useServerEvents();

  useEffect(() => {
    if (location.hash.slice(1) !== view) location.hash = view;
  }, [view]);
  useEffect(() => {
    const onHash = () => {
      const v = VIEWS.find((x) => x === location.hash.slice(1));
      if (v) setView(v);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ ok: false }));
  }, []);

  const running = [...live.jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length;

  return (
    <div className="min-h-full flex flex-col">
      <header className="bg-panel border-b border-line">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-8">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-cobalt" />
            <span className="font-semibold tracking-tight">Conveyor</span>
          </div>
          <nav className="flex items-center gap-1">
            {VIEWS.map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 text-sm rounded-md transition ${view === v ? 'bg-cobalt-soft text-cobalt font-medium' : 'text-ink-2 hover:text-ink hover:bg-panel-2'}`}
              >
                {v}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-ink-3">
            <span className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${live.connected && health?.ok ? 'bg-green' : 'bg-amber'}`} />
              {live.connected && health?.ok ? 'Server connected' : 'Connecting to server'}
            </span>
            <Button kind="quiet" onClick={() => setDrawer(true)}>
              Activity{running ? ` (${running})` : ''}
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1">
        <div className="max-w-6xl mx-auto px-6 py-6">
          {view === 'Line' && <LineView live={live} />}
          {view === 'Studio' && <StudioView live={live} />}
          {view === 'Launch' && <LaunchView live={live} />}
          {view === 'Templates' && <TemplatesView />}
          {view === 'Settings' && <SettingsView live={live} />}
        </div>
      </main>
      <ActivityDrawer open={drawer} onOpenChange={setDrawer} live={live} />
    </div>
  );
}
