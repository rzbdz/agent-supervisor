import type {
  AgentAdapter,
  AgentHost,
  AgentSession,
  SpawnSpec,
  ToolContext,
  ToolSpec,
} from '@supervisor/core';
import {
  type DecisionAnswer,
  type InteractionPayload,
  type Question,
} from '@supervisor/protocol';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

const ADAPTER_KIND = 'claude-code';

/**
 * Sends user messages into a live streaming-input `query()`.
 *
 * The SDK consumes an async iterable; this class is the producer side that
 * the supervisor's `send` writes into.
 */
class MessageStream implements AsyncIterable<SDKUserMessage> {
  #pending: SDKUserMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(text: string): void {
    if (this.#closed) throw new Error('Session is closed');
    this.#pending.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    });
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        for (;;) {
          const next = this.#pending.shift();
          if (next) return { value: next, done: false };
          if (this.#closed) return { value: undefined, done: true };
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
          this.#wake = null;
        }
      },
    };
  }
}

/**
 * The Claude Code implementation of `AgentAdapter`.
 *
 * Design notes:
 *
 * - Every human-decision point goes through `canUseTool`. The SDK calls it
 *   for tool approvals, for `AskUserQuestion`, and for `ExitPlanMode`; it has
 *   no timeout, so a worker can stay blocked until a person answers. This is
 *   exactly the framework invariant, enforced natively rather than emulated.
 * - Settings isolation (`settingSources: []`, `strictMcpConfig: true`) keeps
 *   the worker from inheriting the operator's hooks and MCP servers, whose
 *   own prompts would bypass the supervisor.
 * - A custom in-process MCP server carries the supervisor tools (`ask_human`,
 *   `report`), so worker-to-supervisor communication is a tool call with a
 *   documented result, never free-text parsing.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = ADAPTER_KIND;
  readonly #executable?: string;

  constructor(config: { executable?: string } = {}) {
    this.#executable = config.executable;
  }

  async start(
    spec: SpawnSpec,
    host: AgentHost,
    extra: { tools: ToolSpec[]; resumeNativeId?: string },
  ): Promise<AgentSession> {
    const stream = new MessageStream();
    const toolContext: ToolContext = {
      sessionId: spec.id,
      sessionName: spec.name,
      raise: host.raise,
      emit: host.emit,
    };
    const mcpServer = createSdkMcpServer({
      name: 'supervisor',
      version: '0.1.0',
      // Workers must not wait on tool search to reach the supervisor.
      alwaysLoad: true,
      tools: extra.tools.map((toolSpec) =>
        tool(toolSpec.name, toolSpec.description, toolSpec.inputSchema, async (args) => {
          const result = await toolSpec.handler(
            args as Record<string, unknown>,
            toolContext,
          );
          return {
            content: [{ type: 'text', text: result.content }],
            ...(result.isError ? { isError: true } : {}),
          };
        }),
      ),
    });

    const options: Options = {
      cwd: spec.cwd,
      model: spec.model,
      // A worker must never inherit the operator's settings, hooks or MCP
      // servers: their prompts would race the supervisor's.
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { supervisor: mcpServer },
      // `auto`: a classifier handles routine, low-risk actions so they never
      // cost the human attention. Anything it cannot judge escalates to
      // `canUseTool` below, which is exactly where a person decides.
      permissionMode: spec.permissionMode ?? 'auto',
      // Only the supervision channel bypasses the prompt; every other tool
      // call still reaches `canUseTool`.
      allowedTools: extra.tools
        .filter((toolSpec) => toolSpec.autoApprove)
        .map((toolSpec) => `mcp__supervisor__${toolSpec.name}`),
      tools: { type: 'preset', preset: 'claude_code' },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildWorkerInstructions(spec),
      },
      includePartialMessages: false,
      resume: extra.resumeNativeId,
      canUseTool: makeCanUseTool(host),
      stderr: (data) => {
        // The agent CLI writes advisory noise (model notices, warnings) to
        // stderr during normal operation. Keep it out of the session event
        // stream unless debugging is asked for.
        if (process.env.SUPERVISOR_DEBUG) {
          process.stderr.write(`[${spec.name}] ${data}`);
        }
      },
      ...(this.#executable ? { pathToClaudeCodeExecutable: this.#executable } : {}),
    };

    const q = query({ prompt: stream, options });

    const runtime = new ClaudeSession(stream, q, host, spec.id);
    void runtime.consume();
    return runtime;
  }
}

class ClaudeSession implements AgentSession {
  #running = false;
  #stopped = false;

  constructor(
    readonly stream: MessageStream,
    readonly query: Query,
    readonly host: AgentHost,
    readonly sessionId: SpawnSpec['id'],
  ) {}

  isRunning(): boolean {
    return this.#running;
  }

  async send(text: string): Promise<void> {
    if (this.#stopped) throw new Error('Session stopped');
    this.stream.push(text);
  }

  async interrupt(): Promise<void> {
    await this.query.interrupt();
  }

  /** Live changes are supported in streaming-input mode. */
  async setPermissionMode(mode: NonNullable<SpawnSpec['permissionMode']>): Promise<void> {
    await this.query.setPermissionMode(mode);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.stream.close();
    this.query.close();
  }

  /** Drain the SDK stream, translating it into supervisor events. */
  async consume(): Promise<void> {
    try {
      for await (const message of this.query) {
        switch (message.type) {
          case 'system':
            if (message.subtype === 'init') {
              this.host.setNativeSessionId(message.session_id);
              this.host.emit({ type: 'state', state: 'idle', detail: 'ready' });
            }
            break;
          case 'assistant': {
            this.#running = true;
            for (const block of message.message.content) {
              if (block.type === 'text' && block.text.trim()) {
                this.host.emit({ type: 'text', role: 'assistant', text: block.text });
              } else if (block.type === 'tool_use') {
                this.host.emit({
                  type: 'tool',
                  toolName: block.name,
                  input: block.input as Record<string, unknown>,
                });
              }
            }
            break;
          }
          case 'user': {
            const content = message.message.content;
            if (!Array.isArray(content)) break;
            for (const block of content) {
              if (block.type !== 'tool_result') continue;
              this.host.emit({
                type: 'tool_result',
                toolName: '',
                toolUseId: block.tool_use_id,
                outcome: block.is_error ? 'error' : 'ok',
              });
            }
            break;
          }
          case 'result': {
            this.#running = false;
            const resultText =
              'result' in message && typeof message.result === 'string'
                ? message.result.slice(0, 4000)
                : undefined;
            this.host.emit({
              type: 'turn',
              phase: 'end',
              result: resultText,
              costUsd: message.total_cost_usd,
            });
            if (this.#stopped) return;
            this.host.emit({ type: 'state', state: 'idle' });
            break;
          }
          default:
            break;
        }
      }
    } catch (error) {
      if (this.#stopped) return;
      this.host.emit({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      this.host.emit({ type: 'state', state: 'stopped', detail: 'crash' });
    }
  }
}

/**
 * Map the SDK's permission callback onto the supervisor's decision queue.
 *
 * `allow` must echo the input back: the SDK treats a missing `updatedInput`
 * as a broken answer. Denials carry a message the agent can read and adapt to.
 */
function makeCanUseTool(host: AgentHost): CanUseTool {
  return async (toolName, input, context): Promise<PermissionResult> => {
    let interaction: InteractionPayload;
    if (toolName === 'AskUserQuestion') {
      interaction = {
        kind: 'question',
        questions: readQuestions(input),
      };
    } else if (toolName === 'ExitPlanMode') {
      interaction = {
        kind: 'plan',
        plan:
          typeof input.plan === 'string'
            ? input.plan
            : typeof input.summary === 'string'
              ? input.summary
              : '(plan text unavailable)',
      };
    } else {
      interaction = {
        kind: 'permission',
        toolName,
        input,
        title: context.title,
        displayName: context.displayName,
        description: context.description,
        decisionReason: context.decisionReason,
        blockedPath: context.blockedPath,
      };
    }

    const answer = await host.raise(interaction).catch((): DecisionAnswer => {
      // A withdrawn request (the session stopped, or the supervisor shut
      // down) must read to the agent as a refusal, never as consent.
      return interaction.kind === 'question'
        ? { kind: 'question', answers: {} }
        : { kind: interaction.kind, behavior: 'deny', message: 'The request was withdrawn.' };
    });
    return toPermissionResult(answer, input);
  };
}

function toPermissionResult(
  answer: DecisionAnswer,
  originalInput: Record<string, unknown>,
): PermissionResult {
  switch (answer.kind) {
    case 'question': {
      // The SDK requires the original questions back, plus the answers map.
      return {
        behavior: 'allow',
        updatedInput: {
          ...originalInput,
          answers: answer.answers,
        },
      };
    }
    case 'permission':
    case 'plan': {
      if (answer.behavior === 'allow') {
        return {
          behavior: 'allow',
          updatedInput: answer.kind === 'permission' && answer.updatedInput ? answer.updatedInput : originalInput,
        };
      }
      return {
        behavior: 'deny',
        message: answer.message?.trim() || 'The human declined this action.',
      };
    }
  }
}

function readQuestions(input: Record<string, unknown>): Question[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => {
    const question = q as {
      question?: string;
      header?: string;
      multiSelect?: boolean;
      options?: Array<{ label?: string; description?: string; preview?: string }>;
    };
    return {
      question: question.question ?? '',
      header: question.header,
      multiSelect: question.multiSelect,
      options: (question.options ?? [])
        .filter((o): o is { label: string } & typeof o => typeof o.label === 'string')
        .map((o) => ({
          label: o.label,
          description: o.description,
          preview: o.preview,
        })),
    };
  });
}

/**
 * The instructions appended to Claude Code's own system prompt.
 *
 * Kept to what a worker must know to cooperate with the supervisor; domain
 * instructions live with the session's purpose and its first message.
 */
function buildWorkerInstructions(spec: SpawnSpec): string {
  const purpose = spec.purpose ? `\nYour role: ${spec.purpose}` : '';
  const workspace = spec.options?.workspaceRoot
    ? `\n- Project root: ${String(spec.options.workspaceRoot)}`
    : '';
  return `
# Working under a supervisor

You are a worker agent managed by Agent Supervisor. A person oversees several
workers and answers what needs a person through one queue.

- You operate in ${spec.cwd}. Your name is "${spec.name}".${purpose}${workspace}
- Read and act. Do not spend turns surveying the codebase: open the files you
  need, then write the code, tests or document your task asks for.
- Routine actions do not reach the person; the runtime clears them. Do not
  wait for permission you do not need.
- A person decides plans, alternatives, scope and architecture direction.
  When the work reaches one of those, stop and use \`ask_human\` with concrete
  options. Do not pick an architecture direction on your own.
- \`report\` publishes a structured status: \`progress\`, \`blocked\`, \`ready\`,
  \`failed\`. Use it at the end of a work item; it is not a chat message.
- Do not narrate progress. Say only what a person must act on or can use.
- Stop at the boundary the person set: a local change goes as far as a
  reviewable result; a design decision stops with one concrete question.
`;
}
