# 003 Extending

## Add an agent CLI (codex, copilot, …)

Implement `AgentAdapter` from `packages/core/src/ports.ts`:

```ts
class CodexAdapter implements AgentAdapter {
  readonly kind = 'codex';
  async start(spec, host, { tools, resumeNativeId }) {
    // 1. spawn the CLI with a way to push turns (stdin, socket, …)
    // 2. call host.setNativeSessionId(id) once you know it
    // 3. for every approval/question the CLI surfaces, await host.raise(...)
    //    and translate the answer back into the CLI's consent format
    // 4. host.emit(...) for text, tool calls, turn ends and state changes
    return { send, interrupt, stop, isRunning };
  }
}
```

Rules the adapter must keep:

- **Never answer a decision itself.** If the CLI has no native blocking point,
  emulate it by holding the call until `host.raise` resolves.
- **Never move a session out of `waiting`.** The supervisor filters it, but a
  correct adapter only reports `idle` at a turn end.
- **Map refusals to refusals.** A cancelled decision must reach the agent as a
  deny, with a readable reason.
- **Record the native id.** It is what makes native attach and restart-resume
  work.

Then register the new kind in the composition root (`packages/server/src/
runtime.ts`). The POC constructs `ClaudeCodeAdapter` directly; a registry is
the natural next refactor.

## Add a presentation (web panel, IM gateway, tmux, …)

Presentations are HTTP clients. Reuse `SupervisorClient` from `packages/cli`
or speak the endpoints in [002 Architecture](002-architecture.md) directly.

- Read `GET /api/state`, follow `GET /api/events`.
- Answer with `POST /api/decisions/:id/answer`; the answer body's `kind` must
  match the decision's kind (the server rejects mismatches).
- Never invent an answer. An IM gateway that cannot collect a human answer
  may only leave the decision pending.

A web panel is expected next: a static `web/` directory served by the server
(`ServeOptions.webRoot`) plus the same API, so it adds no backend surface.

## Add a tool

`ToolSpec` in `packages/core/src/ports.ts`:

- `audience: 'worker'` — available to every worker and the orchestrator.
- `audience: 'orchestrator'` — routing/inspection capability; never given to
  workers.
- `autoApprove: true` — the tool is the supervision channel; the runtime does
  not ask permission to use it. Only use this for tools that cannot act on the
  codebase.

Register with `supervisor.registerTool(tool)`. Tool handlers receive
`ToolContext`, whose `raise` blocks on a person exactly like the runtime's own
decision points.

## Tests

- Unit tests (`packages/test/supervisor.test.ts`) use a fake adapter; add a
  case for every state-machine rule you introduce.
- E2E (`packages/test/e2e.test.ts`) runs against a real CLI and is opt-in:
  `SUPERVISOR_E2E=1 cd packages/test && pnpm test`. It costs tokens; keep it
  to the invariant, not to feature coverage.
