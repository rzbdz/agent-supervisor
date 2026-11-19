import type { SessionEvent } from '@supervisor/protocol';

/**
 * Listener signature. `seq` is the event's position in the persistent log, so
 * a stream client can resume with `Last-Event-ID` and never see a gap or a
 * duplicate.
 */
export type EventListener = (event: SessionEvent, seq: number) => void;

/**
 * In-process fan-out of session events to presentations and the event log.
 *
 * Listener failures are isolated: one broken presentation must not stop the
 * supervisor or starve the other listeners.
 */
export class EventBus {
  readonly #listeners = new Set<EventListener>();
  readonly #sinks: Array<(event: SessionEvent, seq: number) => void> = [];

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Register a side-channel sink (the event log) that runs before listeners. */
  addSink(sink: (event: SessionEvent, seq: number) => void): void {
    this.#sinks.push(sink);
  }

  publish(event: SessionEvent, seq: number): void {
    for (const sink of this.#sinks) {
      try {
        sink(event, seq);
      } catch {
        // A logging failure must not break the live stream.
      }
    }
    for (const listener of this.#listeners) {
      try {
        listener(event, seq);
      } catch {
        // Presentations are best-effort observers.
      }
    }
  }
}
