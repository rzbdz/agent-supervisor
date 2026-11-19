import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Supervisor, orchestratorTools, workerTools } from '@supervisor/core';
import { ClaudeCodeAdapter } from '@supervisor/agent-claude';
import { FileStore, defaultStateDir } from './store.ts';
import { serve } from './http.ts';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './orchestrator.ts';
import { TmuxTransport } from './terminal.ts';

export interface BootOptions {
  projectRoot: string;
  port: number;
  host: string;
  /** Name of the main conversation's session. */
  orchestratorName?: string;
  model?: string;
  /** Directory of a built web presentation, if one is installed. */
  webRoot?: string;
}

/**
 * Composition root.
 *
 * Everything is constructed here, once, in dependency order. No module below
 * this file constructs its own collaborators, which keeps adapters and
 * presentations swappable without touching orchestration logic.
 */
export class Runtime {
  readonly supervisor: Supervisor;
  readonly #store: FileStore;
  readonly #options: BootOptions;
  #server: { close(): Promise<void>; port: number } | null = null;

  constructor(options: BootOptions) {
    this.#options = options;
    this.#store = new FileStore(defaultStateDir(options.projectRoot));
    const adapter = new ClaudeCodeAdapter();
    this.supervisor = new Supervisor({ adapter, store: this.#store });
    // Tools close over the supervisor, so they are registered after it exists.
    for (const tool of workerTools(this.supervisor)) {
      this.supervisor.registerTool(tool);
    }
    for (const tool of orchestratorTools(this.supervisor)) {
      this.supervisor.registerTool(tool);
    }
  }

  async start(): Promise<void> {
    await this.#store.init();
    await this.supervisor.restore();

    // The supervisor ships its own web presentation. The default points at
    // this repository's `web/`, never at the managed project's files: a
    // worker's working directory must not become publicly served content.
    const webRoot =
      this.#options.webRoot ??
      resolve(import.meta.dirname, '../../../web');

    this.#server = await serve({
      supervisor: this.supervisor,
      host: this.#options.host,
      port: this.#options.port,
      webRoot: existsSync(webRoot) ? webRoot : undefined,
      terminal: new TmuxTransport(),
      onShutdown: () => {
        void this.close().then(() => process.exit(0));
      },
    });

    const orchestratorName = this.#options.orchestratorName ?? 'main';
    if (!this.supervisor.findByName(orchestratorName)) {
      await this.supervisor.openSession({
        name: orchestratorName,
        cwd: this.#options.projectRoot,
        purpose: ORCHESTRATOR_SYSTEM_PROMPT,
        model: this.#options.model,
        role: 'orchestrator',
      });
    }
    this.#relayAttention(orchestratorName);
  }

  get port(): number {
    return this.#server?.port ?? this.#options.port;
  }

  /**
   * Forward worker-settled notices into the main conversation.
   *
   * Routing is the orchestrator's job, so the supervisor does not decide what
   * a settled worker means. It only guarantees the fact arrives, once, in the
   * conversation that owns routing, so the person never has to poll. Notices
   * are coalesced: a burst of workers settling in the same turn becomes one
   * message instead of one interruption each.
   */
  #relayAttention(orchestratorName: string): void {
    let pending: string[] = [];
    let scheduled = false;

    this.supervisor.bus.subscribe((event) => {
      if (event.type !== 'attention') return;
      const session = this.supervisor.getSession(event.sessionId);
      if (!session) return;
      const line = `${session.name} settled (${event.reason})${
        event.summary ? `: ${event.summary.split('\n')[0]?.slice(0, 200)}` : ''
      }`;
      if (session.name === orchestratorName) return;
      pending.push(line);
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        const lines = pending;
        pending = [];
        scheduled = false;
        const main = this.supervisor.findByName(orchestratorName);
        if (!main || main.state === 'stopped') return;
        void this.supervisor
          .send(
            main.id,
            `Supervisor notice — workers settled:\n${lines.map((l) => `- ${l}`).join('\n')}\n\n` +
              'Decide what, if anything, the person needs to know or decide. Call list_attention for the full list. Do not reply if nothing needs them.',
          )
          .catch(() => undefined);
      }, 2000);
    });
  }

  async close(): Promise<void> {
    await this.supervisor.close();
    await this.#server?.close();
  }
}
