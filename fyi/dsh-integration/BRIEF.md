# Task: DSH frontend integration + supervisor control surface

## What we are building

A DSH (DeepSeek Harness) plugin that makes the supervisor usable from the DSH
web shell, plus the supervisor-side API that plugin drives. Two deliverables,
one feature.

### 1. Supervisor side: a control surface for the framework

The supervisor already owns sessions and a blocking decision queue. Add the
API a host UI needs so a DSH plugin can drive agents through it:

- a **workspace** record mirroring DSH's `workspaceRegistry` (directory plus
  the agents grouped under it) — `packages/core` already has this
- a **split-pane payload**: for one workspace, the list of its sessions
  (name, role, state, native session id, searchable) and, for the selected
  one, what a remote terminal pane needs
- an **agent attach** capability: given a session, how a host opens its
  native CLI (first version: a tmux window, standard tmux config, attached to
  the agent's working directory). Keep it behind a port so relay / remote
  ssh can be added later without touching the core.
- everything rides the existing HTTP/SSE API; no privileged side doors

### 2. DSH side: a plugin for the web shell

A Cordis plugin package (`dsh-supervisor`) in DSH's own plugin format:

- host half: mounts under `ctx.webServer` routes (see
  `@deepseek-ai/dsh-host-webserver`), proxies the supervisor HTTP API through
  same-origin `/dsh-supervisor/*` endpoints so the browser needs no CORS
  exception
- client half: `dsh.client` entry; a **main panel** registered into the
  layout `main` keyed slot (see `@deepseek-ai/dsh-client-ui-layout`), opened
  through `ctx.layout.selectPanel(id)`
- the panel is the split view from the design image: left = workspace session
  list with search, right = a labelled remote tmux window for the selected
  agent (xterm.js or an equivalent terminal renderer, websocket-backed)
- standard tmux configuration shipped with the plugin

## Ground truth already established (read, do not re-derive)

- DSH web runs at `http://127.0.0.1:3080` (auth: the startup URL carries a
  process token; `/api` is fenced by host/origin checks)
- DSH plugin reference implementation on this machine:
  `/root/workspace/dsh-test/dsh-cnstock-widget` — read `lib/entry.js` and
  `lib/client.js`, and its `package.json` `dsh.client` block
- DSH packages live under
  `/root/.nvm/versions/node/v24.13.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
  (READMEs there are the contract). Relevant ones:
  `dsh-workspace`, `dsh-client-ui-workspace`, `dsh-client-ui-layout`,
  `dsh-client-ui-slots`, `dsh-host-webserver`, `dsh-api-remotes`,
  `dsh-terminal`, `dsh-tmux-context`, `dsh-web-app`
- Supervisor: `README.md`, `docs/000..003`, `CLAUDE.md`; code in
  `packages/`; the API is in `packages/server/src/http.ts`
- The supervisor instance for this workspace is `http://127.0.0.1:4720`

## Constraints

- Modular: the terminal transport (tmux now; relay / ssh later) and the
  session source must each be a port, not inline logic
- All code, comments and docs in English
- Do not enable `bypassPermissions`, and do not weaken the decision-queue
  invariant: an agent blocked on a human stays blocked
- Test what you build; unit tests for logic, and a documented manual check
  for the DSH panel

## Reporting

Report through `report` with a one-line summary. Ask the human through
`ask_human` when a decision is theirs (scope, taste, API shape you cannot
settle from the contracts above). Do not narrate progress.
