# DSH integration — design

Scope: control surface, plugin layout, agent-driven-control mechanism, terminal
transport port. Additive only; the existing SSE stream and decision queue are
reused unchanged, and an agent blocked on a human stays blocked.

## 1. Supervisor control surface (HTTP/JSON)

New routes live under the existing `/api` tree in `packages/server/src/http.ts`
and pass the same auth (process token, host/origin fence) as every other route.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/workspaces` | list workspace records (`packages/core`) |
| GET | `/api/workspaces/:wsId` | one workspace + agent group |
| GET | `/api/workspaces/:wsId/panes?q=&selected=` | split-pane payload |
| POST | `/api/sessions/:id/attach` | open (or reuse) a native terminal |
| POST | `/api/sessions/:id/attach/resize` | `{cols, rows}` |
| DELETE | `/api/sessions/:id/attach` | close the attach, keep the session |
| GET | `/api/sessions/:id/attach/stream` | SSE: output frames + exit |

Decision traffic keeps the existing decision-queue routes; the plugin renders
and forwards (`ask`, `answer`, `pending`) and never auto-answers. Split-pane
payload (`GET …/panes?q=&selected=`), one round trip for the panel:

```json
{
  "workspace": { "id": "ws_1", "path": "/root/agent-supervisor", "name": "agent-supervisor" },
  "sessions": [
    { "id": "s_42", "name": "arch2", "role": "Architect: DSH integration design",
      "state": "working", "nativeSessionId": "e4f1…", "searchText": "arch2 architect dsh…" }
  ],
  "selected": {
    "sessionId": "s_42",
    "attach": {
      "transport": "tmux", "window": "sup:s_42", "cwd": "/root/agent-supervisor",
      "attachCommand": "tmux -L supervisor -f <plugin>/tmux/tmux.conf attach -t sup:s_42",
      "resizable": true, "cols": 120, "rows": 32
    },
    "pendingDecisions": [ { "id": "d_7", "question": "…", "options": ["…"] } ]
  }
}
```

`POST /attach` is idempotent (same session → same window) and is the only place
the transport port is consulted (§4). The browser never talks to tmux: it opens
the stream route and renders bytes.

## 2. `dsh-supervisor` plugin package layout

Mirror the reference widget `/root/workspace/dsh-test/dsh-cnstock-widget`
(`lib/entry.js`, `lib/client.js`, its `dsh.client` block) mechanically; only the
content is ours.

```
dsh-supervisor/
  package.json          # name, cordis deps, dsh.client block
  lib/entry.js          # host half: ctx.webServer routes under /dsh-supervisor/*
  lib/proxy.js          # same-origin proxy -> http://127.0.0.1:4720/api
  lib/client.js         # client half: layout panel registration + mount
  lib/panel/list.js     # left: workspace session list + search
  lib/panel/term.js     # right: xterm.js bound to the SSE stream
  lib/panel/decisions.js# decision cards (render + forward only)
  tmux/tmux.conf        # shipped standard config, used by attachCommand
  README.md             # install + manual check
```

`package.json` `dsh.client`: same fields as the reference widget, `entry` /
`panel` → `lib/client.js`, `id: "dsh-supervisor"`, `title: "Supervisor"`, slot
target `main` (`@deepseek-ai/dsh-client-ui-layout` keyed slot). Host half mounts
`ctx.webServer.route('/dsh-supervisor/*')` and forwards to the supervisor base
URL (config, default `http://127.0.0.1:4720`), injecting the token server-side,
so the browser needs no CORS exception. Panel opens via
`ctx.layout.selectPanel('dsh-supervisor')`.

## 3. Extension mechanism for agent-driven control: a **skill**

Decision: ship a `supervisor` skill (SKILL.md + thin auth-carrying `curl`
helper) next to the plugin. Justification: the HTTP/SSE API is already the
complete contract, so a skill adds discoverable instructions and one helper with
no new process, no new transport and no second security boundary; it behaves the
same in DSH and any skill-loading harness, and the decision queue keeps its
existing path (a skill can *ask*, never *answer*). An MCP server buys tool-schema
niceties at the cost of a long-lived process, a duplicate auth fence and a
protocol to version; a native tool call would bind the supervisor to one host's
tool registry, breaking "no privileged side doors" and host independence.
Revisit only if a host cannot load skills.

## 4. Terminal transport port

Two ports, both narrow and injected; the core imports neither `tmux` nor `ssh`
nor a relay client. `SessionSource` (workspace/session listing) is the second.
```ts
export interface AttachSpec { sessionId: string; cwd: string; cols: number; rows: number }
export interface AttachHandle {
  readonly id: string;
  readonly windowLabel: string;        // e.g. "sup:s_42"
  readonly attachCommand: string;      // what a human could type
  resize(cols: number, rows: number): Promise<void>;
  input(bytes: Uint8Array): Promise<void>;
  output(): AsyncIterable<Uint8Array>; // framed bytes for the SSE route
  close(): Promise<void>;              // detaches the view, not the agent
}
export interface TerminalTransport {
  readonly kind: "tmux" | "relay" | "ssh";
  open(spec: AttachSpec): Promise<AttachHandle>;
  reap?(sessionId: string): Promise<void>;
}
```

`TmuxTransport` (now, in `packages/server`): socket `-L supervisor`, session
`sup`, one window per agent session named after its id, `cwd` set to the agent's
working directory, `-f` pinned to the plugin's shipped `tmux.conf`.
`RelayTransport` / `SshTransport` (later) implement the same interface as remote
endpoints, selected by config; routes, payload and panel stay untouched.

## Decisions taken

- One-round-trip `/panes` payload rather than N calls — the panel needs it atomically.
- Attach returns a descriptor plus an SSE byte stream; the browser never hosts tmux.
- `close()` detaches only, honouring "an agent blocked on a human stays blocked".
- Agent-driven control = skill over MCP or native tool (§3).
- The panel renders decisions and forwards answers; auto-answer is out of scope.
