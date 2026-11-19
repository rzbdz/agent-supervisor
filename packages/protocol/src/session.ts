import { z } from 'zod';
import type { DecisionId, SessionId, WorkspaceId } from './ids.ts';

/**
 * Lifecycle of a managed agent session, as the supervisor sees it.
 *
 * - `starting` — the adapter has been asked to spawn the agent but has not
 *   reported readiness yet.
 * - `idle` — the agent finished its turn and waits for input.
 * - `working` — the agent is running a turn.
 * - `waiting` — the agent is blocked on a human decision (the central
 *   invariant of this framework: such work must never proceed unattended).
 * - `stopped` — the session ended, either by request or by failure.
 */
export const sessionStateSchema = z.enum([
  'starting',
  'idle',
  'working',
  'waiting',
  'stopped',
]);

export type SessionState = z.infer<typeof sessionStateSchema>;

/** Public description of a session. */
export interface SessionInfo {
  id: SessionId;
  /** Human-facing short name, unique among live sessions. */
  name: string;
  /** Adapter kind that runs this session, e.g. `claude-code`. */
  adapter: string;
  /** Working directory the agent operates on. */
  cwd: string;
  state: SessionState;
  /**
   * Native session id of the underlying agent CLI, when it has one.
   * Kept so an operator can attach with the agent's own tooling
   * (`claude --resume <nativeSessionId>`) and so the session survives a
   * supervisor restart.
   */
  nativeSessionId?: string;
  /** One-line description of what the session is for. */
  purpose?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

/** What the supervisor needs to start one agent session. */
export interface SpawnSpec {
  id: SessionId;
  name: string;
  /** Absolute working directory the agent works in. */
  cwd: string;
  /** One-line role description, given to the agent in its instructions. */
  purpose?: string;
  /** Model alias or id, adapter-defined. */
  model?: string;
  /** Workspace this session belongs to, when grouped. */
  workspaceId?: WorkspaceId;
  /** Organization role of this agent, e.g. architect / backend / frontend. */
  role?: string;
  /** Extra adapter-specific settings (adapter validates them). */
  options?: Record<string, unknown>;
}

/**
 * A workspace groups the agents working on one project.
 *
 * It mirrors the host's own workspace notion (DSH's `workspaceRegistry`,
 * an editor's project root): a directory plus the agents that work in it.
 * The supervisor keeps its own record so the same grouping exists on every
 * presentation, including ones that have no host workspace concept.
 */
export interface Workspace {
  id: WorkspaceId;
  name: string;
  /** Absolute directory the workspace's agents work in. */
  root: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/** What the supervisor needs to register a workspace. */
export interface WorkspaceSpec {
  name: string;
  root: string;
  description?: string;
  /** Register an existing id instead of minting one (used on restore). */
  id?: WorkspaceId;
}

/**
 * The identity of an agent, as the three facts that must stay together:
 * the native session it runs, the project it belongs to, and its role.
 */
export interface AgentIdentity {
  nativeSessionId: string;
  workspaceId: WorkspaceId;
  role: string;
}
