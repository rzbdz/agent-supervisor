import { z } from 'zod';
import type { DecisionId, SessionId } from './ids.ts';

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
  /** Extra adapter-specific settings (adapter validates them). */
  options?: Record<string, unknown>;
}
