import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { TreeManager } from './tree-manager.js';
import type { TreeEvent } from './types.js';
import type { ProjectState } from './daemon.js';

export interface MultiProjectContext {
  getProject: (projectDir: string) => ProjectState | undefined;
  getAllProjects: () => ProjectState[];
  getLastActiveProject: () => string | null;
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
  const waitingClients = new Set<ServerResponse>(); // clients connected before any project exists

  // Subscribe to tree events for all registered (and future) projects
  function subscribeProject(state: ProjectState): void {
    const { projectDir, tm } = state;
    if (!sseClients.has(projectDir)) {
      sseClients.set(projectDir, new Set());
      eventCounters.set(projectDir, 0);
    }

    tm.on('event', (event: TreeEvent) => {
      // Flush waiting clients: subscribe them to the first project that fires an event
      if (waitingClients.size > 0) {
        const clients = sseClients.get(projectDir)!;
        for (const wc of waitingClients) {
          clients.add(wc);
          // Send snapshot to the waiting client
          const sessions = tm.getAllSessions().sort((a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
          const session = sessions.find((s) => s.status === 'active') ?? sessions[0];
          if (session) {
            const hypotheses = tm.getAllHypotheses().filter((h) => h.sessionId === session.id);
            const snapshot: TreeEvent = { type: 'snapshot', session, hypotheses };
            try { wc.write(`id: 0\ndata: ${JSON.stringify(snapshot)}\n\n`); } catch { clients.delete(wc); }
          }
        }
        waitingClients.clear();
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
    });
  }

  // Subscribe existing projects and set up a poll for new ones
  for (const state of ctx.getAllProjects()) {
    subscribeProject(state);
  }

  // Check for new projects every time a request comes in (lightweight)
  function ensureSubscribed(): void {
    for (const state of ctx.getAllProjects()) {
      if (!sseClients.has(state.projectDir)) {
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
    for (const client of waitingClients) {
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
      handleStateAPI(res, url, ctx);
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
  waitingClients: Set<ServerResponse>,
): void {
  const project = resolveProject(url, ctx);
  if (!project) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();
    // No project yet — add to waiting set; will be subscribed on first event
    waitingClients.add(res);
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

  // Send initial snapshot (most recently created active session, or latest overall)
  const sessions = tm.getAllSessions().sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const session = sessions.find((s) => s.status === 'active') ?? sessions[0];
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

function handleStateAPI(res: ServerResponse, url: URL, ctx: MultiProjectContext): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });

  const project = resolveProject(url, ctx);
  if (!project) {
    res.end(JSON.stringify({ session: null, hypotheses: [] }));
    return;
  }

  const { tm } = project;
  const requestedSessionId = url.searchParams.get('sessionId');

  // If a specific session is requested and not in memory, try to load it
  if (requestedSessionId) {
    project.ensureSessionLoaded(requestedSessionId);
  }

  const sessions = tm.getAllSessions().sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  let session;
  if (requestedSessionId) {
    session = sessions.find((s) => s.id === requestedSessionId) ?? null;
  } else {
    session = sessions.find((s) => s.status === 'active') ?? sessions[0] ?? null;
  }

  if (session) {
    const hypotheses = tm.getAllHypotheses().filter((h) => h.sessionId === session.id);
    res.end(JSON.stringify({ session, hypotheses }));
  } else {
    res.end(JSON.stringify({ session: null, hypotheses: [] }));
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
    const activeSessions = p.tm.getAllSessions().filter((s) => s.status === 'active');
    const latestActive = activeSessions.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    return {
      dir: p.projectDir,
      activeProblem: latestActive?.problem ?? null,
      sessionCount: p.sessionIndex.length || p.tm.getAllSessions().length,
    };
  });

  res.end(JSON.stringify({ projects, lastActive: ctx.getLastActiveProject() }));
}

function handleInfoAPI(res: ServerResponse, ctx: MultiProjectContext): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });

  const projects = ctx.getAllProjects().map((p) => {
    const activeSessions = p.tm.getAllSessions().filter((s) => s.status === 'active');
    const latestActive = activeSessions.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    return {
      dir: p.projectDir,
      activeProblem: latestActive?.problem ?? null,
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

  // Create cached sirv handler once
  if (!sirvHandler) {
    try {
      const mod = await import('sirv');
      sirvHandler = mod.default(STATIC_DIR, { single: true, dev: true });
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Static file serving unavailable (sirv not installed)');
      return;
    }
  }

  sirvHandler(req, res);
}
