/**
 * The global singleton daemon process.
 *
 * Serves ALL projects from one process on one port. Each shim connection
 * identifies its projectDir via the handshake, and the daemon maintains a
 * separate TreeManager per project.
 *
 * Runtime files go in ~/.tot/ (global). Per-project data stays in
 * {projectDir}/.tot/sessions/.
 */

import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { TreeManager } from './tree-manager.js';
import { scanSessions, loadSession, type SessionIndex } from './persistence.js';
import { startHttpServer } from './http.js';
import { getToolHandlers, type ToolHandler } from './tools.js';
import { getTotDir, writeDaemonFiles, cleanup } from './daemon-lifecycle.js';
import { encode, createLineParser, type ShimToDaemon, type DaemonToShim } from './ipc-protocol.js';

const IDLE_TIMEOUT_MS_DEFAULT = 1800000; // 30min
const HTTP_PORT_DEFAULT = 6274;

const parsedIdleTimeout = parseInt(process.env['TOT_IDLE_TIMEOUT'] || '', 10);
const IDLE_TIMEOUT_MS = Number.isNaN(parsedIdleTimeout) ? IDLE_TIMEOUT_MS_DEFAULT : parsedIdleTimeout;
if (Number.isNaN(parsedIdleTimeout) && process.env['TOT_IDLE_TIMEOUT']) {
  console.error(`[tot-daemon] Warning: invalid TOT_IDLE_TIMEOUT "${process.env['TOT_IDLE_TIMEOUT']}", using default ${IDLE_TIMEOUT_MS_DEFAULT}ms`);
}

const parsedHttpPort = parseInt(process.env['TOT_PORT'] || '', 10);
const HTTP_PORT = Number.isNaN(parsedHttpPort) ? HTTP_PORT_DEFAULT : parsedHttpPort;
if (Number.isNaN(parsedHttpPort) && process.env['TOT_PORT']) {
  console.error(`[tot-daemon] Warning: invalid TOT_PORT "${process.env['TOT_PORT']}", using default ${HTTP_PORT_DEFAULT}`);
}

// ─── Per-project state ───

export interface ProjectState {
  projectDir: string;
  dataDir: string;
  tm: TreeManager;
  handlers: Map<string, ToolHandler>;
  sessionIndex: SessionIndex[];
  ensureSessionLoaded: (sessionId: string) => boolean;
  lastAccessTime: number;
}

const projectManagers = new Map<string, ProjectState>();

/** Most recently active project (used as default for HTTP/SSE when no project specified) */
let lastActiveProject: string | null = null;

/**
 * Gets or creates a ProjectState for a given projectDir.
 * Lazy-loads session metadata and the most recent active session.
 */
function getOrCreateProject(projectDir: string): ProjectState {
  const existing = projectManagers.get(projectDir);
  if (existing) return existing;

  const stagnationThreshold = parseInt(process.env['TOT_STAGNATION_THRESHOLD'] || '4', 10);
  const dataDir = join(projectDir, '.tot', 'sessions');
  const tm = new TreeManager({ stagnationThreshold });

  // Lazy-load: scan session metadata without replaying full event logs
  const sessionIndex = scanSessions(dataDir);

  // Eagerly load only the most recent active session (or most recent overall)
  if (sessionIndex.length > 0) {
    const sorted = [...sessionIndex].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const target = sorted.find((s) => s.status === 'active') ?? sorted[0];
    const loaded = loadSession(target.filePath);
    if (loaded) {
      tm.loadState([loaded.session], loaded.hypotheses);
      console.error(`[tot-daemon] Project ${projectDir}: loaded session ${target.id} (${sessionIndex.length} total indexed)`);
    }
  }

  function ensureSessionLoaded(sessionId: string): boolean {
    if (tm.hasSession(sessionId)) return true;
    const entry = sessionIndex.find((s) => s.id === sessionId);
    if (!entry) return false;
    const loaded = loadSession(entry.filePath);
    if (!loaded) return false;
    tm.loadState([loaded.session], loaded.hypotheses);
    return true;
  }

  const handlers = getToolHandlers(tm, () => dataDir);

  const state: ProjectState = {
    projectDir,
    dataDir,
    tm,
    handlers,
    sessionIndex,
    ensureSessionLoaded,
    lastAccessTime: Date.now(),
  };

  projectManagers.set(projectDir, state);
  console.error(`[tot-daemon] Registered project: ${projectDir}`);
  return state;
}

// ─── Public accessors for HTTP layer ───

export function getAllProjects(): ProjectState[] {
  return Array.from(projectManagers.values());
}

export function getProject(projectDir: string): ProjectState | undefined {
  return projectManagers.get(projectDir);
}

export function getLastActiveProject(): string | null {
  return lastActiveProject;
}

// ─── Daemon entry point ───

export async function startDaemonProcess(): Promise<void> {
  const totDir = process.env['TOT_GLOBAL_DIR'] || getTotDir();

  // Track active shim connections + which project each socket belongs to
  const activeConnections = new Set<Socket>();
  const socketProjects = new Map<Socket, string>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let sseClientCount = 0;

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (activeConnections.size === 0 && sseClientCount === 0) {
        console.error('[tot-daemon] Idle timeout reached (no shims, no SSE clients), shutting down');
        process.exit(0);
      }
    }, IDLE_TIMEOUT_MS);
    idleTimer.unref();
  }

  resetIdleTimer();

  // Start HTTP server for visualization (multi-project)
  const httpPort = await startHttpServer(HTTP_PORT, {
    getProject,
    getAllProjects,
    getLastActiveProject: () => lastActiveProject,
    onSseConnect: () => { sseClientCount++; if (idleTimer) clearTimeout(idleTimer); },
    onSseDisconnect: () => { sseClientCount--; if (activeConnections.size === 0 && sseClientCount === 0) resetIdleTimer(); },
  });

  // IPC TCP server
  const ipcServer = createServer((socket: Socket) => {
    activeConnections.add(socket);
    if (idleTimer) clearTimeout(idleTimer);

    // Serialize message processing per socket (prevents concurrent mutations)
    let processing: Promise<void> = Promise.resolve();
    const parser = createLineParser((msg: ShimToDaemon) => {
      processing = processing.then(() =>
        handleMessage(msg, socket, socketProjects, totDir, httpPort)
          .catch((err) => console.error('[tot-daemon] Unhandled:', err))
      );
    });

    socket.on('data', parser);

    socket.on('close', () => {
      activeConnections.delete(socket);
      socketProjects.delete(socket);
      if (activeConnections.size === 0 && sseClientCount === 0) {
        resetIdleTimer();
      }
    });

    socket.on('error', () => {
      activeConnections.delete(socket);
      socketProjects.delete(socket);
      socket.destroy();
      if (activeConnections.size === 0 && sseClientCount === 0) {
        resetIdleTimer();
      }
    });
  });

  // Listen on OS-assigned port
  await new Promise<void>((resolve) => {
    ipcServer.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });

  const ipcPort = (ipcServer.address() as import('node:net').AddressInfo).port;

  // Write daemon files to global dir
  writeDaemonFiles(totDir, {
    pid: process.pid,
    ipcPort,
    httpPort,
  });

  console.error(`[tot-daemon] Global daemon started: IPC ${ipcPort}, HTTP ${httpPort}, PID ${process.pid}`);
  console.error(`[tot-daemon] State directory: ${totDir}`);

  // Signal handlers — graceful drain allows in-flight tool calls to finish
  const gracefulShutdown = () => {
    console.error('[tot-daemon] Shutting down (draining connections)...');
    cleanup(totDir);
    ipcServer.close(); // Stop accepting new connections

    // Hard deadline: exit after 2s regardless of connection state
    const deadline = setTimeout(() => process.exit(0), 2000);
    deadline.unref();

    // If all connections drain before the deadline, exit immediately
    if (activeConnections.size === 0) {
      process.exit(0);
    }
    for (const conn of activeConnections) {
      conn.once('close', () => {
        if (activeConnections.size === 0) {
          process.exit(0);
        }
      });
    }
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
  process.on('exit', () => {
    cleanup(totDir);
  });
}

const VALID_SHIM_TYPES = new Set(['handshake', 'tool-call', 'disconnect']);
const MAX_LOADED_PROJECTS = 5;

async function handleMessage(
  msg: ShimToDaemon,
  socket: Socket,
  socketProjects: Map<Socket, string>,
  totDir: string,
  httpPort: number,
): Promise<void> {
  // IPC message type validation
  if (!msg.type || !VALID_SHIM_TYPES.has(msg.type)) {
    console.error(`[tot-daemon] Warning: unknown message type "${msg.type}"`);
    safeWrite(socket, encode({ type: 'error', message: `Unknown message type: ${msg.type}` } satisfies DaemonToShim));
    return;
  }

  switch (msg.type) {
    case 'handshake': {
      const projectDir = msg.projectDir;
      socketProjects.set(socket, projectDir);
      lastActiveProject = projectDir;

      // Ensure project state is initialized
      getOrCreateProject(projectDir);

      safeWrite(socket, encode({ type: 'handshake-ack', httpPort } satisfies DaemonToShim));
      break;
    }
    case 'tool-call': {
      const projectDir = socketProjects.get(socket);
      if (!projectDir) {
        safeWrite(socket, encode({
          type: 'tool-result',
          id: msg.id,
          content: [{ type: 'text', text: 'Error: no handshake received — projectDir unknown' }],
          isError: true,
        } satisfies DaemonToShim));
        return;
      }

      lastActiveProject = projectDir;
      const project = getOrCreateProject(projectDir);
      project.lastAccessTime = Date.now();
      const handler = project.handlers.get(msg.tool);

      if (!handler) {
        safeWrite(socket, encode({
          type: 'tool-result',
          id: msg.id,
          content: [{ type: 'text', text: `Unknown tool: ${msg.tool}` }],
          isError: true,
        } satisfies DaemonToShim));
        return;
      }
      try {
        const result = await handler(msg.args);
        safeWrite(socket, encode({
          type: 'tool-result',
          id: msg.id,
          content: result.content,
          isError: result.isError,
        } satisfies DaemonToShim));
      } catch (e: any) {
        safeWrite(socket, encode({
          type: 'tool-result',
          id: msg.id,
          content: [{ type: 'text', text: `Internal error: ${e.message}` }],
          isError: true,
        } satisfies DaemonToShim));
      }

      // LRU eviction: if too many projects loaded, evict least recently accessed
      if (projectManagers.size > MAX_LOADED_PROJECTS) {
        let oldest: string | null = null;
        let oldestTime = Infinity;
        for (const [dir, state] of projectManagers) {
          if (state.lastAccessTime < oldestTime) {
            oldestTime = state.lastAccessTime;
            oldest = dir;
          }
        }
        if (oldest && oldest !== projectDir) {
          projectManagers.delete(oldest);
          console.error(`[tot-daemon] Evicted LRU project: ${oldest}`);
        }
      }
      break;
    }
    case 'disconnect': {
      socket.end();
      break;
    }
  }
}

function safeWrite(socket: Socket, data: string): void {
  try {
    if (!socket.destroyed) socket.write(data);
  } catch {
    // Socket closed between check and write — silently ignore
  }
}

// Entry point when run directly
startDaemonProcess().catch((err) => {
  console.error('[tot-daemon] Fatal:', err);
  process.exit(1);
});
