import { z } from 'zod';
import type { DecisionId, SessionId } from './ids.ts';

/**
 * The kinds of human decisions the supervisor must collect.
 *
 * Everything here blocks the agent that asked. The supervisor's job is to
 * queue it, present it once, and return the human's answer.
 */
export const interactionKindSchema = z.enum([
  /** A tool call the agent cannot run without an approval. */
  'permission',
  /** The agent asked the human a structured question. */
  'question',
  /** The agent finished planning and asks to leave plan mode. */
  'plan',
]);

export type InteractionKind = z.infer<typeof interactionKindSchema>;

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** A tool call awaiting an allow/deny decision. */
export interface PermissionPayload {
  toolName: string;
  input: Record<string, unknown>;
  /** Rendered prompt sentence from the agent runtime, when available. */
  title?: string;
  /** Short label for the action, e.g. "Run command". */
  displayName?: string;
  description?: string;
  /** Why the runtime asked, when it can say. */
  decisionReason?: string;
  blockedPath?: string;
}

/** A structured question awaiting answers. */
export interface QuestionPayload {
  questions: Question[];
}

/** A plan awaiting approval. */
export interface PlanPayload {
  /** Markdown plan text. */
  plan: string;
}

export type InteractionPayload =
  | ({ kind: 'permission' } & PermissionPayload)
  | ({ kind: 'question' } & QuestionPayload)
  | ({ kind: 'plan' } & PlanPayload);

export const decisionStatusSchema = z.enum([
  'pending',
  'answered',
  'cancelled',
  'expired',
]);

export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

/** One queued human decision. */
export interface Decision {
  id: DecisionId;
  sessionId: SessionId;
  /** Denormalized so a presentation layer need not fetch the session. */
  sessionName: string;
  kind: InteractionKind;
  payload: InteractionPayload;
  /** One line a person can read without opening the payload. */
  summary: string;
  status: DecisionStatus;
  createdAt: string;
  settledAt?: string;
  answer?: DecisionAnswer;
  /** Set when the runtime withdrew the request (turn ended, session stopped). */
  cancelledReason?: string;
}

/** An answer to a queued decision. The shape must match the decision kind. */
export type DecisionAnswer =
  | {
      kind: 'permission';
      behavior: 'allow' | 'deny';
      /** Required when denying; shown to the agent. */
      message?: string;
      /** Replacement tool input, when the human edited the call. */
      updatedInput?: Record<string, unknown>;
    }
  | {
      kind: 'question';
      /** Answers keyed by question text; multi-select answers joined by ", ". */
      answers: Record<string, string>;
    }
  | {
      kind: 'plan';
      behavior: 'allow' | 'deny';
      message?: string;
    };

export const decisionAnswerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('permission'),
    behavior: z.enum(['allow', 'deny']),
    message: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal('question'),
    answers: z.record(z.string(), z.string()),
  }),
  z.object({
    kind: z.literal('plan'),
    behavior: z.enum(['allow', 'deny']),
    message: z.string().optional(),
  }),
]);

/** Validate that an answer matches the kind of the decision it answers. */
export function answerMatchesKind(
  kind: InteractionKind,
  answer: DecisionAnswer,
): boolean {
  return kind === answer.kind;
}
