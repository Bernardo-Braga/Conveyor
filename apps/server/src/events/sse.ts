import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { EventBus } from './bus.ts';

const HEARTBEAT_MS = 15_000;

/** `GET /api/events`: streams every server event as JSON, with a heartbeat comment every 15 s. */
export function sseHandler(bus: EventBus, heartbeatMs = HEARTBEAT_MS) {
  return (c: Context) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      let open = true;
      const send = (data: string, event: string) => stream.writeSSE({ id: String(++id), event, data }).catch(() => undefined);

      // Subscribe before the hello so nothing emitted during the handshake is missed.
      const unsubscribe = bus.subscribe((ev) => {
        if (open) void send(JSON.stringify(ev), 'message');
      });
      await send(JSON.stringify({ kind: 'hello', at: new Date().toISOString() }), 'message');
      const beat = setInterval(() => {
        if (open) void send(JSON.stringify({ kind: 'heartbeat', at: new Date().toISOString() }), 'heartbeat');
      }, heartbeatMs);

      const closed = new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
        // Hono only watches the response body for cancellation; a dropped request signal counts too.
        c.req.raw.signal.addEventListener('abort', () => stream.abort(), { once: true });
      });
      await closed;
      open = false;
      clearInterval(beat);
      unsubscribe();
    });
}
