# 002 Architecture

This document maps [001 Domain model](001-domain.md) onto code.

## Dependencies

```
protocol ◀── core ◀── agent-claude ◀── server ◀── cli
     ▲          ▲                                      │
     └──────────┴──────────────────────────────────────┘

core        knows ports; never imports an agent SDK
adapters    implement AgentAdapter; never import the server
server      composition root + HTTP/SSE presentation boundary
cli         a presentation client; only HTTP
```

The arrow direction is the whole design. `core` can be tested with a fake
adapter (it is), and a second CLI or a web panel needs no change below the
server.

## Core (`packages/core`)

| Module | Owns | Notes |
| --- | --- | --- |
| `ports.ts` | `AgentAdapter`, `AgentSession`, `AgentHost`, `ToolSpec`, `StateStore` | The boundary. `AgentHost.raise` is the block-forever call. |
| `decisions.ts` | `DecisionQueue` | The single place a pending decision is resolved. Validates answer kind. Cancels on stop. |
| `bus.ts` | `EventBus` | Fan-out to the state store and presentations. A broken listener cannot break the supervisor. |
| `supervisor.ts` | `Supervisor` | Session lifecycle, state transitions, persistence. The only writer of session state. |
| `tools.ts` | `workerTools`, `orchestratorTools` | Typed worker→supervisor facts. Orchestrator tools are the routing capability. |

### The block path

```
adapter (canUseTool) ──▶ AgentHost.raise ──▶ DecisionQueue.raise
                                              │  promise stays open
presentation ──▶ POST /api/decisions/:id/answer ──▶ DecisionQueue.answer
                                              │
                       promise resolves ◀───┘
adapter returns allow/deny to the agent runtime
```

`Supervisor` sets `waiting` on raise and `working` when the answer resolves.
The adapter cannot move the session out of `waiting`; `Supervisor.#makeHost`
filters those events.

## Claude Code adapter (`packages/agent-claude`)

- `start()` opens one short-lived Claude Code process with streaming input, so
  the supervisor can push turns into a live session.
- `canUseTool` is the only interception point. It maps `AskUserQuestion` to a
  `question`, `ExitPlanMode` to a `plan`, everything else to `permission`.
- Settings isolation (`settingSources: []`, `strictMcpConfig: true`) stops the
  operator's own hooks and MCP servers from creating prompts the supervisor
  cannot see.
- The `supervisor` MCP server carries `ask_human` and `report`; those two are
  auto-approved so a question costs one prompt, not two.
- The agent's `session_id` is recorded, so `claude --resume <id>` can attach
  to a managed session directly.

## Server (`packages/server`)

`Runtime` is the composition root: it builds the store, the supervisor, the
tools and the HTTP server, in that order, and nothing below it constructs its
own collaborators.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/state` | sessions + all decisions |
| `GET/POST /api/sessions` | list, open |
| `POST /api/sessions/:id/messages` | send a turn |
| `GET /api/sessions/:id/events` | recent events |
| `POST /api/sessions/:id/{interrupt,stop}` | control |
| `GET /api/decisions?status=` | queue |
| `POST /api/decisions/:id/answer` | the human's answer |
| `GET /api/events` | SSE stream, resumable via `Last-Event-ID` |
| `POST /api/admin/shutdown` | daemon shutdown |

SSE rather than WebSocket: the stream is one-way by design, needs no
handshake library, and reconnects with the last sequence number.

## Persistence (`packages/server/src/store.ts`)

- `state.json` — sessions and pending decision summaries. Atomic save
  (write + rename).
- `events.ndjson` — append-only event log for replay. A torn last line is
  skipped on read.

Decisions are not stored as answerable state: after a restart, a pending
decision loads `expired`, because its agent process is gone. The session is
resumed with its native id when the person next sends it a message.

## Known limits of the POC

- One adapter runs at a time (`Supervisor` takes one `AgentAdapter`). A
  registry keyed by adapter kind is the next step.
- Concurrency is unbounded; there is no worker-slot limit.
- A stop cancels the session's pending decisions; the blocked agent call gets a
  refusal, and the session is marked stopped.
