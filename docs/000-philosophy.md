# 000 Philosophy

The framework exists to answer one question well:

**Who is allowed to decide?**

An agent can do the work. It cannot own the judgement. Every point where a
person's taste, scope, risk or approval decides the outcome is a *decision*,
and the agent must stop there.

## What follows

- **Decisions block.** An agent that reaches a decision point waits. It does
  not choose a default, and it does not proceed on an assumption.
- **Only a person answers.** Another agent, including the orchestrator, may
  read the queue but never resolve it. The orchestrator routes work; it does
  not consent to it.
- **One place to look.** Every blocked agent appears in one queue. The person
  works that queue; they do not hunt through terminals.
- **Attention is the budget.** A message, a prompt, a status line and a
  question each cost the person attention. Each must return more than it
  costs. This is why:
  - supervisor tools (`ask_human`, `report`) do not themselves prompt;
  - the worker's instructions forbid progress narration;
  - `status` shows first what waits for a person.
- **Stop by impact, not effort.** A local change goes as far as a reviewable
  result. A change that needs a design decision stops with one concrete
  question.
- **Report honestly.** A refusal is reported as a refusal, a failure as a
  failure. A limit is never bypassed to avoid asking.

## What follows for the design

- **Few concepts.** Session, Decision, and the presentation. Adapters and
  presentations are implementations of two ports, not new concepts.
- **The runtime enforces the rule, where it can.** Claude Code's
  `canUseTool` callback blocks without a timeout and sees permissions,
  questions and plan approval. The framework uses that instead of building a
  parallel consent system on top of the agent.
- **Native surfaces remain reachable.** A managed agent keeps its own session
  id and transcript. An operator can attach, inspect, or resume it with the
  agent's own tools. Supervision is additive, not a walled garden.
- **Documents read in order.** Each numbered document assumes only the ones
  before it.

## Responsibility

Each agent acts under a real account and a real working directory. The person
who runs the supervisor owns what the agents do. Start with a narrow scope per
worker, keep approvals explicit, and widen only after the results look right.
