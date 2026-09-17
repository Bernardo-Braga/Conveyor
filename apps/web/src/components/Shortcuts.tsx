import { useEffect, useState } from 'react';
import { Dialog } from 'radix-ui';
import { Button } from './Panel.tsx';

export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: '1 … 6', what: 'Switch tab: Line, Studio, Launch, Templates, Requests, Settings' },
  { keys: '/', what: 'Focus the Line input bar' },
  { keys: 'j', what: 'Open or close the Activity drawer' },
  { keys: 'A / X', what: 'Studio: approve or reject the selected image' },
  { keys: 'R / E', what: 'Studio: regenerate the selected image, or send it back with an instruction' },
  { keys: '← → ↑ ↓', what: 'Studio: move the selection' },
  { keys: '?', what: 'This list' },
];

/** Global shortcuts. Never fire while typing in a field. */
export function useGlobalShortcuts(handlers: { goTo: (index: number) => void; toggleActivity: () => void; focusLine: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key >= '1' && e.key <= '6') handlers.goTo(Number(e.key) - 1);
      else if (e.key === 'j') handlers.toggleActivity();
      else if (e.key === '/') {
        e.preventDefault();
        handlers.focusLine();
      } else if (e.key === '?') setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);
  return { open, setOpen };
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/20" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-panel border border-line rounded-panel shadow-xl p-5 focus:outline-none">
          <div className="flex items-center justify-between mb-3">
            <Dialog.Title className="text-sm font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Description className="sr-only">Keys that work anywhere in Conveyor</Dialog.Description>
            <Dialog.Close asChild>
              <Button kind="quiet">Close</Button>
            </Dialog.Close>
          </div>
          <ul className="text-sm divide-y divide-line">
            {SHORTCUTS.map((s) => (
              <li key={s.keys} className="py-1.5 flex gap-4">
                <kbd className="font-mono text-xs bg-panel-2 border border-line rounded px-1.5 py-0.5 whitespace-nowrap">{s.keys}</kbd>
                <span className="text-ink-2">{s.what}</span>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
