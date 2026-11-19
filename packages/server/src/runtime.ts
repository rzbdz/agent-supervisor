import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Supervisor, orchestratorTools, workerTools } from '@supervisor/core';
import { ClaudeCodeAdapter } from '@supervisor/agent-claude';
import { FileStore, defaultStateDir } from './store.ts';
import { serve } from './http.ts';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './orchestrator.ts';

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
  }

  get port(): number {
    return this.#server?.port ?? this.#options.port;
  }

  async close(): Promise<void> {
    await this.supervisor.close();
    await this.#server?.close();
  }
}
