# Handover — Agent Supervisor POC

Written 2026-11-19 for the next operator model (claude-opus-5-5). Everything here
states what is true at handoff, what is broken, and what to do first. Do not
trust an older summary over this file.

## 1. What this project is

A supervisor that runs several coding agents (Claude Code first) and funnels
every decision that belongs to a person into one queue. The core invariant:
**an agent that reaches a human-decision point blocks, and only a person
answers.** No agent may answer for a person.

Three roles exist:

- **orchestrator** (`main`): the conversation a person talks to. It opens,
  routes and inspects worker sessions. It cannot answer decisions.
- **workers**: sessions that do the work, one per role (architect, backend,
  frontend).
- **presentations**: HTTP clients. A CLI (`sv`), a temporary web panel, and
  (planned) a DSH plugin.

## 2. Current state

| Item | State |
|---|---|
| Repo | `/root/agent-supervisor`, branch `master`, last commit `715ca10`, clean tree |
| Remote | `github.com:rzbdz/agent-supervisor`, push **must** go via `ssh.github.com:443` (port 22 is blocked on this network) |
| Typecheck | clean (`pnpm typecheck`) |
| Unit tests | 13 passing, 1 e2e skipped (`cd packages/test && npx vitest run`) |
| Daemon | running on `0.0.0.0:4720`, root `/root/agent-supervisor` |
| Log | `/tmp/supervisor-daemon.log` |
| State | `/root/agent-supervisor/.supervisor/` (`state.json`, `events.ndjson`) |

Push command that works:

```bash
GIT_SSH_COMMAND='ssh -o BatchMode=yes' git push git@ssh.github.com:rzbdz/agent-supervisor.git master:master
```

## 3. Layout

```
packages/protocol   wire types: Session, Decision, Event, Workspace. No behaviour.
packages/core       Supervisor, DecisionQueue, EventBus, tools. Ports only; imports no agent SDK.
packages/agent-claude  Claude Code adapter: canUseTool -> decision queue; supervisor MCP tools.
packages/server     composition root, HTTP+SSE, FileStore, tmux terminal transport.
packages/cli        `sv` presentation (status / say / mode / decisions / watch).
packages/test       unit tests (fake adapter) + opt-in real-CLI e2e.
web/index.html      temporary web panel (single file; xterm.js vendored in web/vendor).
docs/000..003       philosophy, domain, architecture, extending. Read these.
fyi/dsh-integration/  the DSH integration brief and the architect's DESIGN.md
fyi/attempted-handover.patch  an uncommitted attempt described in §5; not applied
```

Dependency direction is one-way: `protocol <- core <- agent-claude <- server <- cli`.
Core must never import an agent SDK. Adapters must never import the server.

## 4. Working mechanisms (verified)

- **Blocking decisions.** Claude Code's `canUseTool` has no timeout and receives
  tool approvals, `AskUserQuestion` and `ExitPlanMode`. The supervisor maps all
  three onto one queue. Verified end to end against the real CLI.
- **Autonomy.** Workers start in `auto`: a classifier clears routine actions;
  only what it cannot judge escalates. Live switching between `auto` and `plan`
  works over `POST /api/sessions/:id/permission-mode` and `sv mode`.
- **Orchestration.** `main` has `open_session`, `route`, `list_sessions`,
  `list_workspaces`, `open_workspace`, `list_attention`. Workers get only
  `ask_human` and `report`; a worker attempting `route` is a "tool does not
  exist" (verified).
- **Attention relay.** A worker that settles with no pending decision emits an
  `attention` event, which the server coalesces into one message to `main`.
- **Persistence.** Sessions store their native Claude session id; a supervisor
  restart resumes the same conversation (verified).
- **Native transcript.** `GET /api/sessions/:id/attach/transcript` parses
  `~/.claude/projects/<slug>/<id>.jsonl` and returns the agent's own turns.
- **Web panel.** Session list, decision queue, activity feed, xterm.js terminal.

## 5. What is broken, and the honest assessment

The operator's verdict at handoff: **the web UI is not usable, and dogfooding
stopped because of it.** These are the concrete defects, in the operator's
words and with the cause located in code:

1. **A terminal that cannot be typed into.** `POST .../attach` opens a tmux
   window for the session, but `TmuxTransport.open` only sends
   `claude --resume` when `!spec.live` (`packages/server/src/terminal.ts:167`),
   and the server passes `live: session.state !== 'stopped'`
   (`packages/server/src/http.ts:62`). So for any session that is not stopped,
   the window is a bare shell branching into a read-only transcript mirror.
   The operator's expected behavior — *"open Claude and type into it"* — never
   happens. Input bytes do reach tmux (verified), but there is nothing
   interactive on the other end.
2. **State does not follow the terminal.** Opening a terminal does not change
   the session's state. A stopped session still reads `stopped` while a person
   is typing into its resumed CLI.
3. **Everything opens in manual mode.** The terminal resumes Claude without
   `--permission-mode`, so it falls back to prompting for routine actions,
   which contradicts the agreed design (auto by default).
4. **Human and supervisor cannot share a session.** The implemented model is
   exclusive: the supervisor owns the agent process, and the terminal is a
   view. The operator wants concurrent coexistence ("人机并存"): a person types
   in a real terminal while the supervisor can still deliver messages.
   **An attempt at exclusive takeover/release was written and abandoned**
   (operator explicitly rejected it as the wrong shape). It is preserved as
   `fyi/attempted-handover.patch` and was reverted; the tree is clean.

Also true but lower priority:

- Terminal frames are full-screen redraws from `tmux capture-pane -p -e` on a
  ~250 ms interval, not a byte stream. Fine for watching, wrong for an
  interactive terminal.
- The panel is a single HTML file; it is explicitly temporary.

## 6. What to do first

The blocker is #4, and #1–#3 are symptoms of the same design choice. Before
writing code, settle the ownership model, because it determines everything
else:

- A Claude Code process has exactly one owner of its stdin. Two independent
  clients cannot both drive one interactive CLI session.
- Therefore "人机并存" requires either (a) the supervisor never owns an
  interactive process — it sends messages through a mechanism the CLI exposes
  to peers, with the terminal owning the process; or (b) the supervisor owns
  the process and the terminal is a client of the supervisor, not of the CLI.

Direction (a) is closer to what the operator asked for, and there is a native
primitive worth investigating: Claude Code exposes a per-session messaging
socket (`CLAUDE_CODE_MESSAGING_SOCKET`), documented for cross-session
injection, which delivers a message to a running interactive session without
owning its stdin. Verify it before designing around it.

The correct fix for #1–#3, in the same design, is that the tmux window must be
the agent itself (`claude --resume <id>` with the session's autonomy mode),
with state derived from observing the window, not asserted by the supervisor.

Do not re-implement the reverted takeover patch. It answers the wrong
question.

## 7. Rules that must survive

These were agreed with the operator and are not negotiable in a rewrite:

- **All code, comments and docs in English.**
- **Supervise plans, alternatives, scope and architecture direction — not
  routine reads, writes and commands.** Auto handles the routine; the queue is
  for judgement.
- **Only a person answers a decision.** No agent path may resolve one.
- **One writer of session state.** Adapters report; they do not set state.
- **Do not enable `bypassPermissions`.** Do not weaken the block invariant.
- **Do not introduce a tunneling dependency** (the operator explicitly
  refused Tailscale and similar). The daemon binds locally; access is the
  operator's problem.
- **Architecture is front-end/back-end separated and queries are stateless.**
  The web panel and a DSH plugin are both clients of the same API; neither may
  assume it is the only one.

## 8. Running it

```bash
pnpm install
pnpm typecheck
cd packages/test && npx vitest run
pnpm sv up --port 4720 --root /root/agent-supervisor     # daemon
pnpm sv status
pnpm sv mode <session> plan|auto
pnpm sv decisions list
SUPERVISOR_E2E=1 cd packages/test && npx vitest run      # real CLI, costs tokens
```

Restarting the daemon: kill the PID on port 4720, then
`setsid nohup node --import tsx packages/server/src/main.ts --port 4720 --root /root/agent-supervisor --host 0.0.0.0 > /tmp/supervisor-daemon.log 2>&1 &`.
Do not use `pkill -f server/src/main.ts`; it matches the invoking shell and
kills the tool call.

## 9. Pending work beyond the blocker

- `fyi/dsh-integration/DESIGN.md` (architect's output) proposes the supervisor
  control surface, the `dsh-supervisor` plugin layout, a skill as the
  agent-control mechanism, and the terminal transport port. Treat it as a
  proposal; §5 of it was superseded by the terminal work and is now partly
  wrong.
- The DSH integration itself has not been started. A local DSH runs on
  `127.0.0.1:3080`; a reference plugin exists at
  `/root/workspace/dsh-test/dsh-cnstock-widget`.
- Sessions named `architect`, `backend`, `frontend` are stopped; `arch2` holds
  the design work. Their native transcripts are on disk and resumable.
