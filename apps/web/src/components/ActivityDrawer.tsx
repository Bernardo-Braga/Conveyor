import { Dialog } from 'radix-ui';
import { useEffect, useState } from 'react';
import type { JobView } from '@conveyor/shared';
import { api } from '../lib/api.ts';
import type { LiveState } from '../lib/events.ts';
import { formatTime, sentence } from '../lib/format.ts';
import { Badge, Button } from './Panel.tsx';

/** Every job, its steps and log lines with request IDs. Streams live over SSE. */
export function ActivityDrawer({ open, onOpenChange, live }: { open: boolean; onOpenChange: (o: boolean) => void; live: LiveState }) {
  const [history, setHistory] = useState<JobView[]>([]);
  useEffect(() => {
    if (open) api.jobs(50).then(setHistory).catch(() => setHistory([]));
  }, [open]);

  const merged = new Map<number, JobView>();
  for (const j of history) merged.set(j.id, j);
  for (const j of live.jobs.values()) merged.set(j.id, j);
  const jobs = [...merged.values()].sort((a, b) => b.id - a.id);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/20" />
        <Dialog.Content className="fixed top-0 right-0 h-full w-full max-w-lg bg-panel border-l border-line shadow-xl flex flex-col focus:outline-none">
          <header className="flex items-center justify-between px-5 h-14 border-b border-line">
            <Dialog.Title className="text-sm font-semibold">Activity</Dialog.Title>
            <Dialog.Description className="sr-only">Jobs, their steps and log lines</Dialog.Description>
            <Dialog.Close asChild>
              <Button kind="quiet">Close</Button>
            </Dialog.Close>
          </header>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {jobs.length === 0 && <p className="text-sm text-ink-3">No jobs yet. Every button creates one.</p>}
            {jobs.map((j) => (
              <JobCard key={j.id} job={j} log={live.logs.get(j.id) ?? j.log} />
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function tone(status: JobView['status']) {
  return status === 'done' ? 'green' : status === 'failed' ? 'red' : status === 'running' ? 'cobalt' : 'grey';
}

function JobCard({ job, log }: { job: JobView; log: JobView['log'] }) {
  const [busy, setBusy] = useState(false);
  return (
    <article className="border border-line rounded-panel bg-panel-2">
      <header className="flex items-center gap-2 px-4 py-2.5">
        <span className="text-sm font-medium">{sentence(job.type)}</span>
        <span className="text-xs text-ink-3">#{job.id}</span>
        <Badge tone={tone(job.status)}>{sentence(job.status)}</Badge>
        <span className="ml-auto text-xs text-ink-3">{formatTime(job.startedAt ?? job.createdAt)}</span>
      </header>
      <ol className="px-4 pb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {job.steps.map((s) => {
          const done = job.completedSteps.includes(s);
          const current = job.currentStep === s && job.status === 'running';
          const failed = job.error?.step === s;
          return (
            <li key={s} className={failed ? 'text-red' : done ? 'text-green' : current ? 'text-cobalt' : 'text-ink-3'}>
              {done ? '✓' : failed ? '✕' : current ? '…' : '·'} {s}
            </li>
          );
        })}
      </ol>
      {job.error && (
        <div className="mx-4 mb-3 px-3 py-2 rounded-md bg-red-soft text-red text-xs space-y-1">
          <p>
            <strong>{job.error.step}</strong>: {job.error.message}
          </p>
          {job.error.suggestion && <p className="text-ink-2">{job.error.suggestion}</p>}
          {(job.error.code || job.error.requestId) && (
            <p className="text-ink-3">
              {job.error.service && `${job.error.service} `}
              {job.error.code && `code ${job.error.code}`}
              {job.error.subcode && ` / ${job.error.subcode}`}
              {job.error.requestId && ` · request ${job.error.requestId}`}
            </p>
          )}
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.retryJob(job.id);
              } finally {
                setBusy(false);
              }
            }}
          >
            Retry from this step
          </Button>
        </div>
      )}
      {log.length > 0 && (
        <ul className="px-4 pb-3 space-y-0.5 text-xs font-mono text-ink-2">
          {log.slice(-8).map((l, i) => (
            <li key={i} className={l.level === 'error' ? 'text-red' : l.level === 'warn' ? 'text-amber' : ''}>
              <span className="text-ink-3">{formatTime(l.at)}</span> {l.message}
              {l.requestId && <span className="text-ink-3"> · {l.requestId}</span>}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
