import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@conveyor/shared';

type Listener = (event: ServerEvent) => void;

/** In-process fan-out of server events to SSE subscribers and tests. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: Listener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount('event');
  }
}
