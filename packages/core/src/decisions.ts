import { randomUUID } from 'node:crypto';
import {
  type Decision,
  type DecisionAnswer,
  type DecisionId,
  type InteractionPayload,
  type SessionId,
  answerMatchesKind,
  asDecisionId,
} from '@supervisor/protocol';

interface Waiter {
  resolve: (answer: DecisionAnswer) => void;
  reject: (error: Error) => void;
}

export class DecisionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionRejectedError';
  }
}

/**
 * The queue of human decisions.
 *
 * One entry is created for every human-decision point an agent hits. The agent
 * is suspended on the promise returned by `raise` until a person answers
 * through a presentation. Nothing else in the system may resolve it, so a
 * blocked agent can never be unblocked by another agent.
 */
export class DecisionQueue {
  readonly #decisions = new Map<DecisionId, Decision>();
  readonly #waiters = new Map<DecisionId, Waiter>();

  raise(
    sessionId: SessionId,
    sessionName: string,
    interaction: InteractionPayload,
  ): { decision: Decision; answer: Promise<DecisionAnswer> } {
    const id = asDecisionId(randomUUID());
    const now = new Date().toISOString();
    const decision: Decision = {
      id,
      sessionId,
      sessionName,
      kind: interaction.kind,
      payload: interaction,
      summary: summarize(interaction),
      status: 'pending',
      createdAt: now,
    };
    this.#decisions.set(id, decision);

    const answer = new Promise<DecisionAnswer>((resolve, reject) => {
      this.#waiters.set(id, { resolve, reject });
    });
    return { decision, answer };
  }

  answer(id: DecisionId, answer: DecisionAnswer): Decision {
    const decision = this.#require(id);
    if (decision.status !== 'pending') {
      throw new Error(`Decision ${id} is ${decision.status}, not pending`);
    }
    if (!answerMatchesKind(decision.kind, answer)) {
      throw new Error(
        `Answer kind "${answer.kind}" does not match decision kind "${decision.kind}"`,
      );
    }
    const waiter = this.#waiters.get(id);
    if (!waiter) {
      throw new Error(`Decision ${id} has no live waiter (supervisor restarted?)`);
    }
    this.#waiters.delete(id);
    decision.status = 'answered';
    decision.answer = answer;
    decision.settledAt = new Date().toISOString();
    waiter.resolve(answer);
    return decision;
  }

  cancel(id: DecisionId, reason: string): void {
    const decision = this.#require(id);
    if (decision.status !== 'pending') return;
    decision.status = 'cancelled';
    decision.cancelledReason = reason;
    decision.settledAt = new Date().toISOString();
    const waiter = this.#waiters.get(id);
    this.#waiters.delete(id);
    waiter?.reject(new DecisionRejectedError(reason));
  }

  /** Withdraw every decision of a session, e.g. when it stops. */
  cancelForSession(sessionId: SessionId, reason: string): void {
    for (const decision of this.#decisions.values()) {
      if (decision.sessionId === sessionId && decision.status === 'pending') {
        this.cancel(decision.id, reason);
      }
    }
  }

  get(id: DecisionId): Decision | undefined {
    return this.#decisions.get(id);
  }

  list(filter: { status?: Decision['status'] } = {}): Decision[] {
    const all = [...this.#decisions.values()];
    const filtered = filter.status
      ? all.filter((d) => d.status === filter.status)
      : all;
    return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Restore decisions queued before a restart. Their waiters are gone. */
  seedExpired(pending: Array<Omit<Decision, 'status'>>): void {
    for (const decision of pending) {
      this.#decisions.set(decision.id, {
        ...decision,
        status: 'expired',
        cancelledReason: 'Supervisor restarted while the agent was blocked',
      } as Decision);
    }
  }

  #require(id: DecisionId): Decision {
    const decision = this.#decisions.get(id);
    if (!decision) throw new Error(`Unknown decision ${id}`);
    return decision;
  }
}

/** One readable line, so the list view needs no payload inspection. */
export function summarize(interaction: InteractionPayload): string {
  switch (interaction.kind) {
    case 'permission': {
      const what =
        interaction.title ??
        interaction.displayName ??
        interaction.toolName;
      return `${what}`;
    }
    case 'question':
      return interaction.questions[0]?.question ?? 'Question';
    case 'plan': {
      const firstLine = interaction.plan.split('\n').find((l) => l.trim());
      return firstLine ? `Plan: ${firstLine.replace(/^#+\s*/, '')}` : 'Plan approval';
    }
  }
}
