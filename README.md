# Agent Supervisor

A supervisor that runs several coding agents (Claude Code first) and funnels
every decision that belongs to a person into one queue.

**Core invariant:** an agent that reaches a human-decision point *blocks*.
It does not guess, and no other agent may answer for the person. The
supervisor collects those blocked points and presents them, one person at a
time, then lets the work continue.

```
      person
        │  answers
        ▼
 ┌──────────────┐   decisions    ┌────────────────────┐
 │ presentation │ ◀────────────▶ │     supervisor     │
 │ CLI / web/IM │                │ sessions + queue   │
 └──────────────┘                └─────────┬──────────┘
                                           │ adapter port
                             ┌─────────────┼─────────────┐
                             ▼             ▼             ▼
                       claude-code     (codex)      (copilot)
                        worker A        worker B      worker C
```

## Quickstart

```bash
pnpm install

# 1. Start the supervisor (also creates the orchestrator conversation)
pnpm sv up --port 4700 --root /path/to/project

# 2. See what exists
pnpm sv status

# 3. Talk to the main conversation; it opens workers and routes work
#    (the media layer can be the CLI today, a web panel or IM gateway later)
pnpm sv say main "Split this into architect and backend work and start both."

# 4. Work the decision inbox
pnpm sv decisions list
pnpm sv decisions show <id>
pnpm sv decisions allow <id>           # permissions and plans
pnpm sv decisions deny <id> -m "why"
pnpm sv decisions answer <id> "blue"   # questions

# 5. Follow the stream
pnpm sv watch --only-waiting
```

The supervisor itself is another agent session: point any Claude Code
session at it and it can drive the same commands (`--json` for machines).

## Packages

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `packages/protocol` | Wire types: sessions, decisions, events. No behaviour. | — |
| `packages/core` | Orchestration: `Supervisor`, `DecisionQueue`, `EventBus`, tool definitions. Ports only. | protocol |
| `packages/agent-claude` | Claude Code adapter: `canUseTool` → decision queue, worker instructions, supervisor MCP tools. | core, Agent SDK |
| `packages/server` | Composition root, HTTP + SSE presentation boundary, file-backed state. | core, agent-claude |
| `packages/cli` | First presentation: `sv`, a scriptable client of the HTTP API. | protocol |
| `packages/test` | Unit tests (fake adapter) and opt-in e2e (`SUPERVISOR_E2E=1`). | all |

Dependencies point one way. `core` never imports an agent SDK; adapters never
import the server; presentations only speak HTTP.

## Why the design looks like this

- **Ports and adapters (hexagonal).** The supervisor knows sessions and
  decisions, not CLIs. A second agent CLI is a new `AgentAdapter`; a web panel
  or IM gateway is a new HTTP client.
- **The runtime enforces the invariant.** Claude Code's `canUseTool` callback
  has no timeout and receives tool approvals, `AskUserQuestion` and
  `ExitPlanMode`. Blocking is native, not emulated with polling.
- **One writer per fact.** Only the supervisor changes session state and
  resolves decisions. Adapters cannot un-wait a session; presentations cannot
  answer as an agent.
- **Structured facts, not paraphrases.** Worker→supervisor communication uses
  typed tool calls (`ask_human`, `report`), so "waiting on a person" is never
  inferred from prose.
- **Native access stays possible.** Each session records the underlying
  agent's session id, so an operator can still attach with
  `claude --resume <id>` or tmux; the supervisor does not trap the transcript.

Read the numbered documents for the reasoning and extension points:

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Architecture](docs/002-architecture.md)
- [003 Extending](docs/003-extending.md)

The philosophy is adapted from the public
[dsh-superagent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype);
this project is not built on DSH.

## Development

```bash
pnpm typecheck
cd packages/test && pnpm test              # unit tests
SUPERVISOR_E2E=1 cd packages/test && pnpm test   # real CLI, costs tokens
```
