/**
 * A thin HTTP client for the supervisor API.
 *
 * Presentations never hold the supervisor object; they talk to it over the
 * same API a remote client would, so a CLI, a browser and an IM gateway are
 * interchangeable.
 */
import type {
  Decision,
  DecisionAnswer,
  SessionEvent,
  SessionId,
} from '@supervisor/protocol';

export interface SessionView {
  id: SessionId;
  name: string;
  adapter: string;
  cwd: string;
  purpose?: string;
  model?: string;
  role: 'worker' | 'orchestrator';
  state: 'starting' | 'idle' | 'working' | 'waiting' | 'stopped';
  nativeSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export class SupervisorClient {
  constructor(
    readonly baseUrl: string,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(new URL('/api/health', this.baseUrl));
      return res.ok;
    } catch {
      return false;
    }
  }

  async sessions(): Promise<SessionView[]> {
    return this.#json<SessionView[]>(await this.#request('GET', '/api/sessions'));
  }

  async openSession(input: {
    name: string;
    cwd: string;
    purpose?: string;
    model?: string;
    task?: string;
  }): Promise<SessionView> {
    return this.#json<SessionView>(
      await this.#request('POST', '/api/sessions', input),
    );
  }

  async send(session: SessionId, text: string): Promise<void> {
    await this.#request('POST', `/api/sessions/${session}/messages`, { text });
  }

  async stop(session: SessionId): Promise<void> {
    await this.#request('POST', `/api/sessions/${session}/stop`);
  }

  async interrupt(session: SessionId): Promise<void> {
    await this.#request('POST', `/api/sessions/${session}/interrupt`);
  }

  async sessionEvents(sessionId: SessionId, limit = 50): Promise<SessionEvent[]> {
    return this.#json<SessionEvent[]>(
      await this.#request('GET', `/api/sessions/${sessionId}/events?limit=${limit}`),
    );
  }

  async decisions(status?: string): Promise<Decision[]> {
    const query = status ? `?status=${status}` : '';
    return this.#json<Decision[]>(await this.#request('GET', `/api/decisions${query}`));
  }

  async answer(id: string, answer: DecisionAnswer): Promise<Decision> {
    const body = await this.#json<{ decision: Decision }>(
      await this.#request('POST', `/api/decisions/${id}/answer`, answer),
    );
    return body.decision;
  }

  async shutdown(): Promise<void> {
    await this.#request('POST', '/api/admin/shutdown');
  }

  /**
   * Follow the live event stream. Returns an abort function. Reconnects
   * automatically unless aborted, resuming from the last sequence number.
   */
  stream(onEvent: (event: SessionEvent) => void): () => void {
    const controller = new AbortController();
    let lastSeq = 0;

    const connect = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          const res = await this.fetchImpl(new URL('/api/events', this.baseUrl), {
            headers: { accept: 'text/event-stream', 'last-event-id': String(lastSeq) },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
          await readSse(res.body, (id, data) => {
            if (id !== undefined) lastSeq = Number(id);
            onEvent(data as SessionEvent);
          });
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };

    void connect();
    return () => controller.abort();
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${method} ${path} failed: ${res.status} ${detail}`);
    }
    return res;
  }

  async #json<T>(res: Response): Promise<T> {
    return (await res.json()) as T;
  }
}

/** Parse a server-sent-events body into (id, data) callback invocations. */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (id: string | undefined, data: unknown) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let id: string | undefined;
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('id:')) id = line.slice(3).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        onEvent(id, JSON.parse(data));
      } catch {
        // Ignore malformed frames rather than dropping the stream.
      }
    }
  }
}
