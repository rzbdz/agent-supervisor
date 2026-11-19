import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Supervisor, orchestratorTools, workerTools } from '@supervisor/core';
import { ClaudeCodeAdapter } from '@supervisor/agent-claude';
import { FileStore } from '@supervisor/server';

/**
 * End-to-end smoke test against a real Claude Code CLI.
 *
 * Opt-in (`SUPERVISOR_E2E=1`) because it spawns agents, costs tokens and needs
 * a working `claude` login. It proves the one property the framework exists
 * for: an agent stops at a human-decision point and resumes when answered.
 */
const enabled = process.env.SUPERVISOR_E2E === '1';

describe.skipIf(!enabled)('claude-code adapter (e2e)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  it('blocks on a Write permission, then completes after approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supervisor-e2e-'));
    const store = new FileStore(join(root, '.supervisor'));
    await store.init();
    const supervisor = new Supervisor({ adapter: new ClaudeCodeAdapter(), store });
    for (const tool of [...workerTools(supervisor), ...orchestratorTools(supervisor)]) {
      supervisor.registerTool(tool);
    }
    cleanups.push(() => supervisor.close());

    const session = await supervisor.openSession({
      name: 'e2e',
      cwd: root,
      purpose: 'e2e probe',
      task: 'Create a file named e2e.txt containing the word PROVEN. Then stop.',
      model: process.env.SUPERVISOR_E2E_MODEL ?? 'haiku',
    });

    const decision = await waitFor(async () => supervisor.decisions.list({ status: 'pending' })[0], 120_000);
    expect(decision?.kind).toBe('permission');
    expect(supervisor.getSession(session.id)?.state).toBe('waiting');

    supervisor.answerDecision(decision!.id, { kind: 'permission', behavior: 'allow' });

    await waitFor(async () => {
      const { readFile } = await import('node:fs/promises');
      return readFile(join(root, 'e2e.txt'), 'utf8').catch(() => undefined);
    }, 120_000);
    expect(supervisor.getSession(session.id)?.state).not.toBe('waiting');
  }, 240_000);
});

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
