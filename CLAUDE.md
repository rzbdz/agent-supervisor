# Working in this repository

Agent Supervisor runs several coding agents and routes every human decision
into one queue. Read `docs/000`–`003` before changing behaviour; they are the
contract.

## Commands

```bash
pnpm install
pnpm typecheck                       # tsc across the workspace
cd packages/test && pnpm test        # unit tests (fake adapter, fast)
SUPERVISOR_E2E=1 cd packages/test && pnpm test   # real Claude Code, costs tokens
pnpm sv up --port 4700 --root /path/to/project   # start the supervisor
pnpm sv status
```

## Rules

- **All code, comments and docs are English.**
- **Dependency direction is one-way:** `protocol ← core ← agent-claude ←
  server ← cli`. `core` must not import an agent SDK. Adapters must not import
  the server. Presentations talk HTTP only.
- **The core invariant:** a decision blocks its agent, and only a person
  answers it. If you add a path that resolves a decision without a human, it
  is a bug, not a feature.
- **Session state has one writer:** `Supervisor`. Adapters report through
  `AgentHost`; they never set state directly.
- **Structured facts over prose.** Worker→supervisor communication is a typed
  tool call (`ask_human`, `report`). Do not parse agent text to infer intent.
- **Keep native surfaces open.** Every session records the underlying agent's
  session id; do not remove that, it is how operators attach with
  `claude --resume` and how restart-resume works.

## When adding to the POC

- A new agent CLI: implement `AgentAdapter`, add a unit test with a fake
  adapter that exercises the block path, and update `docs/003-extending.md`.
- A new presentation: speak the HTTP API in `docs/002-architecture.md`. Do not
  add privileged endpoints for one client.
- A new tool: `ToolSpec` with an explicit `audience`; `autoApprove` only for
  tools that cannot act on the codebase.

State lives in `<root>/.supervisor/` (`state.json`, `events.ndjson`).
