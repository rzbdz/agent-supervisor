import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A terminal transport: one attachable view of a session's native agent.
 *
 * The supervisor's core never imports tmux. This port is what a relay or an
 * ssh transport will implement later, without touching routes or the panel.
 */
export interface AttachSpec {
  sessionId: string;
  /** Directory the agent works in; the terminal opens there. */
  cwd: string;
  /** Window label a person would recognize. */
  label: string;
  cols: number;
  rows: number;
}

export interface AttachHandle {
  readonly id: string;
  readonly windowLabel: string;
  /** What a human could type to attach themselves. */
  readonly attachCommand: string;
  readonly cols: number;
  readonly rows: number;
  resize(cols: number, rows: number): Promise<void>;
  /** Inject bytes as terminal input. */
  input(bytes: Uint8Array): Promise<void>;
  /** Output bytes, live, until the view is closed. */
  output(): AsyncIterable<Uint8Array>;
  /** Detach the view only; a working agent keeps running. */
  close(): Promise<void>;
}

export interface TerminalTransport {
  readonly kind: 'tmux' | 'relay' | 'ssh';
  open(spec: AttachSpec): Promise<AttachHandle>;
  /** Remove whatever the transport keeps for a session. */
  reap?(sessionId: string): Promise<void>;
}

/**
 * The default tmux configuration shipped with the plugin.
 *
 * Deliberately plain: no mouse mode, no status-line decorations, a large
 * scrollback, and truecolor, so a remote viewer sees the agent's own output
 * rather than a themed approximation of it.
 */
export const STANDARD_TMUX_CONF = `
set -g default-terminal "tmux-256color"
set -gq terminal-overrides ",*:Tc"
set -g history-limit 50000
set -g status off
set -g mouse off
set -g escape-time 10
set -g focus-events on
set -gq allow-passthrough on
`.trim();

/** A tmux server dedicated to the supervisor, so it cannot touch user sessions. */
const TMUX_SOCKET = 'supervisor';
const TMUX_SESSION = 'sup';

async function tmux(args: string[], input?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', ['-L', TMUX_SOCKET, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Opens one tmux window per agent session and streams its pane bytes.
 *
 * `pipe-pane` writes the pane's output to a FIFO that this class tails; input
 * goes back through `send-keys -H`. Closing the handle stops the pipe but
 * leaves the window (and the agent inside it) alive.
 */
export class TmuxTransport implements TerminalTransport {
  readonly kind = 'tmux' as const;
  #confPath: string | null = null;

  async #ensureConf(): Promise<string> {
    if (this.#confPath) return this.#confPath;
    const dir = await mkdtemp(join(tmpdir(), 'supervisor-tmux-'));
    this.#confPath = join(dir, 'tmux.conf');
    await writeFile(this.#confPath, STANDARD_TMUX_CONF, 'utf8');
    return this.#confPath;
  }

  async open(spec: AttachSpec): Promise<AttachHandle> {
    const conf = await this.#ensureConf();
    const window = spec.label;
    // Create the dedicated server/session on first use. `has-session`
    // succeeds only once the server is up.
    const has = await tmux(['has-session', '-t', TMUX_SESSION]);
    if (has.code !== 0) {
      await tmux(['-f', conf, 'new-session', '-d', '-s', TMUX_SESSION, '-n', window, '-c', spec.cwd]);
    }
    const exists = await tmux(['list-windows', '-t', `${TMUX_SESSION}:${window}`]);
    if (exists.code !== 0) {
      await tmux(['new-window', '-d', '-t', TMUX_SESSION, '-n', window, '-c', spec.cwd]);
    }
    const target = `${TMUX_SESSION}:${window}`;
    await tmux(['resize-window', '-t', target, '-x', String(spec.cols), '-y', String(spec.rows)]);
    // Keep every pane (the window's only pane) at the requested size.
    const pane = (await tmux(['display-message', '-p', '-t', target, '#{pane_id}'])).stdout.trim();
    if (pane) {
      await tmux(['resize-pane', '-t', pane, '-x', String(spec.cols), '-y', String(spec.rows)]).catch(() => undefined);
    }
    return new TmuxAttach(spec, target, pane, conf);
  }

  async reap(sessionId: string): Promise<void> {
    await tmux(['kill-window', '-t', `${TMUX_SESSION}:${sessionId}`]).catch(() => undefined);
  }
}

/**
 * One live view of a tmux window.
 *
 * Output is captured with `tmux capture-pane -p -J` on a short interval while
 * the view is open. Polling rather than `pipe-pane` keeps the transport
 * dependency-free (no FIFO setup, no extra files) and is sufficient for an
 * operator watching an agent; the transport port hides the difference from a
 * future byte-accurate relay.
 */
class TmuxAttach implements AttachHandle {
  readonly id: string;
  readonly windowLabel: string;
  readonly attachCommand: string;
  readonly cols: number;
  readonly rows: number;
  #closed = false;
  #last = '';
  #wake: (() => void) | null = null;

  constructor(
    spec: AttachSpec,
    readonly target: string,
    readonly pane: string,
    readonly confPath: string,
  ) {
    this.id = spec.sessionId;
    this.windowLabel = spec.label;
    this.cols = spec.cols;
    this.rows = spec.rows;
    this.attachCommand = `tmux -L ${TMUX_SOCKET} -f ${confPath} attach -t ${target}`;
  }

  async resize(cols: number, rows: number): Promise<void> {
    // Window size is the shared truth; the pane follows it.
    await tmux(['resize-window', '-t', this.target, '-x', String(cols), '-y', String(rows)]);
  }

  async input(bytes: Uint8Array): Promise<void> {
    if (!bytes.length) return;
    // `-H` takes hex byte pairs, which survives control characters and
    // backslashes that `send-keys` would otherwise interpret.
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    await tmux(['send-keys', '-t', this.target, '-H', ...hex.split(' ')]);
  }

  async *output(): AsyncIterable<Uint8Array> {
    while (!this.#closed) {
      const captured = await tmux([
        'capture-pane',
        '-p',
        '-J',
        '-t', this.target,
      ]).catch(() => ({ stdout: '', stderr: '', code: 1 }));
      if (captured.code === 0) {
        // Send a full frame only when the screen changed. A real terminal
        // stream would send deltas; for an operator view this is enough and
        // keeps the client trivial.
        const frame = `${captured.stdout}\u0000`;
        if (frame !== this.#last) {
          this.#last = frame;
          yield new TextEncoder().encode(frame);
        }
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        setTimeout(resolve, 250);
      });
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#wake?.();
  }
}
