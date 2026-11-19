import type {
  AgentEvent,
  SessionEvent,
  SessionId,
  Workspace,
  WorkspaceId,
} from '@supervisor/protocol';
import { asSessionId, asWorkspaceId } from '@supervisor/protocol';
import type {
  AgentAdapter,
  AgentHost,
  AgentSession,
  LoggedEvent,
  PermissionMode,
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
  /** Workspace the session belongs to. Defaults to the workspace at `cwd`. */
  workspaceId?: WorkspaceId;
  /** Organization role within the workspace, e.g. architect / backend. */
  agentRole?: string;
  /** Runtime autonomy; `auto` (the default) keeps routine actions quiet. */
  permissionMode?: PermissionMode;
}

export interface SessionView {
  id: SessionId;
  name: string;
  adapter: string;
  cwd: string;
  purpose?: string;
  model?: string;
  role: 'worker' | 'orchestrator';
  /** Organization role within its workspace, when set. */
  agentRole?: string;
  /** Runtime autonomy for this session. */
  permissionMode: PermissionMode;
  workspaceId?: WorkspaceId;
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
  /** Each session's most recent turn result, for attention summaries. */
  readonly #lastWords = new Map<SessionId, string>();
  readonly #workspaces = new Map<WorkspaceId, Workspace>();
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
    for (const workspace of state.workspaces ?? []) {
      this.#workspaces.set(asWorkspaceId(workspace.id), {
        id: asWorkspaceId(workspace.id),
        name: workspace.name,
        root: workspace.root,
        description: workspace.description,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      });
    }
    for (const session of state.sessions) {
      this.#sessions.set(asSessionId(session.id), {
        id: asSessionId(session.id),
        name: session.name,
        adapter: session.adapter,
        cwd: session.cwd,
        purpose: session.purpose,
        model: session.model,
        role: session.role ?? 'worker',
        agentRole: session.agentRole,
        workspaceId: session.workspaceId ? asWorkspaceId(session.workspaceId) : undefined,
        permissionMode: session.permissionMode ?? 'auto',
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

  /** Register or update a workspace. Re-registering a root is idempotent. */
  async registerWorkspace(spec: {
    name: string;
    root: string;
    description?: string;
    id?: WorkspaceId;
  }): Promise<Workspace> {
    const existing = [...this.#workspaces.values()].find((w) => w.root === spec.root);
    if (existing) return existing;
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: spec.id ?? asWorkspaceId(crypto.randomUUID()),
      name: spec.name,
      root: spec.root,
      description: spec.description,
      createdAt: now,
      updatedAt: now,
    };
    this.#workspaces.set(workspace.id, workspace);
    await this.#persist();
    return workspace;
  }

  listWorkspaces(): Workspace[] {
    return [...this.#workspaces.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  getWorkspace(id: WorkspaceId): Workspace | undefined {
    return this.#workspaces.get(id);
  }

  /** The sessions grouped under a workspace, in creation order. */
  workspaceSessions(id: WorkspaceId): SessionView[] {
    return this.listSessions().filter((s) => s.workspaceId === id);
  }

  /** Create a session, optionally sending its first instruction. */
  async openSession(request: OpenSessionRequest): Promise<SessionView> {
    const live = [...this.#sessions.values()].find(
      (s) => s.name === request.name && s.state !== 'stopped',
    );
    if (live) {
      throw new Error(`A live session named "${request.name}" already exists`);
    }
    const id = asSessionId(crypto.randomUUID());
    const now = new Date().toISOString();
    const workspaceId =
      request.workspaceId ??
      [...this.#workspaces.values()].find(
        (w) => w.root === request.cwd || request.cwd.startsWith(`${w.root}/`),
      )?.id;
    const managed: ManagedSession = {
      id,
      name: request.name,
      adapter: this.#adapter.kind,
      cwd: request.cwd,
      purpose: request.purpose,
      model: request.model,
      role: request.role ?? 'worker',
      agentRole: request.agentRole,
      workspaceId,
      permissionMode: request.permissionMode ?? 'auto',
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

  /** Change a live session's autonomy without restarting it. */
  /**
   * Change a session's autonomy, live or not.
   *
   * `plan` and `auto` are the two modes an operator switches between: plan
   * makes the agent propose before acting, auto lets routine work proceed and
   * escalates only what the classifier cannot judge. A stopped session keeps
   * the new mode for its next resume; the mode is part of the session record,
   * not of the process.
   */
  async setPermissionMode(id: SessionId, mode: PermissionMode): Promise<void> {
    const managed = this.#require(id);
    if (managed.permissionMode === mode) return;
    managed.permissionMode = mode;
    managed.updatedAt = new Date().toISOString();
    await managed.runtime?.setPermissionMode?.(mode);
    // A live runtime reports the change; a stopped one needs the event here.
    if (!managed.runtime) {
      this.#emit(managed.id, {
        type: 'state',
        state: managed.state,
        detail: `permission mode ${mode}`,
      });
    }
    await this.#persist();
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

  /**
   * Workers that settled recently, newest first.
   *
   * The orchestrator asks this instead of polling sessions: an attention event
   * is the supervisor's statement that a worker finished and a person has not
   * been asked anything since.
   */
  async recentAttention(limit = 20): Promise<
    Array<{ session: string; at: string; reason: string; summary: string }>
  > {
    const all = await this.#store.readEvents(0, 100_000);
    const byName = new Map(
      this.listSessions().map((s) => [s.id as string, s.name] as const),
    );
    return all
      .map((e) => e.event)
      .filter((e): e is Extract<SessionEvent, { type: 'attention' }> => e.type === 'attention')
      .slice(-limit)
      .reverse()
      .map((e) => ({
        session: byName.get(e.sessionId) ?? e.sessionId,
        at: e.at,
        reason: e.reason,
        summary: e.summary,
      }));
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
    const workspace = managed.workspaceId
      ? this.#workspaces.get(managed.workspaceId)
      : undefined;
    managed.runtime = await this.#adapter.start(
      {
        id: managed.id,
        name: managed.name,
        cwd: managed.cwd,
        purpose: managed.purpose,
        model: managed.model,
        workspaceId: managed.workspaceId,
        role: managed.agentRole,
        permissionMode: managed.permissionMode,
        options: workspace ? { workspaceRoot: workspace.root } : undefined,
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
        if (event.type === 'turn' && event.phase === 'end' && event.result) {
          this.#lastWords.set(managed.id, event.result);
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
    const previous = managed.state;
    managed.state = state;
    managed.updatedAt = new Date().toISOString();
    this.#emit(managed.id, { type: 'state', state, detail });
    // A worker that settled is the orchestrator's business: it must be able to
    // react without the person polling. Orchestrators and interrupted turns
    // (working -> idle after a decision) are not attention events.
    const settled = state === 'idle' && previous === 'working';
    if (
      settled &&
      managed.role === 'worker' &&
      this.decisions.list({ status: 'pending' }).every((d) => d.sessionId !== managed.id)
    ) {
      this.#emit(managed.id, {
        type: 'attention',
        reason: 'idle',
        summary: (this.#lastWords.get(managed.id) ?? '').slice(0, 600),
      });
    }
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
      workspaces: [...this.#workspaces.values()].map((w) => ({
        id: w.id,
        name: w.name,
        root: w.root,
        description: w.description,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      })),
      sessions: [...this.#sessions.values()].map((s) => ({
        id: s.id,
        name: s.name,
        adapter: s.adapter,
        cwd: s.cwd,
        purpose: s.purpose,
        model: s.model,
        role: s.role,
        agentRole: s.agentRole,
        workspaceId: s.workspaceId,
        permissionMode: s.permissionMode,
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
