import { describe, expect, it } from 'vitest';
import { Supervisor, type AgentAdapter, type AgentHost, type AgentSession, type PersistedState, type SpawnSpec, type StateStore, type ToolSpec, type LoggedEvent } from '@supervisor/core';
import type { SessionEvent } from '@supervisor/protocol';

/**
 * A fake adapter: the only behaviour under test is the supervisor's, so the
 * adapter records what it was told and lets the test drive the host.
 */
class FakeAdapter implements AgentAdapter {
  readonly kind = 'fake';
  readonly started: Array<{ spec: SpawnSpec; host: AgentHost; tools: ToolSpec[]; resumeNativeId?: string }> = [];
  #sessions = new Map<string, AgentSession>();

  async start(spec: SpawnSpec, host: AgentHost, extra: { tools: ToolSpec[]; resumeNativeId?: string }): Promise<AgentSession> {
    this.started.push({ spec, host, ...extra });
    host.setNativeSessionId(`native-${spec.name}`);
    const session: AgentSession = {
      send: async () => undefined,
      interrupt: async () => undefined,
      stop: async () => undefined,
      isRunning: () => false,
    };
    this.#sessions.set(spec.id, session);
    return session;
  }

  hostFor(name: string): AgentHost {
    const call = this.started.find((s) => s.spec.name === name);
    if (!call) throw new Error(`No session ${name}`);
    return call.host;
  }

  toolsFor(name: string): ToolSpec[] {
    const call = this.started.find((s) => s.spec.name === name);
    if (!call) throw new Error(`No session ${name}`);
    return call.tools;
  }
}

class MemoryStore implements StateStore {
  state: PersistedState = { sessions: [], pendingDecisions: [] };
  events: LoggedEvent[] = [];
  async load() { return this.state; }
  async save(state: PersistedState) { this.state = state; }
  async appendEvent(seq: number, event: SessionEvent) {
    this.events.push({ seq, at: new Date().toISOString(), event });
  }
  async lastSeq() {
    return this.events.at(-1)?.seq ?? 0;
  }
  async readEvents(afterSeq: number, limit: number) {
    return this.events.filter((e) => e.seq > afterSeq).slice(0, limit);
  }
}

function makeSupervisor() {
  const adapter = new FakeAdapter();
  const store = new MemoryStore();
  const supervisor = new Supervisor({ adapter, store });
  return { adapter, store, supervisor };
}

describe('supervisor decision flow', () => {
  it('blocks a session until a person answers, then resumes it', async () => {
    const { adapter, supervisor } = makeSupervisor();
    const session = await supervisor.openSession({ name: 'w1', cwd: '/tmp/x', purpose: 'worker' });
    expect(session.state).toBe('idle');

    const host = adapter.hostFor('w1');
    let settled = false;
    const answerPromise = host
      .raise({ kind: 'permission', toolName: 'Write', input: { file_path: '/tmp/x/a' } })
      .then((answer) => {
        settled = true;
        return answer;
      });

    await Promise.resolve();
    expect(supervisor.getSession(session.id)?.state).toBe('waiting');
    const pending = supervisor.decisions.list({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(settled).toBe(false);

    supervisor.answerDecision(pending[0]!.id, { kind: 'permission', behavior: 'allow' });
    const answer = await answerPromise;
    expect(settled).toBe(true);
    expect(answer).toEqual({ kind: 'permission', behavior: 'allow' });
    expect(supervisor.decisions.list({ status: 'answered' })).toHaveLength(1);
  });

  it('refuses an answer whose kind does not match the decision', async () => {
    const { adapter, supervisor } = makeSupervisor();
    await supervisor.openSession({ name: 'w1', cwd: '/tmp/x' });
    void adapter.hostFor('w1').raise({
      kind: 'question',
      questions: [{ question: 'Which?', options: [{ label: 'a' }] }],
    });
    await Promise.resolve();
    const pending = supervisor.decisions.list({ status: 'pending' })[0]!;
    expect(() =>
      supervisor.answerDecision(pending.id, { kind: 'permission', behavior: 'allow' }),
    ).toThrow(/does not match/);
  });

  it('cancels a session’s pending decisions when it stops', async () => {
    const { adapter, supervisor } = makeSupervisor();
    const session = await supervisor.openSession({ name: 'w1', cwd: '/tmp/x' });
    const raised = adapter.hostFor('w1').raise({
      kind: 'permission',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
    });
    await Promise.resolve();
    await supervisor.stop(session.id);
    await expect(raised).rejects.toThrow(/stopped/);
    expect(supervisor.decisions.list({ status: 'cancelled' })).toHaveLength(1);
  });

  it('does not let adapter state events un-wait a blocked session', async () => {
    const { adapter, supervisor } = makeSupervisor();
    const session = await supervisor.openSession({ name: 'w1', cwd: '/tmp/x' });
    const host = adapter.hostFor('w1');
    void host.raise({ kind: 'permission', toolName: 'Write', input: {} });
    await Promise.resolve();
    expect(supervisor.getSession(session.id)?.state).toBe('waiting');

    host.emit({ type: 'state', state: 'working' });
    expect(supervisor.getSession(session.id)?.state).toBe('waiting');

    host.emit({ type: 'state', state: 'idle' });
    expect(supervisor.getSession(session.id)?.state).toBe('idle');
  });
});

describe('supervisor sessions', () => {
  it('gives the orchestrator both tool sets and workers only the worker set', async () => {
    const { adapter, supervisor } = makeSupervisor();
    const workerTool: ToolSpec = {
      name: 'ask_human',
      description: '',
      inputSchema: {},
      audience: 'worker',
      handler: async () => ({ content: '' }),
    };
    const orchestratorTool: ToolSpec = {
      name: 'route',
      description: '',
      inputSchema: {},
      audience: 'orchestrator',
      handler: async () => ({ content: '' }),
    };
    supervisor.registerTool(workerTool);
    supervisor.registerTool(orchestratorTool);

    await supervisor.openSession({ name: 'main', cwd: '/tmp/x', role: 'orchestrator' });
    await supervisor.openSession({ name: 'worker', cwd: '/tmp/x', role: 'worker' });

    expect(adapter.toolsFor('main').map((t) => t.name).sort()).toEqual(['ask_human', 'route']);
    expect(adapter.toolsFor('worker').map((t) => t.name)).toEqual(['ask_human']);
  });

  it('rejects duplicate live names but allows reuse after a stop', async () => {
    const { supervisor } = makeSupervisor();
    const first = await supervisor.openSession({ name: 'dup', cwd: '/tmp/x' });
    await expect(supervisor.openSession({ name: 'dup', cwd: '/tmp/x' })).rejects.toThrow(/already exists/);
    await supervisor.stop(first.id);
    await expect(supervisor.openSession({ name: 'dup', cwd: '/tmp/x' })).resolves.toBeTruthy();
  });

  it('persists sessions and resumes the native conversation on reopen', async () => {
    const { adapter, store, supervisor } = makeSupervisor();
    const session = await supervisor.openSession({ name: 'kept', cwd: '/tmp/x' });
    await supervisor.stop(session.id);

    const second = makeSupervisor();
    second.store.state = store.state;
    // A restarted supervisor must know the native id before it resumes.
    await second.supervisor.restore();
    const restored = second.supervisor.findByName('kept');
    expect(restored?.nativeSessionId).toBe('native-kept');

    await second.supervisor.send(restored!.id, 'continue');
    expect(second.adapter.started.at(-1)?.resumeNativeId).toBe('native-kept');
    void adapter;
  });

  it('loads previously pending decisions as expired, never as answerable', async () => {    const { supervisor, store } = makeSupervisor();
    store.state = {
      sessions: [],
      pendingDecisions: [
        {
          id: 'd1',
          sessionId: 's1',
          sessionName: 'w1',
          kind: 'permission',
          summary: 'Write',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await supervisor.restore();
    const [decision] = supervisor.decisions.list();
    expect(decision?.status).toBe('expired');
    expect(() =>
      supervisor.answerDecision('d1' as never, { kind: 'permission', behavior: 'allow' }),
    ).toThrow(/expired/);
  });
});

describe('autonomy', () => {
  it('defaults to auto so routine actions never cost attention', async () => {
    const { supervisor } = makeSupervisor();
    const session = await supervisor.openSession({ name: 'w1', cwd: '/tmp/x' });
    expect(session.permissionMode).toBe('auto');
  });

  it('switches a live session between auto and plan through the runtime', async () => {
    const modes: string[] = [];
    const adapter: AgentAdapter = {
      kind: 'fake-live',
      async start(spec) {
        return {
          send: async () => undefined,
          interrupt: async () => undefined,
          stop: async () => undefined,
          isRunning: () => false,
          setPermissionMode: async (mode) => {
            modes.push(mode);
          },
        };
      },
    };
    const supervisor = new Supervisor({ adapter, store: new MemoryStore() });
    const session = await supervisor.openSession({ name: 'w1', cwd: '/tmp/x' });
    await supervisor.setPermissionMode(session.id, 'plan');
    await supervisor.setPermissionMode(session.id, 'auto');
    expect(modes).toEqual(['plan', 'auto']);
    expect(supervisor.getSession(session.id)?.permissionMode).toBe('auto');
  });

  it('keeps a mode change for a stopped session so the resume honours it', async () => {
    const { supervisor } = makeSupervisor();
    const session = await supervisor.openSession({ name: 'w1', cwd: '/tmp/x' });
    await supervisor.stop(session.id);
    await supervisor.setPermissionMode(session.id, 'plan');
    expect(supervisor.getSession(session.id)?.permissionMode).toBe('plan');
  });
});

describe('attention', () => {
  it('raises attention when a worker settles, but never for the orchestrator', async () => {
    const { adapter, supervisor } = makeSupervisor();
    const events: SessionEvent[] = [];
    supervisor.bus.subscribe((e) => events.push(e));

    const worker = await supervisor.openSession({ name: 'w1', cwd: '/tmp/x' });
    const main = await supervisor.openSession({ name: 'main', cwd: '/tmp/x', role: 'orchestrator' });

    for (const session of [worker, main]) {
      await supervisor.send(session.id, 'do it');
      adapter.hostFor(session.name).emit({ type: 'turn', phase: 'end', result: 'done' });
      adapter.hostFor(session.name).emit({ type: 'state', state: 'idle' });
    }

    const attention = events.filter((e) => e.type === 'attention');
    expect(attention).toHaveLength(1);
    expect(attention[0]?.sessionId).toBe(worker.id);
    expect(attention[0]?.sessionId).toBe(worker.id);
    if (attention[0]?.type === 'attention') expect(attention[0].summary).toBe('done');
  });

  it('stays silent while the worker still owes a decision', async () => {
    const { adapter, supervisor } = makeSupervisor();
    const events: SessionEvent[] = [];
    supervisor.bus.subscribe((e) => events.push(e));
    const worker = await supervisor.openSession({ name: 'w1', cwd: '/tmp/x' });
    const host = adapter.hostFor('w1');
    void host.raise({ kind: 'permission', toolName: 'Write', input: {} });
    await Promise.resolve();
    host.emit({ type: 'state', state: 'idle' });
    expect(events.filter((e) => e.type === 'attention')).toHaveLength(0);
    void worker;
  });
});
