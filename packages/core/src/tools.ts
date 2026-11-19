import { z } from 'zod';
import type { ToolSpec } from './ports.ts';
import type { Supervisor } from './supervisor.ts';

/**
 * Tools every worker gets.
 *
 * `ask_human` is the explicit, blocking path to a person; `report` is the
 * non-blocking way to publish a structured fact. Both are ordinary tool calls,
 * so the model cannot confuse them with chat.
 */
export function workerTools(supervisor: Supervisor): ToolSpec[] {
  return [
    {
      name: 'ask_human',
      description:
        'Ask the human a question and wait for the answer. Use this whenever a decision belongs to the person: scope, priorities, taste, or anything ambiguous enough to block progress. Do not guess their answer.',
      audience: 'worker',
      autoApprove: true,
      inputSchema: {
        question: z.string().describe('One concrete question.'),
        options: z
          .array(z.string())
          .max(4)
          .optional()
          .describe('Optional suggested answers. The human may still answer freely.'),
        multiSelect: z.boolean().optional().describe('Allow several options at once.'),
      },
      handler: async (args, ctx) => {
        const options = (args.options as string[] | undefined) ?? [];
        const answer = await ctx.raise({
          kind: 'question',
          questions: [
            {
              question: String(args.question ?? ''),
              options: options.map((label) => ({ label })),
              multiSelect: Boolean(args.multiSelect),
            },
          ],
        });
        if (answer.kind !== 'question') {
          return { content: 'The question was not answered.', isError: true };
        }
        return { content: Object.values(answer.answers).join('\n') || '(no answer)' };
      },
    },
    {
      name: 'report',
      description:
        'Publish a structured status for the supervisor. Does not block and is not a message to the human. Use `progress` while working, `blocked` when you need something, `ready` when a reviewable result exists, `failed` when you cannot continue.',
      audience: 'worker',
      autoApprove: true,
      inputSchema: {
        status: z.enum(['progress', 'blocked', 'ready', 'failed']),
        summary: z.string().describe('One or two sentences.'),
      },
      handler: async (args, ctx) => {
        ctx.emit({
          type: 'report',
          status: args.status as 'progress',
          summary: String(args.summary ?? ''),
        });
        return { content: 'Recorded.' };
      },
    },
  ];
}

/**
 * Tools only the orchestrator gets: it is the one session that may start,
 * address and inspect other sessions. Workers cannot route, by construction.
 */
export function orchestratorTools(supervisor: Supervisor): ToolSpec[] {
  return [
    {
      name: 'list_workspaces',
      description:
        'List registered workspaces (project directories) with the agents grouped under each.',
      audience: 'orchestrator',
      autoApprove: true,
      inputSchema: {},
      handler: async () => {
        const rows = supervisor.listWorkspaces().map((w) => ({
          id: w.id,
          name: w.name,
          root: w.root,
          agents: supervisor.workspaceSessions(w.id).map((s) => ({
            name: s.name,
            role: s.agentRole ?? s.role,
            state: s.state,
          })),
        }));
        return { content: JSON.stringify(rows, null, 2) };
      },
    },
    {
      name: 'open_workspace',
      description:
        'Register a project directory as a workspace so several agents can be grouped under it. Idempotent by root.',
      audience: 'orchestrator',
      autoApprove: true,
      inputSchema: {
        name: z.string(),
        root: z.string().describe('Absolute project directory.'),
        description: z.string().optional(),
      },
      handler: async (args) => {
        const workspace = await supervisor.registerWorkspace({
          name: String(args.name),
          root: String(args.root),
          description: args.description ? String(args.description) : undefined,
        });
        return { content: JSON.stringify({ id: workspace.id, name: workspace.name }) };
      },
    },
    {
      name: 'list_sessions',
      description: 'List every managed session with its state and purpose.',
      audience: 'orchestrator',
      autoApprove: true,
      inputSchema: {},
      handler: async () => {
        const rows = supervisor.listSessions().map((s) => ({
          name: s.name,
          state: s.state,
          cwd: s.cwd,
          purpose: s.purpose ?? '',
        }));
        return { content: JSON.stringify(rows, null, 2) };
      },
    },
    {
      name: 'open_session',
      description:
        'Start a new worker session in a directory. Use one session per role or workstream (for example architect, backend, frontend).',
      audience: 'orchestrator',
      autoApprove: true,
      inputSchema: {
        name: z.string().describe('Short unique name, e.g. "backend".'),
        cwd: z.string().describe('Absolute path the worker operates in.'),
        purpose: z.string().describe('One line: what this worker owns.'),
        model: z.string().optional(),
        agentRole: z
          .string()
          .optional()
          .describe('Organization role, e.g. architect, backend, frontend.'),
        workspaceId: z
          .string()
          .optional()
          .describe('Workspace to group this agent under; defaults to the one at cwd.'),
        permissionMode: z
          .enum(['auto', 'default', 'plan', 'acceptEdits'])
          .optional()
          .describe('autonomy; defaults to auto.'),
        task: z
          .string()
          .optional()
          .describe('First instruction sent to the worker after it starts.'),
      },
      handler: async (args, ctx) => {
        const session = await supervisor.openSession({
          name: String(args.name),
          cwd: String(args.cwd),
          purpose: String(args.purpose ?? ''),
          model: args.model ? String(args.model) : undefined,
          agentRole: args.agentRole ? String(args.agentRole) : undefined,
          workspaceId: args.workspaceId
            ? (String(args.workspaceId) as import('@supervisor/protocol').WorkspaceId)
            : undefined,
          permissionMode: args.permissionMode as
            | 'auto'
            | 'default'
            | 'plan'
            | 'acceptEdits'
            | undefined,
        });
        if (typeof args.task === 'string' && args.task.trim()) {
          // Send through the supervisor so the session is marked working
          // before the orchestrator gets its tool result back.
          await supervisor.send(session.id, args.task);
        }
        return {
          content: JSON.stringify({ name: session.name, cwd: session.cwd, state: 'started' }),
        };
      },
    },
    {
      name: 'route',
      description:
        'Send a message to a worker session as its next instruction. The worker runs immediately and asynchronously; this call does not wait for it.',
      audience: 'orchestrator',
      autoApprove: true,
      inputSchema: {
        session: z.string().describe('Session name.'),
        message: z.string().describe('The instruction, in the second person.'),
      },
      handler: async (args) => {
        const target = supervisor.findByName(String(args.session));
        if (!target) return { content: `No session named ${String(args.session)}`, isError: true };
        await supervisor.send(target.id, String(args.message));
        return { content: `Delivered to ${target.name}.` };
      },
    },
    {
      name: 'list_decisions',
      description:
        'List human decisions that are still pending. Read-only: the human answers them, never an agent.',
      audience: 'orchestrator',
      autoApprove: true,
      inputSchema: {},
      handler: async () => {
        const pending = supervisor.decisions.list({ status: 'pending' }).map((d) => ({
          id: d.id,
          session: d.sessionName,
          kind: d.kind,
          summary: d.summary,
          createdAt: d.createdAt,
        }));
        return { content: JSON.stringify(pending, null, 2) };
      },
    },
    {
      name: 'session_events',
      description: 'Read the most recent events of a session.',
      audience: 'orchestrator',
      autoApprove: true,
      inputSchema: {
        session: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      handler: async (args) => {
        const target = supervisor.findByName(String(args.session));
        if (!target) return { content: 'No such session', isError: true };
        const events = await supervisor.sessionEvents(target.id, Number(args.limit ?? 20));
        return { content: JSON.stringify(events, null, 2) };
      },
    },
  ];
}

// Unused-parameter hygiene for `ctx` in orchestrator tools that ignore it.
void (0 as unknown as z.ZodType);
