/**
 * Per-session in-process MCP server.
 *
 * Each agent launches its own `tot-mcp` process. That process owns one
 * TreeManager, an in-process HTTP visualization server on an OS-assigned
 * ephemeral port, and an MCP stdio transport. There is no background daemon
 * and no IPC: the server lives exactly as long as the stdio connection.
 *
 * Session journals live in central storage
 * (<totDir>/projects/<hash>/sessions/) so a restart of the same project
 * reloads its trees from disk, and repos stay free of a per-project .tot dir.
 */

import { resolve, join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TreeManager } from './tree-manager.js';
import { scanSessions, loadSession, type SessionIndex } from './persistence.js';
import { registerTools } from './tools.js';
import { registerPrompts } from './prompts.js';
import { startHttpServer, type MultiProjectContext } from './http.js';
import { makeLock } from './mutex.js';
import { atomicWrite } from './storage-paths.js';
import { getCentralSessionsDir, writeProjectMeta } from './central-storage.js';
import { migrateLegacySessions } from './legacy-migration.js';
import { STAGNATION_THRESHOLD_DEFAULT } from './defaults.js';
import type { ProjectState } from './project-state.js';

/** A running per-session server: the engine, dashboard URL, and teardown. */
export interface SessionServer {
  server: McpServer;
  projectDir: string;
  dataDir: string;
  /** Bound visualization port, or null if the HTTP server failed to start. */
  port: number | null;
  /** `http://localhost:<port>`, or null if the HTTP server failed to start. */
  dashboardUrl: string | null;
  /** Stop the HTTP server and remove the per-session .port hint. Idempotent. */
  close: () => Promise<void>;
}

/** Most-recently-open session id, else most-recent overall, else undefined. */
function pickActiveSessionId(index: SessionIndex[]): string | undefined {
  if (index.length === 0) return undefined;
  const sorted = [...index].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return (sorted.find((s) => s.status === 'open') ?? sorted[0]).id;
}

/**
 * Builds the per-session server WITHOUT attaching a stdio transport or process
 * signal handlers, so it can be driven by an in-memory MCP client in tests.
 * {@link startServer} wraps this with the stdio + lifecycle plumbing.
 */
export async function createSessionServer(opts: { projectDir?: string } = {}): Promise<SessionServer> {
  const projectDir = resolve(opts.projectDir ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd());

  // Copy any legacy {projectDir}/.tot/sessions journals into central storage
  // (non-destructive) before scanning, so pre-migration trees stay visible.
  migrateLegacySessions(projectDir);
  writeProjectMeta(projectDir);

  const dataDir = getCentralSessionsDir(projectDir);

  const stagnationThreshold = parseInt(
    process.env['TOT_STAGNATION_THRESHOLD'] || String(STAGNATION_THRESHOLD_DEFAULT),
    10,
  );
  const tm = new TreeManager({ stagnationThreshold });

  // Lazy index; eager-load only the most-recent-open (else most-recent) session.
  const sessionIndex = scanSessions(dataDir);
  if (sessionIndex.length > 0) {
    const sorted = [...sessionIndex].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const target = sorted.find((s) => s.status === 'open') ?? sorted[0];
    const loaded = loadSession(target.filePath);
    if (loaded) tm.loadState([loaded.session], loaded.hypotheses);
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

  // Single-project async mutex (the task #59 read/mutate barrier): the HTTP
  // state read runs ensureSessionLoaded under this lock so it cannot interleave
  // with a tool handler mid-mutation across an await point.
  const lock = makeLock();

  // Resolved once the HTTP server binds; threaded into get_status/get_tree so
  // the agent (and skills it invokes) can read the live dashboard URL from a
  // tool response — this process is the only one that knows its ephemeral port.
  let dashboardUrl: string | null = null;

  const server = new McpServer({ name: 'tot-mcp', version: '0.1.0' });
  const { drainAll } = registerTools(server, tm, () => dataDir, () => dashboardUrl);
  registerPrompts(server);

  const projectState: ProjectState = {
    projectDir,
    dataDir,
    tm,
    handlers: new Map(),
    sessionIndex,
    ensureSessionLoaded,
    lastAccessTime: Date.now(),
    persistenceHealthy: true,
  };
  const ctx: MultiProjectContext = {
    getProject: (d) => (d === projectDir ? projectState : undefined),
    getAllProjects: () => [projectState],
    getLastActiveProject: () => projectDir,
    withLock: (_d, fn) => lock(fn),
    onSseConnect: () => {},
    onSseDisconnect: () => {},
  };

  let port: number | null = null;
  let httpClose: (() => Promise<void>) | null = null;
  let portFile: string | null = null;
  try {
    const handle = await startHttpServer(0, ctx);
    port = handle.port;
    httpClose = handle.close;
    dashboardUrl = `http://localhost:${port}`;

    // Best-effort hint for external tooling reconnecting to an existing
    // project. The authoritative URL is the get_status tool response (above);
    // this file is only written when a session already exists at startup, and
    // is per-session so concurrent same-project agents do not clobber it.
    const sid = pickActiveSessionId(sessionIndex);
    if (sid) {
      portFile = join(dataDir, `${sid}.port`);
      try { atomicWrite(portFile, String(port)); } catch { portFile = null; }
    }
  } catch (err) {
    // MCP still boots without visualization; dashboardUrl stays null so no
    // Visualization line is advertised.
    console.error('[tot-mcp] HTTP visualization disabled:', (err as Error).message);
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Flush any enqueued journal appends before tearing down, so a shutdown
    // mid-write does not lose an acknowledged mutation.
    await drainAll();
    if (portFile) { try { unlinkSync(portFile); } catch { /* best-effort */ } }
    if (httpClose) await httpClose();
  };

  return { server, projectDir, dataDir, port, dashboardUrl, close };
}

/**
 * Entry point for the MCP stdio process: builds the server, attaches the stdio
 * transport, and tears down on stdin close / termination signals.
 */
export async function startServer(projectDirArg?: string): Promise<void> {
  const session = await createSessionServer({ projectDir: projectDirArg });

  const shutdown = (code: number) => {
    void session.close().finally(() => process.exit(code));
  };

  const transport = new StdioServerTransport();
  await session.server.connect(transport);

  process.stdin.on('end', () => shutdown(0));
  process.stdin.on('close', () => shutdown(0));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGPIPE'] as const) {
    process.on(sig, () => shutdown(0));
  }
}
