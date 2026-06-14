import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { TreeManager } from './tree-manager.js';
import type { Session, TreeEvent } from './types.js';
import type { ProjectState } from './daemon.js';

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

/**
 * Start the HTTP server for multi-project visualization.
 * Returns the actual port the server is listening on.
 */
export async function startHttpServer(port: number, ctx: MultiProjectContext): Promise<number> {
  // Track SSE clients per project
  const sseClients = new Map<string, Set<ServerResponse>>(); // projectDir → clients
  const eventCounters = new Map<string, number>(); // projectDir → eventId
  // Clients connected before their project existed. The value is the project
  // they requested via ?project= (null = no preference), so the flush only
  // binds a client to the project it actually wanted.
  const waitingClients = new Map<ServerResponse, string | null>();
  // The TreeManager instance currently subscribed per project. After an LRU
  // eviction the daemon rebuilds a project with a fresh TreeManager; tracking
  // the instance lets ensureSubscribed detect the swap and re-wire the listener
  // (a projectDir-only check would wrongly treat the stale entry as live).
  const subscribedManagers = new Map<string, TreeManager>();
  const subscribedListeners = new Map<string, (event: TreeEvent) => void>();

  // Subscribe to tree events for all registered (and future) projects
  function subscribeProject(state: ProjectState): void {
    const { projectDir, tm } = state;
    if (!sseClients.has(projectDir)) {
      sseClients.set(projectDir, new Set());
      eventCounters.set(projectDir, 0);
    }
    // Remove a listener bound to a previous (evicted) manager so it can be GC'd
    // and stops firing into a stale closure.
    const priorTm = subscribedManagers.get(projectDir);
    const priorListener = subscribedListeners.get(projectDir);
    if (priorTm && priorListener && priorTm !== tm) {
      priorTm.removeListener('event', priorListener);
    }

    const listener = (event: TreeEvent) => {
      // Flush waiting clients onto this project — but only those that did not
      // ask for a *different* project. A client that named another project via
      // ?project= stays waiting until its own project fires/registers, so it
      // is never bound to the wrong tree.
      if (waitingClients.size > 0) {
        const clients = sseClients.get(projectDir)!;
        for (const [wc, requested] of waitingClients) {
          if (requested && requested !== projectDir) continue;
          clients.add(wc);
          waitingClients.delete(wc);
          const session = pickDefaultSession(tm);
          if (session) {
            const hypotheses = tm.getAllHypotheses().filter((h) => h.sessionId === session.id);
            const snapshot: TreeEvent = { type: 'snapshot', session, hypotheses };
            try { wc.write(`id: 0\ndata: ${JSON.stringify(snapshot)}\n\n`); } catch { clients.delete(wc); }
          }
        }
      }

      const clients = sseClients.get(projectDir);
      if (!clients || clients.size === 0) return;

      const counter = (eventCounters.get(projectDir) || 0) + 1;
      eventCounters.set(projectDir, counter);

      const data = `id: ${counter}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const client of clients) {
        try {
          client.write(data);
        } catch {
          clients.delete(client);
        }
      }
    };

    tm.on('event', listener);
    subscribedManagers.set(projectDir, tm);
    subscribedListeners.set(projectDir, listener);
  }

  // Subscribe existing projects and set up a poll for new ones
  for (const state of ctx.getAllProjects()) {
    subscribeProject(state);
  }

  // Check for new projects every time a request comes in (lightweight). Also
  // re-subscribe a project whose TreeManager was replaced (LRU eviction then
  // reload builds a fresh instance) so its live events keep reaching clients.
  function ensureSubscribed(): void {
    for (const state of ctx.getAllProjects()) {
      if (subscribedManagers.get(state.projectDir) !== state.tm) {
        subscribeProject(state);
      }
    }
  }

  // SSE keepalive every 30s
  setInterval(() => {
    for (const [, clients] of sseClients) {
      for (const client of clients) {
        try {
          client.write(': keepalive\n\n');
        } catch {
          clients.delete(client);
        }
      }
    }
    for (const client of waitingClients.keys()) {
      try {
        client.write(': keepalive\n\n');
      } catch {
        waitingClients.delete(client);
      }
    }
  }, 30_000).unref();

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
      handleSSE(req, res, url, ctx, sseClients, waitingClients);
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
    await serveStatic(req, res, url);
  });

  return new Promise<number>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[tot-mcp] Warning: port ${port} in use, HTTP visualization disabled`);
      } else {
        console.error(`[tot-mcp] HTTP error: ${err.message}`);
      }
      reject(err);
    });

    server.listen(port, 'localhost', () => {
      console.error(`[tot-mcp] Visualization: http://localhost:${port}`);
      resolve(port);
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

function handleSSE(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: MultiProjectContext,
  sseClients: Map<string, Set<ServerResponse>>,
  waitingClients: Map<ServerResponse, string | null>,
): void {
  const project = resolveProject(url, ctx);
  if (!project) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();
    // No project yet — record which project (if any) this client asked for so
    // the flush only binds it to that project, never an unrelated one.
    waitingClients.set(res, url.searchParams.get('project'));
    ctx.onSseConnect();
    req.on('close', () => { waitingClients.delete(res); ctx.onSseDisconnect(); });
    return;
  }

  const { projectDir, tm } = project;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  // Send initial snapshot.
  const session = pickDefaultSession(tm);
  if (session) {
    const hypotheses = tm.getAllHypotheses().filter((h) => h.sessionId === session.id);
    const snapshot: TreeEvent = { type: 'snapshot', session, hypotheses };
    res.write(`id: 0\ndata: ${JSON.stringify(snapshot)}\n\n`);
  } else {
    const empty: TreeEvent = { type: 'snapshot', session: null as any, hypotheses: [] };
    res.write(`id: 0\ndata: ${JSON.stringify(empty)}\n\n`);
  }

  // Register client for this project
  if (!sseClients.has(projectDir)) {
    sseClients.set(projectDir, new Set());
  }
  sseClients.get(projectDir)!.add(res);
  ctx.onSseConnect();

  req.on('close', () => {
    sseClients.get(projectDir)?.delete(res);
    ctx.onSseDisconnect();
  });
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

async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
