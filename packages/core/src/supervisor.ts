import type {
  AgentEvent,
  SessionEvent,
  SessionId,
} from '@supervisor/protocol';
import { asSessionId } from '@supervisor/protocol';
import type {
  AgentAdapter,
  AgentHost,
  AgentSession,
  LoggedEvent,
  PersistedState,
  StateStore,
  ToolSpec,
} from './ports.ts';
import { EventBus } from './bus.ts';
import { DecisionQueue } from './decisions.ts';

export interface SupervisorConfig {
  adapter: AgentAdapter;
  store: StateStore;
  /** Tools given to workers; defaults to none. */
  workerTools?: ToolSpec[];
  /** Tools given to the orchestrator. */
  orchestratorTools?: ToolSpec[];
}

export interface OpenSessionRequest {
  name: string;
  cwd: string;
  purpose?: string;
  model?: string;
  /** First instruction, delivered as the session's first turn. */
  task?: string;
  /** Use the orchestrator tool set instead of the worker set. */
  role?: 'worker' | 'orchestrator';
}

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

/**
 * The supervisor owns every managed session.
 *
 * It is the only component that may raise decisions, route human answers, and
 * decide what the main conversation sees. Adapters run agents; they do not
 * know about each other.
 */
export class Supervisor {
  readonly #adapter: AgentAdapter;
  readonly #store: StateStore;
  readonly #workerTools: ToolSpec[];
  readonly #orchestratorTools: ToolSpec[];  readonly bus = new EventBus();
  readonly decisions = new DecisionQueue();

  readonly #sessions = new Map<SessionId, ManagedSession>();
  #saveChain: Promise<void> = Promise.resolve();
  #seq = 0;

  constructor(config: SupervisorConfig) {
    this.#adapter = config.adapter;
    this.#store = config.store;
    this.#workerTools = [...(config.workerTools ?? [])];
    this.#orchestratorTools = [...(config.orchestratorTools ?? [])];
    // Persist events as they happen; failures only cost observability.
    this.bus.addSink((event, seq) => {
      void this.#store.appendEvent(seq, event).catch(() => undefined);
    });
  }

  /**
   * Register a tool after construction. Tools close over the supervisor, so
   * they cannot be passed to the constructor that creates it.
   */
  registerTool(tool: ToolSpec): void {
    const target = tool.audience === 'worker' ? this.#workerTools : this.#orchestratorTools;
    if (target.some((existing) => existing.name === tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    target.push(tool);
  }

  /**
   * Load persisted sessions. Sessions that were running are not restarted:
   * their transcripts stay on disk and are resumed on demand. Decisions that
   * were pending cannot be answered by a dead process, so they load expired.
   */
  async restore(): Promise<void> {
    const state = await this.#store.load();
    this.#seq = await this.#store.lastSeq();
    this.decisions.seedExpired(
      state.pendingDecisions.map((pending) => ({
        id: pending.id as never,
        sessionId: pending.sessionId as never,
        sessionName: pending.sessionName,
        kind: pending.kind,
        payload: { kind: pending.kind } as never,
        summary: pending.summary,
        createdAt: pending.createdAt,
      })),
    );
    for (const session of state.sessions) {
      this.#sessions.set(asSessionId(session.id), {
        id: asSessionId(session.id),
        name: session.name,
        adapter: session.adapter,
        cwd: session.cwd,
        purpose: session.purpose,
        model: session.model,
        role: session.role ?? 'worker',
        nativeSessionId: session.nativeSessionId,
        // A stopped session stays stopped but remains addressable: sending it
        // a message resumes its native conversation instead of losing it.
        state: session.state === 'stopped' ? 'stopped' : 'idle',
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        runtime: null,
      });
    }
  }

  listSessions(): SessionView[] {
    return [...this.#sessions.values()]
      .map(({ runtime: _runtime, ...view }) => view)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getSession(id: SessionId): SessionView | undefined {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    const { runtime: _runtime, ...view } = session;
    return view;
  }

  findByName(name: string): SessionView | undefined {
    const matches = [...this.#sessions.values()].filter((s) => s.name === name);
    // Prefer a live session; a stopped one is still addressable, because
    // sending to it resumes its native conversation.
    const session = matches.find((s) => s.state !== 'stopped') ?? matches.at(-1);
    if (!session) return undefined;
    const { runtime: _runtime, ...view } = session;
    return view;
  }

  /** Start a session, optionally sending its first instruction. */
  async openSession(request: OpenSessionRequest): Promise<SessionView> {
    const live = [...this.#sessions.values()].find(
      (s) => s.name === request.name && s.state !== 'stopped',
    );
    if (live) {
      throw new Error(`A live session named "${request.name}" already exists`);
    }
    const id = asSessionId(crypto.randomUUID());
    const now = new Date().toISOString();
    const managed: ManagedSession = {
      id,
      name: request.name,
      adapter: this.#adapter.kind,
      cwd: request.cwd,
      purpose: request.purpose,
      model: request.model,
      role: request.role ?? 'worker',
      state: 'starting',
      createdAt: now,
      updatedAt: now,
      runtime: null,
    };
    this.#sessions.set(id, managed);
    this.#emit(id, { type: 'state', state: 'starting', detail: request.role ?? 'worker' });
    await this.#startRuntime(managed);
    if (request.task?.trim()) await this.send(id, request.task);
    return this.#view(managed);
  }

  /** Send a message to a session, starting its runtime again if it stopped. */
  async send(id: SessionId, text: string): Promise<void> {
    const managed = this.#require(id);
    if (!managed.runtime) await this.#startRuntime(managed);
    const runtime = managed.runtime;
    if (!runtime) throw new Error(`Session ${managed.name} has no runtime`);
    this.#setState(managed, 'working');
    await runtime.send(text);
  }

  async interrupt(id: SessionId): Promise<void> {
    await this.#require(id).runtime?.interrupt();
  }

  async stop(id: SessionId): Promise<void> {
    const managed = this.#require(id);
    this.decisions.cancelForSession(id, 'Session stopped by the operator');
    await managed.runtime?.stop();
    managed.runtime = null;
    this.#setState(managed, 'stopped');
    await this.#persist();
  }

  /** Resolve a pending decision. Only a person-facing layer may call this. */
  answerDecision(
    id: Parameters<DecisionQueue['answer']>[0],
    answer: Parameters<DecisionQueue['answer']>[1],
  ) {
    const decision = this.decisions.answer(id, answer);
    this.#publish({
      type: 'decision',
      sessionId: decision.sessionId,
      at: new Date().toISOString(),
      decisionId: decision.id,
      phase: 'settled',
    });
    return decision;
  }

  async readEvents(afterSeq: number, limit = 500): Promise<LoggedEvent[]> {
    return this.#store.readEvents(afterSeq, limit);
  }

  async sessionEvents(id: SessionId, limit = 50): Promise<SessionEvent[]> {
    const all = await this.#store.readEvents(0, 100_000);
    return all
      .map((e) => e.event)
      .filter((e) => e.sessionId === id)
      .slice(-limit);
  }

  /** Shut everything down; used on process exit. */
  async close(): Promise<void> {
    for (const managed of this.#sessions.values()) {
      if (!managed.runtime) continue;
      this.decisions.cancelForSession(managed.id, 'Supervisor shut down');
      await managed.runtime.stop().catch(() => undefined);
      managed.runtime = null;
    }
    await this.#persist();
  }

  async #startRuntime(managed: ManagedSession): Promise<void> {
    const host = this.#makeHost(managed);
    managed.runtime = await this.#adapter.start(
      {
        id: managed.id,
        name: managed.name,
        cwd: managed.cwd,
        purpose: managed.purpose,
        model: managed.model,
      },
      host,
      {
        // The orchestrator both coordinates sessions and talks to the person,
        // so it gets the worker tools (ask_human, report) plus its own.
        tools:
          managed.role === 'orchestrator'
            ? [...this.#orchestratorTools, ...this.#workerTools]
            : this.#workerTools,
        resumeNativeId: managed.nativeSessionId,
      },
    );
    this.#setState(managed, 'idle');
  }

  #makeHost(managed: ManagedSession): AgentHost {
    return {
      raise: async (interaction) => {
        const { decision, answer } = this.decisions.raise(
          managed.id,
          managed.name,
          interaction,
        );
        this.#setState(managed, 'waiting');
        this.#emit(managed.id, {
          type: 'decision',
          decisionId: decision.id,
          phase: 'raised',
        });
        try {
          return await answer;
        } finally {
          // The agent resumes as soon as the answer arrives; the turn is still
          // in flight until the adapter reports its end.
          if (managed.state === 'waiting') this.#setState(managed, 'working');
        }
      },
      emit: (event: AgentEvent) => {
        // While a session waits on a person, adapter chatter must not flip it
        // back to working. A turn end is the one exception: the blocked call
        // has settled, so the session is idle again.
        if (
          event.type === 'state' &&
          managed.state === 'waiting' &&
          event.state !== 'stopped' &&
          event.state !== 'idle'
        ) {
          return;
        }
        this.#emit(managed.id, event);
        if (event.type === 'state') this.#setState(managed, event.state, event.detail);
      },
      setNativeSessionId: (nativeSessionId) => {
        managed.nativeSessionId = nativeSessionId;
        void this.#persist();
      },
    };
  }

  #emit(id: SessionId, event: AgentEvent): void {
    this.#publish({ ...event, sessionId: id, at: new Date().toISOString() } as SessionEvent);
  }

  /** Assign the next log position and fan the event out under that id. */
  #publish(event: SessionEvent): void {
    this.#seq += 1;
    this.bus.publish(event, this.#seq);
  }

  #setState(
    managed: ManagedSession,
    state: SessionView['state'],
    detail?: string,
  ): void {
    if (managed.state === state) return;
    managed.state = state;
    managed.updatedAt = new Date().toISOString();
    this.#emit(managed.id, { type: 'state', state, detail });
    void this.#persist();
  }

  #require(id: SessionId): ManagedSession {
    const managed = this.#sessions.get(id);
    if (!managed) throw new Error(`Unknown session ${id}`);
    return managed;
  }

  #view(managed: ManagedSession): SessionView {
    const { runtime: _runtime, ...view } = managed;
    return view;
  }

  /**
   * Write a last-writer-wins snapshot. Writes are chained so they land in
   * order; a failed write only costs the next save a chance to fix it.
   */
  #persist(): Promise<void> {
    const snapshot: PersistedState = {
      sessions: [...this.#sessions.values()].map((s) => ({
        id: s.id,
        name: s.name,
        adapter: s.adapter,
        cwd: s.cwd,
        purpose: s.purpose,
        model: s.model,
        role: s.role,
        nativeSessionId: s.nativeSessionId,
        state: s.state === 'stopped' ? 'stopped' : 'idle',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
      pendingDecisions: this.decisions.list({ status: 'pending' }).map((d) => ({
        id: d.id,
        sessionId: d.sessionId,
        sessionName: d.sessionName,
        kind: d.kind,
        summary: d.summary,
        createdAt: d.createdAt,
      })),
    };
    this.#saveChain = this.#saveChain
      .then(() => this.#store.save(snapshot))
      .catch(() => undefined);
    return this.#saveChain;
  }
}

interface ManagedSession extends SessionView {
  runtime: AgentSession | null;
}
