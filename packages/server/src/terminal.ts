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
  /**
   * The agent's own native session, when it has one.
   *
   * A view of a live agent shows that agent; a view of a stopped one resumes
   * the same conversation in the terminal, so the person takes over exactly
   * where the agent left off rather than in an empty shell.
   */
  nativeSessionId?: string;
  /** Whether the supervisor still owns a running agent process. */
  live: boolean;
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
# Terminal identity. Truecolor plus the tmux terminfo entry keeps agent output
# (spinners, diffs, syntax colors) faithful.
set -g default-terminal "tmux-256color"
set -gq terminal-overrides ",*:Tc"
set -g escape-time 10
set -g focus-events on
set -gq allow-passthrough on

# Scrollback: an operator reads back through an agent's work.
set -g history-limit 50000

# Mouse: focus follows clicks, the wheel scrolls, selection works with the
# mouse, and the right button opens a small copy/paste menu instead of tmux's
# default key table.
set -g mouse on
set -g mode-keys vi
set -gq set-clipboard on
unbind -n MouseDown3Pane
bind -n MouseDown3Pane display-menu -T "#[align=centre]Pane" \
  "Copy selection" c { copy-pipe-and-cancel "wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null || pbcopy" } \
  "Paste" p { paste-buffer -p } \
  "Clear screen" C { send-keys C-l } \
  "Scroll mode" s { copy-mode } \
  "Detach" d { detach-client }

# Window switching and pane basics without a prefix fight.
set -g base-index 0
setw -g pane-base-index 0
set -g renumber-windows on

# Status line: quiet, but shows the session and window so screenshots are
# self-explanatory.
set -g status on
set -g status-interval 5
set -g status-style "bg=default,fg=default"
set -g status-left "#[bold] #{session_name} "
set -g status-right "#[dim] #{window_name} #[bold]| %H:%M "
set -g status-justify left
setw -g window-status-current-style "fg=colour39,bold"

# Copy mode, in vi keys with a visible selection.
setw -g mode-keys vi
bind -T copy-mode-vi v send-keys -X begin-selection
bind -T copy-mode-vi y send-keys -X copy-pipe-and-cancel "wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null || pbcopy"
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
    // A stopped agent is taken over: the window runs the agent's own resume
    // command, so the terminal is the conversation, not a bare shell. A live
    // agent's window is a mirror of its transcript (see `output()`), because
    // the supervisor's process owns that agent's stdin.
    const nativeId = spec.nativeSessionId;
    if (!spec.live && nativeId) {
      const started = await tmux(['show-options', '-w', '-t', target, '-v', '@sv_resumed'])
        .catch(() => ({ stdout: '', stderr: '', code: 1 }));
      if (started.stdout.trim() !== nativeId) {
        await tmux(['send-keys', '-t', target, `claude --resume ${nativeId}`, 'C-m']);
        await tmux(['set-options', '-w', '-t', target, '@sv_resumed', nativeId]);
      }
    }
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
  #transcriptOffset = 0;
  #mirrorText = '';
  /** 'live' while the supervisor owns the agent's stdin: read-only mirror. */
  readonly mirror: '' | 'live';
  readonly transcriptPath?: string;

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
    this.transcriptPath = spec.live && spec.nativeSessionId
      ? transcriptPath(spec.cwd, spec.nativeSessionId)
      : undefined;
    this.mirror = spec.live && spec.nativeSessionId ? 'live' : '';
  }

  async resize(cols: number, rows: number): Promise<void> {
    // Window size is the shared truth; the pane follows it.
    await tmux(['resize-window', '-t', this.target, '-x', String(cols), '-y', String(rows)]);
  }

  async input(bytes: Uint8Array): Promise<void> {
    // A live agent's stdin belongs to the supervisor's process; typing there
    // would fight it. The view is read-only until the agent settles.
    if (this.mirror && bytes.length) return;
    if (!bytes.length) return;
    // `-H` takes hex byte pairs, which survives control characters and
    // backslashes that `send-keys` would otherwise interpret.
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    await tmux(['send-keys', '-t', this.target, '-H', ...hex.split(' ')]);
  }

  async *output(): AsyncIterable<Uint8Array> {
    // A live agent's window mirrors its own transcript: the person watches the
    // real conversation, and the supervisor's process keeps sole ownership of
    // the agent's stdin.
    if (this.transcriptPath) {
      yield* this.#mirrorTranscript();
      return;
    }
    while (!this.#closed) {
      const captured = await tmux([
        'capture-pane',
        '-p',
        '-e',   // keep SGR sequences: the client is a real terminal now
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

  /** Read the agent's JSONL as it grows and re-render the visible screen. */
  async *#mirrorTranscript(): AsyncIterable<Uint8Array> {
    const { open } = await import('node:fs/promises');
    while (!this.#closed) {
      try {
        const handle = await open(this.transcriptPath!, 'r');
        const stat = await handle.stat();
        if (stat.size > this.#transcriptOffset) {
          const length = stat.size - this.#transcriptOffset;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, this.#transcriptOffset);
          this.#transcriptOffset = stat.size;
          this.#mirrorText += buffer.toString('utf8');
        }
        await handle.close();
      } catch {
        // The transcript appears once the agent writes its first entry.
      }
      const frame = renderTranscriptScreen(this.#mirrorText, this.cols, this.rows);
      if (frame !== this.#last) {
        this.#last = frame;
        yield new TextEncoder().encode(`${frame}\u0000`);
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        setTimeout(resolve, 400);
      });
    }
  }
}

/** Claude Code's transcript location for one native session. */
function transcriptPath(cwd: string, nativeSessionId: string): string {
  const home = process.env.HOME ?? '';
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return join(home, '.claude', 'projects', slug, `${nativeSessionId}.jsonl`);
}

/**
 * Render transcript entries into a screen-sized text view.
 *
 * Deliberately a plain transcript, not a terminal emulator: a person reading
 * an agent wants its messages and tool calls, and pretending to redraw an ANSI
 * pane here would make the real tmux path harder to reason about.
 */
/**
 * Render the agent transcript for a live terminal.
 *
 * The frames use ordinary ANSI so a real terminal renderer (xterm.js) shows
 * roles and tool calls in place, without the client parsing JSONL itself.
 */
function renderTranscriptScreen(raw: string, cols: number, rows: number): string {
  const ESC = '\u001b[';
  const roles: Record<string, string> = {
    assistant: `${ESC}36m`,
    user: `${ESC}33m`,
    tool: `${ESC}90m`,
  };
  const reset = `${ESC}0m`;
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const tint = roles[entry.type ?? ''] ?? '';
    const content = entry.message?.content;
    if (typeof content === 'string') {
      lines.push(`${tint}[${entry.type}]${reset} ${content}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) {
      if (block.type === 'text' && block.text) {
        lines.push(`${tint}[${entry.type}]${reset} ${block.text}`);
      } else if (block.type === 'tool_use') {
        lines.push(`${ESC}90m  → ${block.name} ${JSON.stringify(block.input ?? {}).slice(0, 160)}${reset}`);
      }
    }
  }
  const wrapped: string[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.length; i += cols) wrapped.push(line.slice(i, i + cols));
  }
  return wrapped.slice(-rows).join('\n');
}
