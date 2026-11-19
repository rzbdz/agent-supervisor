import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Supervisor } from '@supervisor/core';
import {
  asDecisionId,
  asSessionId,
  asWorkspaceId,
  decisionAnswerSchema,
} from '@supervisor/protocol';
import type { AttachHandle, TerminalTransport } from './terminal.ts';

export interface ServeOptions {
  supervisor: Supervisor;
  host: string;
  port: number;
  /** Optional directory of built presentation assets. */
  webRoot?: string;
  /** Invoked by `POST /api/admin/shutdown`; lets a CLI stop the daemon. */
  onShutdown?: () => void;
  /** Live terminal views of agent sessions; tmux by default. */
  terminal?: TerminalTransport;
}

/**
 * The presentation boundary.
 *
 * One small HTTP + SSE server. The CLI, a future dashboard and a future IM
 * gateway all talk to the same endpoints, so none of them need privileged
 * access to the supervisor object.
 *
 * - REST for reads and for human actions (answer a decision, send a message).
 * - Server-sent events for the live stream. SSE rather than WebSocket: it is
 *   one-way by design, needs no handshake library, and survives proxies.
 */
export function serve(options: ServeOptions): Promise<{ close(): Promise<void>; port: number }> {
  const { supervisor } = options;
  const attachments = new Map<string, AttachHandle>();

  /** Open once per session; a second request reuses the live view. */
  async function attachFor(
    transport: TerminalTransport,
    id: import('@supervisor/protocol').SessionId,
    session: { name: string; cwd: string },
    size: { cols: number; rows: number },
  ): Promise<AttachHandle> {
    const existing = attachments.get(id);
    if (existing) return existing;
    const handle = await transport.open({
      sessionId: id,
      cwd: session.cwd,
      label: session.name,
      cols: size.cols,
      rows: size.rows,
    });
    attachments.set(id, handle);
    return handle;
  }

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, options);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    opts: ServeOptions,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (path === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/api/admin/shutdown' && req.method === 'POST') {
      sendJson(res, 202, { ok: true });
      setImmediate(() => opts.onShutdown?.());
      return;
    }

    if (path === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, {
        workspaces: supervisor.listWorkspaces(),
        sessions: supervisor.listSessions(),
        decisions: supervisor.decisions.list(),
      });
    }

    if (path === '/api/workspaces' && req.method === 'GET') {
      return sendJson(res, 200, supervisor.listWorkspaces());
    }

    if (path === '/api/workspaces' && req.method === 'POST') {
      const body = await readJson(req);
      const workspace = await supervisor.registerWorkspace({
        name: String(body.name),
        root: String(body.root),
        description: body.description ? String(body.description) : undefined,
      });
      return sendJson(res, 201, workspace);
    }

    if (path === '/api/sessions' && req.method === 'GET') {
      return sendJson(res, 200, supervisor.listSessions());
    }

    if (path === '/api/sessions' && req.method === 'POST') {
      const body = await readJson(req);
      const session = await supervisor.openSession({
        name: String(body.name),
        cwd: String(body.cwd),
        purpose: body.purpose ? String(body.purpose) : undefined,
        model: body.model ? String(body.model) : undefined,
        role: body.role === 'orchestrator' ? 'orchestrator' : 'worker',
        agentRole: body.agentRole ? String(body.agentRole) : undefined,
        permissionMode: body.permissionMode ? (String(body.permissionMode) as never) : undefined,
        workspaceId: body.workspaceId
          ? asWorkspaceId(String(body.workspaceId))
          : undefined,
        task: body.task ? String(body.task) : undefined,
      });
      return sendJson(res, 201, session);
    }

    // Action segments may contain hyphens (`permission-mode`), so the pattern
    // must allow them; `[a-z]+` silently 404s such routes.
    const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
    if (sessionMatch) {
      const id = asSessionId(decodeURIComponent(sessionMatch[1]!));
      const action = sessionMatch[2];
      if (!action && req.method === 'GET') {
        const session = supervisor.getSession(id);
        return session ? sendJson(res, 200, session) : sendJson(res, 404, { error: 'not found' });
      }
      if (action === 'messages' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.text) return sendJson(res, 400, { error: 'text is required' });
        await supervisor.send(id, String(body.text));
        return sendJson(res, 202, { ok: true });
      }
      if (action === 'permission-mode' && req.method === 'POST') {
        const body = await readJson(req);
        const mode = String(body.mode);
        if (!['auto', 'default', 'plan', 'acceptEdits'].includes(mode)) {
          return sendJson(res, 400, { error: 'invalid mode' });
        }
        await supervisor.setPermissionMode(id, mode as never);
        return sendJson(res, 202, { ok: true, mode });
      }
      if (action === 'interrupt' && req.method === 'POST') {
        await supervisor.interrupt(id);
        return sendJson(res, 202, { ok: true });
      }
      if (action === 'stop' && req.method === 'POST') {
        await supervisor.stop(id);
        return sendJson(res, 202, { ok: true });
      }
      if (action === 'events' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const events = await supervisor.sessionEvents(id, limit);
        return sendJson(res, 200, events);
      }
    }

    // --- terminal attach -------------------------------------------------
    // One live view per session. The view is keyed by session so reopening
    // the panel reuses the same tmux window instead of spawning a second one.
    const attachMatch = /^\/api\/sessions\/([^/]+)\/attach(?:\/(input|resize|stream|transcript))?$/.exec(path);
    if (attachMatch) {
      const id = asSessionId(decodeURIComponent(attachMatch[1]!));
      const action = attachMatch[2];
      const session = supervisor.getSession(id);
      if (!session) return sendJson(res, 404, { error: 'no such session' });
      const transport = opts.terminal;
      if (!transport) return sendJson(res, 501, { error: 'no terminal transport configured' });

      if (!action && req.method === 'POST') {
        const body = await readJson(req);
        const handle = await attachFor(transport, id, session, {
          cols: Number(body.cols ?? 120),
          rows: Number(body.rows ?? 32),
        });
        return sendJson(res, 200, {
          transport: transport.kind,
          sessionId: id,
          windowLabel: handle.windowLabel,
          attachCommand: handle.attachCommand,
          cols: handle.cols,
          rows: handle.rows,
        });
      }
      if (action === 'input' && req.method === 'POST') {
        const handle = attachments.get(id);
        if (!handle) return sendJson(res, 409, { error: 'not attached' });
        const body = await readJson(req);
        const text = typeof body.text === 'string' ? body.text : '';
        await handle.input(new TextEncoder().encode(text));
        return sendJson(res, 202, { ok: true });
      }
      if (action === 'resize' && req.method === 'POST') {
        const handle = attachments.get(id);
        if (!handle) return sendJson(res, 409, { error: 'not attached' });
        const body = await readJson(req);
        await handle.resize(Number(body.cols ?? 120), Number(body.rows ?? 32));
        return sendJson(res, 202, { ok: true });
      }
      if (action === 'stream' && req.method === 'GET') {
        const handle = attachments.get(id);
        if (!handle) return sendJson(res, 409, { error: 'not attached' });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        let closed = false;
        req.on('close', () => {
          closed = true;
          void handle.close();
          attachments.delete(id);
        });
        const write = (data: string) => {
          if (closed) return;
          // Frames are screen text with a NUL terminator; JSON keeps newlines
          // and control bytes intact through the SSE envelope.
          res.write(`data: ${JSON.stringify({ frame: data })}\n\n`);
        };
        try {
          for await (const chunk of handle.output()) {
            write(new TextDecoder().decode(chunk));
          }
        } catch {
          // A detached tmux window ends the stream; the panel re-attaches.
        }
        res.end();
        return;
      }
      if (action === 'transcript' && req.method === 'GET') {
        // The agent keeps its own transcript; the panel reads the native one.
        const transcript = await readNativeTranscript(session, Number(url.searchParams.get('limit') ?? 200));
        return sendJson(res, 200, transcript);
      }
    }

    if (path === '/api/decisions' && req.method === 'GET') {
      const status = url.searchParams.get('status');
      return sendJson(
        res,
        200,
        supervisor.decisions.list(status ? { status: status as never } : {}),
      );
    }

    const decisionMatch = /^\/api\/decisions\/([^/]+)\/answer$/.exec(path);
    if (decisionMatch && req.method === 'POST') {
      const id = asDecisionId(decodeURIComponent(decisionMatch[1]!));
      const parsed = decisionAnswerSchema.safeParse(await readJson(req));
      if (!parsed.success) {
        return sendJson(res, 400, { error: 'invalid answer', issues: parsed.error.issues });
      }
      const decision = supervisor.answerDecision(id, parsed.data);
      return sendJson(res, 200, { decision });
    }

    if (path === '/api/events' && req.method === 'GET') {
      return streamEvents(req, res, supervisor);
    }

    if (opts.webRoot && req.method === 'GET') {
      const file = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const resolved = join(opts.webRoot, file);
      if (!resolved.startsWith(opts.webRoot)) return sendJson(res, 403, { error: 'forbidden' });
      try {
        const data = await readFile(resolved);
        res.writeHead(200, { 'content-type': contentType(resolved) });
        res.end(data);
        return;
      } catch {
        // Fall through to 404.
      }
    }

    return sendJson(res, 404, { error: 'not found', path });
  }

  function streamEvents(
    req: IncomingMessage,
    res: ServerResponse,
    sup: Supervisor,
  ): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // A reconnecting client may ask to resume after a sequence number.
    const lastId = req.headers['last-event-id'];
    let lastSeq = typeof lastId === 'string' ? Number(lastId) || 0 : 0;
    let closed = false;

    const write = (id: number, data: unknown) => {
      if (closed) return;
      res.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Replay what the client missed, then follow live.
    void sup
      .readEvents(lastSeq, 10_000)
      .then((events) => {
        for (const entry of events) {
          lastSeq = entry.seq;
          write(entry.seq, entry.event);
        }
      })
      .catch(() => undefined);

    const unsubscribe = sup.bus.subscribe((event, seq) => {
      lastSeq = Math.max(lastSeq, seq);
      write(seq, event);
    });
    const keepAlive = setInterval(() => {
      if (!closed) res.write(': keep-alive\n\n');
    }, 15_000);
    req.on('close', () => {
      closed = true;
      clearInterval(keepAlive);
      unsubscribe();
    });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    etag: createHash('sha1').update(payload).digest('base64url'),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function contentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

/**
 * Read a session's native agent transcript.
 *
 * The agent owns its transcript; the supervisor only locates it. Claude Code
 * writes `~/.claude/projects/<slug>/<session-id>.jsonl`, where the slug is the
 * working directory with non-alphanumerics replaced by `-`. Parsing is
 * tolerant: a torn last line or an unknown entry type is skipped, never fatal.
 */
async function readNativeTranscript(
  session: { nativeSessionId?: string; cwd: string; name: string },
  limit: number,
): Promise<{ session: string; entries: Array<{ role: string; kind: string; text: string; at?: string }> }> {
  const empty = { session: session.name, entries: [] };
  if (!session.nativeSessionId) return empty;
  const home = process.env.HOME ?? '';
  const slug = session.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const path = join(home, '.claude', 'projects', slug, `${session.nativeSessionId}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return empty;
  }
  const entries: Array<{ role: string; kind: string; text: string; at?: string }> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: {
      type?: string;
      timestamp?: string;
      isSidechain?: boolean;
      message?: { role?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    const content = entry.message?.content;
    if (typeof content === 'string') {
      entries.push({ role: entry.type ?? '?', kind: 'text', text: content, at: entry.timestamp });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: string; name?: string; input?: unknown; content?: unknown }>) {
      if (block.type === 'text' && block.text) {
        entries.push({ role: entry.type ?? '?', kind: 'text', text: block.text, at: entry.timestamp });
      } else if (block.type === 'tool_use') {
        entries.push({
          role: entry.type ?? '?',
          kind: `tool:${block.name ?? '?'}`,
          text: JSON.stringify(block.input ?? {}).slice(0, 2000),
          at: entry.timestamp,
        });
      } else if (block.type === 'tool_result') {
        const text = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? (block.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
            : '';
        entries.push({ role: 'tool', kind: 'result', text: text.slice(0, 2000), at: entry.timestamp });
      }
    }
  }
  return { session: session.name, entries: entries.slice(-limit) };
}
