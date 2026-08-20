import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { TreeManager } from './tree-manager.js';
import type { Session, TreeEvent } from './types.js';
import type { ProjectState } from './project-state.js';
import { pickActiveSession } from './persistence.js';
import { checkIntegrity, readLineWindow, resolveArtifactPath } from './artifacts.js';
import { rendersAsLines } from './types.js';
import { findArtifactRef, parseArtifactRoute, type ArtifactRoute } from './artifact-routes.js';
import { SseHub } from './sse-hub.js';

/** Most recently created open session, falling back to the most recent overall. */
function pickDefaultSession(tm: TreeManager): Session | null {
  return pickActiveSession(tm.getAllSessions()) ?? null;
}

/** Runs `fn` under the project's read/mutate mutex. */
export type ProjectLock = <T>(fn: () => Promise<T>) => Promise<T>;

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

/**
 * Builds the snapshot event for a session: the requested one when `sessionId`
 * resolves to a loaded session, otherwise the project default (null if no
 * session at all). Honoring the request keeps a reconnecting dashboard on the
 * session the user is viewing instead of snapping it back to the default.
 */
function snapshotEvent(tm: TreeManager, sessionId?: string | null): TreeEvent {
  const session = (sessionId
    ? tm.getAllSessions().find((s) => s.id === sessionId)
    : undefined) ?? pickDefaultSession(tm);
  if (!session) return { type: 'snapshot', session: null, hypotheses: [] };
  const hypotheses = tm.getHypothesesBySession(session.id);
  return { type: 'snapshot', session, hypotheses };
}

/**
 * Start the HTTP visualization server for one project. Pass port 0 for an
 * OS-assigned ephemeral port; the bound port is returned in the resolved
 * handle. `lock` serializes the state read against MCP mutations.
 */
export async function startHttpServer(
  port: number,
  project: ProjectState,
  lock: ProjectLock,
  onSseConnect: () => void,
  onSseDisconnect: () => void,
): Promise<HttpServerHandle> {
  const hub = new SseHub(onSseConnect, onSseDisconnect);
  hub.subscribe(project.tm);

  const keepaliveTimer = setInterval(() => hub.keepalive(), 30_000);
  keepaliveTimer.unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/sse') {
      setCorsHeaders(res);
      handleSSE(req, res, project, hub, url.searchParams.get('sessionId'));
      return;
    }

    if (url.pathname === '/api/state') {
      setCorsHeaders(res);
      await handleStateAPI(res, url, project, lock);
      return;
    }

    if (url.pathname === '/api/sessions') {
      setCorsHeaders(res);
      handleSessionsAPI(res, project);
      return;
    }

    if (url.pathname === '/api/info') {
      setCorsHeaders(res);
      handleInfoAPI(res, project);
      return;
    }

    // Before the /api/ catch-all below, which would otherwise answer 404.
    const artifactRoute = parseArtifactRoute(url.pathname, url.searchParams);
    if (artifactRoute) {
      setCorsHeaders(res);
      await handleArtifactAPI(res, artifactRoute, project, lock);
      return;
    }

    // Unknown API routes must 404 rather than fall through to the SPA static
    // fallback (which would serve index.html with a 200 and make a client's
    // JSON.parse throw, masking the bad route).
    if (url.pathname.startsWith('/api/')) {
      setCorsHeaders(res);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not-found' }));
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
  project: ProjectState,
  hub: SseHub,
  requestedSessionId: string | null,
): void {
  writeSseHeaders(res);
  // A reconnecting dashboard re-requests the session it is viewing; load it
  // (lazy) so the snapshot describes that session rather than the default.
  if (requestedSessionId) project.ensureSessionLoaded(requestedSessionId);
  // Send the initial snapshot, then register for live events.
  res.write(`id: 0\ndata: ${JSON.stringify(snapshotEvent(project.tm, requestedSessionId))}\n\n`);
  hub.addClient(res);
  req.on('close', () => hub.removeClient(res));
}

async function handleStateAPI(res: ServerResponse, url: URL, project: ProjectState, lock: ProjectLock): Promise<void> {
  const { tm } = project;
  const requestedSessionId = url.searchParams.get('sessionId');

  // Lazy-load + read snapshot under the project lock so ensureSessionLoaded
  // (which writes the in-memory sessions/hypotheses Maps) cannot interleave
  // with an MCP handler mid-mutation.
  try {
    const payload = await lock(async () => {
      if (requestedSessionId) {
        project.ensureSessionLoaded(requestedSessionId);
      }

      const session: Session | null = requestedSessionId
        ? tm.getAllSessions().find((s) => s.id === requestedSessionId) ?? null
        : pickDefaultSession(tm);

      if (!session) return { session: null, hypotheses: [] };
      const hypotheses = tm.getHypothesesBySession(session.id);
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

function handleSessionsAPI(res: ServerResponse, project: ProjectState): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });

  const { tm, sessionIndex } = project;

  // If we have a session index, use it for the list (no full loading needed)
  if (sessionIndex.length > 0) {
    const loadedSessions = tm.getAllSessions();
    const loadedIds = new Set(loadedSessions.map((s) => s.id));

    const summaries: Array<{ id: string; problem: string; status: string; createdAt: string; nodeCount: number }> = [];

    // Add loaded sessions with accurate node counts
    for (const s of loadedSessions) {
      const hypotheses = tm.getHypothesesBySession(s.id);
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
    const hypotheses = tm.getHypothesesBySession(s.id);
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

function handleInfoAPI(res: ServerResponse, project: ProjectState): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });

  const openSessions = project.tm.getAllSessions().filter((s) => s.status === 'open');
  const latestOpen = openSessions.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0];

  res.end(JSON.stringify({
    projectDir: project.projectDir,
    activeProblem: latestOpen?.problem ?? null,
    sessionCount: project.sessionIndex.length || project.tm.getAllSessions().length,
    persistenceHealthy: project.persistenceHealthy,
  }));
}

/**
 * Serves a captured artifact: its metadata with a freshly recomputed integrity
 * verdict, a line window of it, or its raw bytes.
 *
 * The reference is resolved from the session's evidence under the project lock,
 * so only bytes some record actually cites are reachable, and the digest checked
 * against is the one recorded at capture.
 */
async function handleArtifactAPI(
  res: ServerResponse,
  route: ArtifactRoute,
  project: ProjectState,
  lock: ProjectLock,
): Promise<void> {
  if (route.kind === 'invalid') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad-artifact-request' }));
    return;
  }

  try {
    const ref = await lock(async () => {
      project.ensureSessionLoaded(route.sessionId);
      return findArtifactRef(project.tm.getHypothesesBySession(route.sessionId), route.artifactId);
    });
    if (!ref) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'artifact-not-found' }));
      return;
    }

    if (route.kind === 'meta') {
      const integrity = await checkIntegrity(project.artifactsDir, ref);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...ref, integrity }));
      return;
    }

    const path = resolveArtifactPath(project.artifactsDir, ref);

    if (route.kind === 'lines') {
      const window = await readLineWindow({
        read: () => readFile(path, 'utf-8'),
        from: route.from,
        to: route.to,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(window));
      return;
    }

    // Raw bytes. The recorded filename is offered for the download name only;
    // it never took part in resolving the path. Bytes a viewer cannot render
    // are offered as a download rather than dropped into a tab.
    const bytes = await readFile(path);
    const shown = rendersAsLines(ref);
    res.writeHead(200, {
      'Content-Type': ref.mediaType,
      'Content-Disposition':
        `${shown ? 'inline' : 'attachment'}; filename*=UTF-8\'\'${encodeURIComponent(ref.filename)}`,
      'Cache-Control': 'no-store',
    });
    res.end(bytes);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    res.writeHead(missing ? 410 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: missing ? 'artifact-bytes-missing' : 'artifact-read-failed' }));
    if (!missing) console.error('[tot-mcp] handleArtifactAPI error:', err);
  }
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
