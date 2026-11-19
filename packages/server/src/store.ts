import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  LoggedEvent,
  PersistedState,
  StateStore,
} from '@supervisor/core';
import type { SessionEvent } from '@supervisor/protocol';

const EMPTY_STATE: PersistedState = { sessions: [], pendingDecisions: [] };

/**
 * File-backed state: a JSON snapshot for sessions plus a newline-delimited
 * event log.
 *
 * Writes are atomic per file (write, then rename) so a crash cannot leave a
 * truncated snapshot. The event log is append-only; a partial last line is
 * simply skipped on read.
 */
export class FileStore implements StateStore {
  readonly #dir: string;
  readonly #statePath: string;
  readonly #eventsPath: string;
  #seq = 0;

  constructor(dir: string) {
    this.#dir = dir;
    this.#statePath = join(dir, 'state.json');
    this.#eventsPath = join(dir, 'events.ndjson');
  }

  async init(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const events = await this.readEvents(0, Number.MAX_SAFE_INTEGER);
    this.#seq = events.at(-1)?.seq ?? 0;
  }  async load(): Promise<PersistedState> {
    try {
      const raw = await readFile(this.#statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return { ...EMPTY_STATE, ...parsed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_STATE };
      throw error;
    }
  }

  async save(state: PersistedState): Promise<void> {
    const tmp = `${this.#statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, this.#statePath);
  }

  async appendEvent(seq: number, event: SessionEvent): Promise<void> {
    const line = JSON.stringify({ seq, at: new Date().toISOString(), event });
    await appendFile(this.#eventsPath, `${line}\n`, 'utf8');
  }

  async lastSeq(): Promise<number> {
    return this.#seq;
  }

  async readEvents(afterSeq: number, limit: number): Promise<LoggedEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.#eventsPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: LoggedEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LoggedEvent;
        if (entry.seq <= afterSeq) continue;
        out.push(entry);
        if (out.length >= limit) break;
      } catch {
        // A torn trailing line from a crash is expected; skip it.
      }
    }
    return out;
  }
}

export const defaultStateDir = (projectRoot: string): string =>
  join(projectRoot, '.supervisor');

void dirname;
