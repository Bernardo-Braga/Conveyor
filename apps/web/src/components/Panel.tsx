import type { ReactNode } from 'react';

export function Panel({ title, action, children, className = '' }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`bg-panel border border-line rounded-panel ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between px-5 py-3 border-b border-line">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {action}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Button({ kind = 'secondary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'secondary' | 'quiet' }) {
  const styles =
    kind === 'primary'
      ? 'bg-cobalt text-cobalt-ink hover:brightness-110 border-transparent'
      : kind === 'quiet'
        ? 'bg-transparent border-transparent text-ink-2 hover:text-ink hover:bg-panel-2'
        : 'bg-panel border-line text-ink hover:bg-panel-2';
  return <button className={`px-3 py-1.5 text-sm rounded-md border transition ${styles} ${className}`} {...props} />;
}

export function Badge({ tone, children }: { tone: 'cobalt' | 'amber' | 'green' | 'red' | 'grey'; children: ReactNode }) {
  const map = {
    cobalt: 'bg-cobalt-soft text-cobalt',
    amber: 'bg-amber-soft text-amber',
    green: 'bg-green-soft text-green',
    red: 'bg-red-soft text-red',
    grey: 'bg-panel-2 text-ink-2',
  } as const;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${map[tone]}`}>{children}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-ink-2 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-3 mt-1">{hint}</span>}
    </label>
  );
}

export const inputClass = 'w-full px-3 py-1.5 text-sm rounded-md border border-line bg-panel text-ink placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-cobalt-soft focus:border-cobalt';
