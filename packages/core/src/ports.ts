import type { DecisionAnswer, InteractionPayload, SessionId } from '@supervisor/protocol';
import type { AgentEvent } from '@supervisor/protocol';
import type { SpawnSpec } from '@supervisor/protocol';
import type { ZodRawShape } from 'zod';

/**
 * A neutral tool definition.
 *
 * Core describes tools without importing an agent SDK; an adapter maps these
 * into whatever the runtime needs (for Claude Code, an in-process MCP server).
 * The argument schema is a Zod raw shape, the most portable shape the agent
 * runtimes accept; adapters that need JSON Schema can derive it.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  /**
   * Who may call the tool. Orchestrator-only tools (`open_session`, `route`)
   * are the routing capability; giving them to a worker would let a worker
   * address another worker, bypassing the main conversation.
   */
  audience: 'worker' | 'orchestrator';
  /**
   * Whether the runtime may run this tool without asking the human.
   *
   * Supervisor tools are the supervision channel itself: asking permission to
   * call `ask_human` would make a worker pay two prompts for one question.
   * Every consequential action a worker takes is still a built-in tool call
   * that reaches `canUseTool`, so the approval boundary is unchanged.
   */
  autoApprove?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** What a tool may do on behalf of the session that called it. */
export interface ToolContext {
  sessionId: SessionId;
  sessionName: string;
  /** Block until a person answers. */
  raise(interaction: InteractionPayload): Promise<DecisionAnswer>;
  /** Publish an event for this session. */
  emit(event: AgentEvent): void;
}

/**
 * Callbacks an adapter uses to talk back to the supervisor while it runs one
 * agent session.
 */
export interface AgentHost {
  /**
   * Ask the human for a decision. Resolves only when a person answers or the
   * request is withdrawn. Adapters must call this for every human-decision
   * point and must not proceed until it resolves.
   */
  raise(interaction: InteractionPayload): Promise<DecisionAnswer>;
  /** Publish something the session did. Never awaited by the adapter. */
  emit(event: AgentEvent): void;
  /** The native id of the underlying agent session, once known. */
  setNativeSessionId(nativeSessionId: string): void;
}

/** A running (or resumable) agent session, as seen by the supervisor. */
export interface AgentSession {
  /** Send one user message to the agent. Starts a turn if idle. */
  send(text: string): Promise<void>;
  /** Stop the current turn without ending the session. */
  interrupt(): Promise<void>;
  /** End the session and release its resources. */
  stop(): Promise<void>;
  /** Whether a turn is currently running. */
  isRunning(): boolean;
}

/** Starts agent sessions of one kind. */
export interface AgentAdapter {
  /** Stable adapter id, e.g. `claude-code`. */
  readonly kind: string;
  /**
   * Start a session. `resumeNativeId` resumes a previously persisted agent
   * conversation instead of starting a fresh one.
   */
  start(
    spec: SpawnSpec,
    host: AgentHost,
    extra: { tools: ToolSpec[]; resumeNativeId?: string },
  ): Promise<AgentSession>;
}

/** Durable storage for the supervisor's own state. */
export interface StateStore {
  load(): Promise<PersistedState>;
  save(state: PersistedState): Promise<void>;
  /**
   * Append one event under a caller-assigned sequence number. The supervisor
   * assigns it so the live stream and the log agree on ids.
   */
  appendEvent(seq: number, event: import('@supervisor/protocol').SessionEvent): Promise<void>;
  /** The highest sequence number written, or 0 when the log is empty. */
  lastSeq(): Promise<number>;
  /** Events after `seq`, for replay to a new presentation. */
  readEvents(afterSeq: number, limit: number): Promise<LoggedEvent[]>;
}

export interface LoggedEvent {
  seq: number;
  at: string;
  event: import('@supervisor/protocol').SessionEvent;
}

/**
 * Everything the supervisor keeps across restarts.
 *
 * Deliberately small: sessions are the only aggregate. Decisions are ephemeral
 * by nature — a pending decision whose process died cannot be answered, so it
 * is recorded as expired on load.
 */
export interface PersistedState {
  sessions: PersistedSession[];
  /** Workspaces, when the deployment groups agents into projects. */
  workspaces?: PersistedWorkspace[];
  /** Decisions that were pending when the process stopped. */
  pendingDecisions: PersistedDecision[];
}

export interface PersistedSession {
  id: string;
  name: string;
  adapter: string;
  cwd: string;
  purpose?: string;
  model?: string;
  role?: 'worker' | 'orchestrator';
  /** Organization role within a workspace, e.g. architect. */
  agentRole?: string;
  workspaceId?: string;
  nativeSessionId?: string;
  state: 'idle' | 'stopped';
  createdAt: string;
  updatedAt: string;
}

/** A workspace as it is persisted: a directory plus the agents in it. */
export interface PersistedWorkspace {
  id: string;
  name: string;
  root: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedDecision {
  id: string;
  sessionId: string;
  sessionName: string;
  kind: 'permission' | 'question' | 'plan';
  summary: string;
  createdAt: string;
}
