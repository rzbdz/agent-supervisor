# 001 Domain model

Four concepts. Everything else is an implementation of a port.

| Concept | Definition | Rules it keeps |
| --- | --- | --- |
| Session | One managed agent conversation bound to a working directory | Has one state: `starting`, `idle`, `working`, `waiting`, `stopped`. Only the supervisor writes it. A session remembers the agent's own session id so it can be resumed. |
| Decision | One point where a person must choose | Created when an agent hits a decision point. Has a kind (`permission`, `question`, `plan`) and stays `pending` until a person answers, cancels or the session stops. The kind of the answer must match the kind of the decision. |
| Orchestrator | The session a person talks to | The only session that may open, address or inspect other sessions. It gets its own tools plus the worker tools. It cannot answer decisions. |
| Presentation | A client of the supervisor API | Reads state and the event stream, submits human answers. Holds no domain rules. |

## Session states

| State | Meaning | Who may leave it |
| --- | --- | --- |
| `starting` | the adapter is spawning the agent | adapter reports idle |
| `idle` | a turn is not running | a message, or a decision |
| `working` | a turn is running | adapter reports idle |
| `waiting` | blocked on a decision | a person's answer, or the session stopping |
| `stopped` | the runtime is gone | a message (which resumes the native conversation) |

`waiting` is the load-bearing state. Adapter chatter cannot move a session out
of it; only the answer path and a turn end can.

## Decision lifecycle

```
raised ──▶ pending ──▶ answered
                ├────▶ cancelled   (session stopped, supervisor shut down)
                └────▶ expired     (process died with the decision pending)
```

An `expired` decision is a fact about the past, not a question: it cannot be
answered, because the agent process that was waiting no longer exists.

## Rejected concepts

| Rejected | Why |
| --- | --- |
| A task/ticket aggregate | The POC's unit of work is the session. A task layer would duplicate state the session transcript already holds; add it only when work outlives sessions. |
| Agent-to-agent consent | A worker may ask the *person*, never another worker. Only the orchestrator routes, and routing carries no authority. |
| Free-text "waiting" detection | Waiting is a state the runtime reports by blocking, not a word the supervisor greps for. |
| A supervisor-owned transcript | The agent owns its transcript. The supervisor keeps events for presentation and the native id for resumption. |
| Auto-approval policies in the core | A policy is a presentation/deployment concern; the POC keeps approvals explicit so the invariant is visible. |
