import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { TreeManager } from './tree-manager.js';
import type { Session, TreeEvent } from './types.js';
import type { ProjectState } from './project-state.js';
import { SseHub } from './sse-hub.js';

/** Most recently created active session, falling back to the most recent overall. */
function pickDefaultSession(tm: TreeManager): Session | null {
  const sessions = tm.getAllSessions().sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return sessions.find((s) => s.status === 'open') ?? sessions[0] ?? null;
}

export interface MultiProjectContext {
  getProject: (projectDir: string) => ProjectState | undefined;
  getAllProjects: () => ProjectState[];
  getLastActiveProject: () => string | null;
  withLock: <T>(projectDir: string, fn: () => Promise<T>) => Promise<T>;
  onSseConnect: () => void;
  onSseDisconnect: () => void;
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = resolve(__dirname, '..', 'static');

let sirvHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

/** A running visualization server: the bound port and a teardown handle. */
export interface HttpServerHandle {
  port: number;
  close: () => Promise<void>;
}

/** Builds the snapshot event for a project's default session (null if no session). */
function snapshotEvent(tm: TreeManager): TreeEvent {
  const session = pickDefaultSession(tm);
  if (!session) return { type: 'snapshot', session: null as any, hypotheses: [] };
  const hypotheses = tm.getAllHypotheses().filter((h) => h.sessionId === session.id);
  return { type: 'snapshot', session, hypotheses };
}

/**
 * Start the HTTP visualization server. Pass port 0 for an OS-assigned
 * ephemeral port; the bound port is returned in the resolved handle.
 */
export async function startHttpServer(port: number, ctx: MultiProjectContext): Promise<HttpServerHandle> {
  const hub = new SseHub(ctx.onSseConnect, ctx.onSseDisconnect);

  // Subscribe a project (or re-subscribe after its TreeManager is replaced).
  function subscribeProject(state: ProjectState): void {
    hub.subscribeProject(state.projectDir, state.tm, () => snapshotEvent(state.tm));
  }

  for (const state of ctx.getAllProjects()) {
    subscribeProject(state);
  }

  // On each request, (re)subscribe any project whose TreeManager instance is
  // not the one currently wired — catches newly-registered and reloaded
  // (LRU-evicted then rebuilt) projects so their live events keep flowing.
  function ensureSubscribed(): void {
    for (const state of ctx.getAllProjects()) {
      if (!hub.isSubscribed(state.projectDir, state.tm)) {
        subscribeProject(state);
      }
    }
  }

  const keepaliveTimer = setInterval(() => hub.keepalive(), 30_000);
  keepaliveTimer.unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    // Ensure all projects are subscribed (catches newly registered ones)
    ensureSubscribed();

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/sse') {
      setCorsHeaders(res);
      handleSSE(req, res, url, ctx, hub);
      return;
    }

    if (url.pathname === '/api/state') {
      setCorsHeaders(res);
      await handleStateAPI(res, url, ctx);
      return;
    }

    if (url.pathname === '/api/sessions') {
      setCorsHeaders(res);
      handleSessionsAPI(res, url, ctx);
      return;
    }

    if (url.pathname === '/api/projects') {
      setCorsHeaders(res);
      handleProjectsAPI(res, ctx);
      return;
    }

    if (url.pathname === '/api/info') {
      setCorsHeaders(res);
      handleInfoAPI(res, ctx);
      return;
    }

    // Static file serving
    await serveStatic(req, res);
  });

  return new Promise<HttpServerHandle>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[tot-mcp] Warning: port ${port} in use, HTTP visualization disabled`);
      } else {
        console.error(`[tot-mcp] HTTP error: ${err.message}`);
      }
      clearInterval(keepaliveTimer);
      reject(err);
    });

    // listen(0) lets the OS assign a free port; read the bound port back from
    // address() so the caller can advertise the real URL.
    server.listen(port, 'localhost', () => {
      const boundPort = (server.address() as import('node:net').AddressInfo).port;
      console.error(`[tot-mcp] Visualization: http://localhost:${boundPort}`);
      resolve({
        port: boundPort,
        close: () => new Promise<void>((res) => {
          clearInterval(keepaliveTimer);
          // SSE responses are long-lived keep-alive streams; server.close()
          // only fires its callback once every connection ends, so without
          // forcibly closing them an open dashboard tab would hang shutdown
          // (and block process exit) indefinitely.
          server.closeAllConnections();
          server.close(() => res());
        }),
      });
    });
  });
}

function resolveProject(url: URL, ctx: MultiProjectContext): ProjectState | null {
  const projectParam = url.searchParams.get('project');
  if (projectParam) {
    const p = ctx.getProject(projectParam);
    return p ?? null;
  }
  // Default: most recently active project
  const last = ctx.getLastActiveProject();
  if (last) {
    return ctx.getProject(last) ?? null;
  }
  // Fallback: first registered project
  const all = ctx.getAllProjects();
  return all.length > 0 ? all[0] : null;
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();
}

function handleSSE(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: MultiProjectContext,
  hub: SseHub,
): void {
  writeSseHeaders(res);

  const project = resolveProject(url, ctx);
  if (!project) {
    // No project yet — park the client, recording which project (if any) it
    // asked for so a later flush binds it only to that project.
    hub.addWaiting(res, url.searchParams.get('project'));
    req.on('close', () => hub.removeClient(res));
    return;
  }

  // Send the initial snapshot, then register for live events on this project.
  res.write(`id: 0\ndata: ${JSON.stringify(snapshotEvent(project.tm))}\n\n`);
  hub.addClient(res, project.projectDir);
  req.on('close', () => hub.removeClient(res));
}

async function handleStateAPI(res: ServerResponse, url: URL, ctx: MultiProjectContext): Promise<void> {
  const project = resolveProject(url, ctx);
  if (!project) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: null, hypotheses: [] }));
    return;
  }

  const { tm, projectDir } = project;
  const requestedSessionId = url.searchParams.get('sessionId');

  // Lazy-load + read snapshot under the per-project lock so ensureSessionLoaded
  // (which writes the in-memory sessions/hypotheses Maps) cannot interleave
  // with an MCP handler mid-mutation.
  try {
    const payload = await ctx.withLock(projectDir, async () => {
      if (requestedSessionId) {
        project.ensureSessionLoaded(requestedSessionId);
      }

      const session: Session | null = requestedSessionId
        ? tm.getAllSessions().find((s) => s.id === requestedSessionId) ?? null
        : pickDefaultSession(tm);

      if (!session) return { session: null, hypotheses: [] };
      const hypotheses = tm.getAllHypotheses().filter((h) => h.sessionId === session.id);
      return { session, hypotheses };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'state-load-failed' }));
    console.error('[tot-mcp] handleStateAPI error:', err);
  }
}

function handleSessionsAPI(res: ServerResponse, url: URL, ctx: MultiProjectContext): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });

  const project = resolveProject(url, ctx);
  if (!project) {
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }

  const { tm, sessionIndex } = project;

  // If we have a session index, use it for the list (no full loading needed)
  if (sessionIndex.length > 0) {
    const loadedSessions = tm.getAllSessions();
    const loadedIds = new Set(loadedSessions.map((s) => s.id));

    const summaries: Array<{ id: string; problem: string; status: string; createdAt: string; nodeCount: number }> = [];

    // Add loaded sessions with accurate node counts
    for (const s of loadedSessions) {
      const hypotheses = tm.getAllHypotheses().filter((h) => h.sessionId === s.id);
      summaries.push({
        id: s.id,
        problem: s.problem,
        status: s.status,
        createdAt: s.createdAt,
        nodeCount: hypotheses.length,
      });
    }

    // Add unloaded sessions from the index
    for (const entry of sessionIndex) {
      if (!loadedIds.has(entry.id)) {
        summaries.push({
          id: entry.id,
          problem: entry.problem,
          status: entry.status,
          createdAt: entry.createdAt,
          nodeCount: entry.nodeCount,
        });
      }
    }

    summaries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.end(JSON.stringify({ sessions: summaries }));
    return;
  }

  // Fallback: no session index
  const sessions = tm.getAllSessions().sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const summaries = sessions.map((s) => {
    const hypotheses = tm.getAllHypotheses().filter((h) => h.sessionId === s.id);
    return {
      id: s.id,
      problem: s.problem,
      status: s.status,
      createdAt: s.createdAt,
      nodeCount: hypotheses.length,
    };
  });
  res.end(JSON.stringify({ sessions: summaries }));
}

function handleProjectsAPI(res: ServerResponse, ctx: MultiProjectContext): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });

  const projects = ctx.getAllProjects().map((p) => {
    const openSessions = p.tm.getAllSessions().filter((s) => s.status === 'open');
    const latestOpen = openSessions.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    return {
      dir: p.projectDir,
      activeProblem: latestOpen?.problem ?? null,
      sessionCount: p.sessionIndex.length || p.tm.getAllSessions().length,
    };
  });

  res.end(JSON.stringify({ projects, lastActive: ctx.getLastActiveProject() }));
}

function handleInfoAPI(res: ServerResponse, ctx: MultiProjectContext): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });

  const projects = ctx.getAllProjects().map((p) => {
    const openSessions = p.tm.getAllSessions().filter((s) => s.status === 'open');
    const latestOpen = openSessions.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    return {
      dir: p.projectDir,
      activeProblem: latestOpen?.problem ?? null,
      sessionCount: p.sessionIndex.length || p.tm.getAllSessions().length,
      persistenceHealthy: p.persistenceHealthy,
    };
  });

  const lastActive = ctx.getLastActiveProject();

  res.end(JSON.stringify({
    projectDir: lastActive || (projects.length > 0 ? projects[0].dir : ''),
    projects,
    lastActive,
  }));
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!existsSync(STATIC_DIR)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>tot-mcp</h1><p>Web UI not built yet. Run <code>npm run build</code> in packages/web-ui.</p></body></html>');
    return;
  }

  // Create cached sirv handler once. Serve the built bundle with ETags and
  // long-lived caching (hashed asset names make immutable safe) so unchanged
  // assets get a 304 instead of a full refetch on every load.
  if (!sirvHandler) {
    try {
      const mod = await import('sirv');
      sirvHandler = mod.default(STATIC_DIR, { single: true, etag: true, maxAge: 31536000, immutable: true });
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Static file serving unavailable (sirv not installed)');
      return;
    }
  }

  sirvHandler(req, res);
}
