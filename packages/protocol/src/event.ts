import type { DecisionId, SessionId } from './ids.ts';
import type { SessionState } from './session.ts';

/**
 * Events emitted by a session and fanned out to presentations.
 *
 * The adapter translates its own runtime vocabulary into these events, so a
 * presentation never has to know which agent CLI is underneath.
 */
export type SessionEvent =
  | {
      type: 'state';
      sessionId: SessionId;
      at: string;
      state: SessionState;
      detail?: string;
    }
  | {
      type: 'text';
      sessionId: SessionId;
      at: string;
      role: 'assistant' | 'user';
      text: string;
    }
  | {
      type: 'tool';
      sessionId: SessionId;
      at: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      sessionId: SessionId;
      at: string;
      toolName: string;
      toolUseId: string;
      outcome: 'ok' | 'error';
    }
  | {
      type: 'turn';
      sessionId: SessionId;
      at: string;
      phase: 'start' | 'end';
      /** Set on `end`: the agent's final line for the turn. */
      result?: string;
      costUsd?: number;
    }
  | {
      type: 'decision';
      sessionId: SessionId;
      at: string;
      decisionId: DecisionId;
      phase: 'raised' | 'settled';
    }
  | {
      type: 'report';
      sessionId: SessionId;
      at: string;
      status: 'progress' | 'blocked' | 'ready' | 'failed';
      summary: string;
    }
  | {
      /**
       * A worker finished a turn and nobody is waiting on it. The orchestrator
       * consumes this: a router that never learns its workers finished leaves
       * the person to poll, which is exactly the attention cost the framework
       * exists to remove.
       */
      type: 'attention';
      sessionId: SessionId;
      at: string;
      reason: 'idle' | 'blocked' | 'failed';
      /** The agent's own last words for the turn, clipped. */
      summary: string;
    }
  | {
      type: 'error';
      sessionId: SessionId;
      at: string;
      message: string;
    };

export type SessionEventType = SessionEvent['type'];

/**
 * How an adapter reports an event: the supervisor stamps the session id and
 * the timestamp, so adapters cannot forge them.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type AgentEvent = DistributiveOmit<SessionEvent, 'sessionId' | 'at'>;
