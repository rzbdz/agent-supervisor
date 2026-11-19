import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SupervisorClient } from './client.ts';
import type { Decision, SessionEvent } from '@supervisor/protocol';

const defaultUrl = (): string =>
  process.env.SUPERVISOR_URL ?? 'http://127.0.0.1:4700';

/**
 * The CLI is the first presentation.
 *
 * Every command is scriptable (`--json`) because the POC's own operator is
 * another agent: an orchestrating chat session drives the supervisor through
 * exactly the same commands a person would type. A web panel or IM gateway
 * will later talk to the same HTTP API, never to the CLI internals.
 */
export function buildProgram(): Command {
  const program = new Command('sv')
    .description('Talk to the Agent Supervisor')
    .option('-u, --url <url>', 'supervisor base URL', defaultUrl())
    .option('--json', 'machine-readable output', false);

  program
    .command('up')
    .description('Start the supervisor daemon in the background')
    .option('-p, --port <port>', 'port to listen on', '4700')
    .option('-r, --root <dir>', 'project root', process.cwd())
    .option('-m, --model <model>', 'model for the orchestrator')
    .action(async (options: { port: string; root: string; model?: string }) => {
      const entry = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../server/src/main.ts',
      );
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          entry,
          '--port',
          options.port,
          '--root',
          resolve(options.root),
          ...(options.model ? ['--model', options.model] : []),
        ],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
      console.log(`supervisor starting on http://127.0.0.1:${options.port} (pid ${child.pid})`);
    });

  program
    .command('down')
    .description('Stop the supervisor daemon')
    .action(async () => {
      const client = clientFor(program);
      await client.shutdown();
      console.log('supervisor shutting down');
    });

  program
    .command('status')
    .description('Show sessions and pending decisions')
    .action(async () => {
      const client = clientFor(program);
      const [sessions, pending] = await Promise.all([
        client.sessions(),
        client.decisions('pending'),
      ]);
      if (json(program)) {
        console.log(JSON.stringify({ sessions, pending }, null, 2));
        return;
      }
      console.log(sessions.length ? 'SESSIONS' : 'SESSIONS (none)');
      for (const session of sessions) {
        const flag = session.state === 'waiting' ? '  ← needs you' : '';
        console.log(
          `  ${session.name.padEnd(18)} ${session.state.padEnd(9)} ${session.role.padEnd(12)} ${session.cwd}${flag}`,
        );
      }
      console.log(pending.length ? '\nWAITING FOR A DECISION' : '\nWAITING FOR A DECISION (none)');
      for (const decision of pending) {
        console.log(`  [${decision.id.slice(0, 8)}] ${decision.sessionName}: ${decision.summary}`);
      }
    });

  program
    .command('open <name>')
    .description('Open a worker session')
    .requiredOption('-d, --cwd <dir>', 'working directory')
    .option('-p, --purpose <text>', 'one-line role')
    .option('-m, --model <model>', 'model override')
    .option('-t, --task <text>', 'first instruction')
    .action(async (name: string, options: Record<string, string>) => {
      const client = clientFor(program);
      const session = await client.openSession({
        name,
        cwd: resolve(options.cwd!),
        purpose: options.purpose,
        model: options.model,
        task: options.task,
      });
      print(program, session, `opened ${session.name} in ${session.cwd}`);
    });

  program
    .command('say <session> <text...>')
    .description('Send a message to a session')
    .action(async (name: string, text: string[]) => {
      const client = clientFor(program);
      const target = await findSession(client, name);
      await client.send(target.id, text.join(' '));
      print(program, { ok: true }, `sent to ${target.name}`);
    });

  program
    .command('stop <session>')
    .description('Stop a session')
    .action(async (name: string) => {
      const client = clientFor(program);
      const target = await findSession(client, name);
      await client.stop(target.id);
      print(program, { ok: true }, `stopped ${target.name}`);
    });

  program
    .command('events <session>')
    .description('Show recent events of a session')
    .option('-n, --limit <n>', 'how many', '30')
    .action(async (name: string, options: { limit: string }) => {
      const client = clientFor(program);
      const target = await findSession(client, name);
      const events = await client.sessionEvents(target.id, Number(options.limit));
      if (json(program)) {
        console.log(JSON.stringify(events, null, 2));
        return;
      }
      for (const event of events) console.log(formatEvent(event));
    });

  const decisions = program.command('decisions').description('Work the decision inbox');

  decisions
    .command('list')
    .description('List decisions (pending by default)')
    .option('-a, --all', 'include settled decisions')
    .action(async (options: { all?: boolean }) => {
      const client = clientFor(program);
      const list = await client.decisions(options.all ? undefined : 'pending');
      if (json(program)) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      for (const decision of list) {
        console.log(
          `[${decision.id}] ${decision.status} ${decision.sessionName} · ${decision.kind} · ${decision.summary}`,
        );
      }
    });

  decisions
    .command('show <id>')
    .description('Show one decision in full')
    .action(async (id: string) => {
      const client = clientFor(program);
      const list = await client.decisions();
      const decision = list.find((d) => d.id.startsWith(id));
      if (!decision) throw new Error(`No decision starting with ${id}`);
      print(program, decision, describeDecision(decision));
    });

  decisions
    .command('allow <id>')
    .description('Approve a permission or plan decision')
    .option('-m, --message <text>', 'note shown to the agent')
    .action(async (id: string, options: { message?: string }) => {
      const client = clientFor(program);
      const decision = await findDecision(client, id);
      if (decision.kind === 'question') {
        throw new Error('This is a question; answer it with `sv decisions answer`.');
      }
      await client.answer(decision.id, {
        kind: decision.kind,
        behavior: 'allow',
        message: options.message,
      });
      print(program, { ok: true }, `allowed ${decision.sessionName}`);
    });

  decisions
    .command('deny <id>')
    .description('Deny a permission or plan decision')
    .requiredOption('-m, --message <text>', 'why, shown to the agent')
    .action(async (id: string, options: { message: string }) => {
      const client = clientFor(program);
      const decision = await findDecision(client, id);
      if (decision.kind === 'question') {
        throw new Error('This is a question; answer it with `sv decisions answer`.');
      }
      await client.answer(decision.id, {
        kind: decision.kind,
        behavior: 'deny',
        message: options.message,
      });
      print(program, { ok: true }, `denied ${decision.sessionName}`);
    });

  decisions
    .command('answer <id> <answer...>')
    .description('Answer a question decision with free text')
    .action(async (id: string, text: string[]) => {
      const client = clientFor(program);
      const decision = await findDecision(client, id);
      if (decision.kind !== 'question') {
        throw new Error('Not a question; use `allow` or `deny`.');
      }
      const questions = decision.payload.kind === 'question' ? decision.payload.questions : [];
      const value = text.join(' ');
      // With several questions, answers are given as `q1=... q2=...`;
      // a single answer applies to every question otherwise.
      const answers: Record<string, string> = {};
      const parts = value.split(/\s*\|\s*/);
      questions.forEach((question, index) => {
        answers[question.question] = parts[index] ?? parts.at(-1) ?? value;
      });
      await client.answer(decision.id, { kind: 'question', answers });
      print(program, { ok: true }, `answered ${decision.sessionName}`);
    });

  program
    .command('watch')
    .description('Follow the live event stream (Ctrl+C to stop)')
    .option('--only-waiting', 'print only decisions and state changes', false)
    .action((options: { onlyWaiting?: boolean }) => {
      const client = clientFor(program);
      const stop = client.stream((event) => {
        if (options.onlyWaiting) {
          if (event.type === 'decision' || (event.type === 'state' && event.state === 'waiting')) {
            console.log(formatEvent(event));
          }
          return;
        }
        console.log(formatEvent(event));
      });
      process.on('SIGINT', () => {
        stop();
        process.exit(0);
      });
    });

  return program;
}

function clientFor(program: Command): SupervisorClient {
  return new SupervisorClient(program.opts().url as string);
}

function json(program: Command): boolean {
  return Boolean(program.opts().json);
}

function print(program: Command, value: unknown, human: string): void {
  console.log(json(program) ? JSON.stringify(value, null, 2) : human);
}

async function findSession(client: SupervisorClient, name: string) {
  const sessions = await client.sessions();
  const match = sessions.find((s) => s.name === name || s.id === name);
  if (!match) {
    const names = sessions.map((s) => s.name).join(', ') || 'none';
    throw new Error(`No session "${name}". Live sessions: ${names}`);
  }
  return match;
}

async function findDecision(client: SupervisorClient, id: string): Promise<Decision> {
  const all = await client.decisions();
  const match = all.find((d) => d.id === id || d.id.startsWith(id));
  if (!match) throw new Error(`No decision starting with ${id}`);
  if (match.status !== 'pending') throw new Error(`Decision is already ${match.status}`);
  return match;
}

export function describeDecision(decision: Decision): string {
  const lines = [
    `${decision.sessionName} · ${decision.kind}`,
    decision.summary,
    '',
  ];
  if (decision.payload.kind === 'permission') {
    lines.push(JSON.stringify(decision.payload.input, null, 2));
  } else if (decision.payload.kind === 'question') {
    for (const question of decision.payload.questions) {
      lines.push(`? ${question.question}`);
      for (const option of question.options) {
        lines.push(`    - ${option.label}${option.description ? ` — ${option.description}` : ''}`);
      }
    }
  } else {
    lines.push(decision.payload.plan);
  }
  return lines.join('\n');
}

export function formatEvent(event: SessionEvent): string {
  switch (event.type) {
    case 'state':
      return `⟨state⟩ ${event.sessionId.slice(0, 8)} → ${event.state}${event.detail ? ` (${event.detail})` : ''}`;
    case 'text':
      return `⟨${event.role}⟩ ${event.text}`;
    case 'tool':
      return `⟨tool⟩ ${event.toolName} ${truncate(JSON.stringify(event.input), 200)}`;
    case 'tool_result':
      return `⟨result⟩ ${event.toolName || event.toolUseId} ${event.outcome}`;
    case 'turn':
      return event.phase === 'end'
        ? `⟨turn end⟩ ${truncate(event.result ?? '', 300)}${event.costUsd ? ` ($${event.costUsd.toFixed(4)})` : ''}`
        : '⟨turn start⟩';
    case 'decision':
      return `⟨decision⟩ ${event.decisionId.slice(0, 8)} ${event.phase}`;
    case 'report':
      return `⟨report⟩ ${event.status}: ${event.summary}`;
    case 'error':
      return `⟨error⟩ ${event.message}`;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
