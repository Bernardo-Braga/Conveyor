import { useEffect, useRef, useState } from 'react';
import type { JobLogLine, JobView, ServerEvent } from '@conveyor/shared';

export interface LiveState {
  connected: boolean;
  jobs: Map<number, JobView>;
  logs: Map<number, JobLogLine[]>;
  ledgerCount: number;
}

/** Subscribes to the server's SSE stream and keeps the latest view of every job. */
export function useServerEvents(): LiveState {
  const [connected, setConnected] = useState(false);
  const [tick, setTick] = useState(0);
  const jobs = useRef(new Map<number, JobView>());
  const logs = useRef(new Map<number, JobLogLine[]>());
  const ledgerCount = useRef(0);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data as string) as ServerEvent;
      if (ev.kind === 'job') {
        jobs.current.set(ev.job.id, ev.job);
        logs.current.set(ev.job.id, ev.job.log);
      } else if (ev.kind === 'log') {
        logs.current.set(ev.jobId, [...(logs.current.get(ev.jobId) ?? []), ev.line]);
      } else if (ev.kind === 'ledger') {
        ledgerCount.current += 1;
      }
      setTick((t) => t + 1);
    };
    return () => es.close();
  }, []);

  void tick;
  return { connected, jobs: jobs.current, logs: logs.current, ledgerCount: ledgerCount.current };
}
