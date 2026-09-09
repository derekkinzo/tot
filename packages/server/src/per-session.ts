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

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TreeManager } from './tree-manager.js';
import { scanSessions, loadSession, pickActiveSession, type SessionIndex } from './persistence.js';
import { registerTools } from './tools.js';
import { registerPrompts } from './prompts.js';
import { startHttpServer } from './http.js';
import { makeLock } from './mutex.js';
import { getCentralArtifactsDir, getCentralSessionsDir, writeProjectMeta } from './central-storage.js';
import { migrateLegacySessions } from './legacy-migration.js';
import { STAGNATION_THRESHOLD_DEFAULT, SHUTDOWN_DEADLINE_MS } from './defaults.js';
import { sessionCatalog, type ProjectState } from './project-state.js';

/** A running per-session server: the engine, dashboard URL, and teardown. */
export interface SessionServer {
  server: McpServer;
  projectDir: string;
  dataDir: string;
  /** Bound visualization port, or null if the HTTP server failed to start. */
  port: number | null;
  /** `http://localhost:<port>`, or null if the HTTP server failed to start. */
  dashboardUrl: string | null;
  /** Flush the journal and stop the HTTP server. Idempotent; safe to call concurrently. */
  close: () => Promise<void>;
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

  const dataDir = getCentralSessionsDir(projectDir);
  const artifactsDir = getCentralArtifactsDir(projectDir);

  // A non-numeric override parses to NaN, which is not nullish and so survives a
  // `??` default — every later comparison against it is false, silently turning
  // stagnation detection off for the process. An unusable value falls back.
  const configuredThreshold = Number.parseInt(process.env['TOT_STAGNATION_THRESHOLD'] ?? '', 10);
  const stagnationThreshold = Number.isInteger(configuredThreshold) && configuredThreshold > 0
    ? configuredThreshold
    : STAGNATION_THRESHOLD_DEFAULT;
  const tm = new TreeManager({ stagnationThreshold });

  // The path is recorded once this project has a store to describe, and not
  // before: recording it unconditionally creates a directory for every project a
  // server ever booted in, so the store fills with entries naming projects that
  // hold no tree and a listing built on them is mostly empty rooms. A project
  // whose first tree is created in this process qualifies as soon as it is, so
  // the record does not wait for the next boot to appear.
  let projectRecorded = existsSync(dataDir);
  if (projectRecorded) writeProjectMeta(projectDir);
  tm.on('event', (event) => {
    if (projectRecorded || event.type !== 'session-created') return;
    projectRecorded = true;
    writeProjectMeta(projectDir);
  });

  // Lazy index; eager-load only the most-recent-open (else most-recent) session.
  const sessionIndex = scanSessions(dataDir);
  const target = pickActiveSession(sessionIndex);
  if (target) {
    const loaded = loadSession(target.filePath);
    if (loaded) tm.loadState([loaded.session], loaded.hypotheses);
  }

  /**
   * Loads a session into the engine on demand, by id or — with none named — this
   * project's active one. Reports whether a session is loaded afterwards.
   *
   * The index is built once at boot, but this project's store is shared: another
   * process can add a session to it at any time after that. So the index is
   * re-scanned before reporting a session absent, rather than answering "no such
   * session" about a session that is on disk, or "no session yet" about a project
   * that has one. A hit costs nothing; the re-scan happens only on the path that
   * would otherwise return a wrong answer.
   *
   * A session already in memory is never displaced by a newer one found on disk.
   * Whichever tree this process is working stays the one its un-named reads
   * address, so a session opened elsewhere cannot redirect them mid-investigation.
   */
  function ensureSessionLoaded(sessionId?: string): boolean {
    if (sessionId === undefined) {
      if (tm.getAllSessions().length > 0) return true;
    } else if (tm.hasSession(sessionId)) {
      return true;
    }

    const find = (): SessionIndex | undefined => sessionId === undefined
      ? pickActiveSession(sessionIndex)
      : sessionIndex.find((s) => s.id === sessionId);

    let entry = find();
    if (!entry) {
      // In place: the dashboard and the session catalog hold this same array.
      sessionIndex.splice(0, sessionIndex.length, ...scanSessions(dataDir));
      entry = find();
      if (!entry) return false;
    }
    const loaded = loadSession(entry.filePath);
    if (!loaded) return false;
    tm.loadState([loaded.session], loaded.hypotheses);
    return true;
  }

  // Serializes the HTTP handlers' lazy-load-then-read sections against each
  // other. See {@link makeLock} for why the tool handlers need no lock.
  const lock = makeLock();

  // Resolved once the HTTP server binds; threaded into get_status/get_tree so
  // the agent (and skills it invokes) can read the live dashboard URL from a
  // tool response — this process is the only one that knows its ephemeral port.
  let dashboardUrl: string | null = null;

  const projectState: ProjectState = {
    projectDir,
    dataDir,
    artifactsDir,
    tm,
    sessionIndex,
    ensureSessionLoaded,
    persistenceHealthy: true,
  };

  const server = new McpServer({ name: 'tot-mcp', version: '0.1.0' });
  const { drainAll } = registerTools(server, tm, () => dataDir, {
    getDashboardUrl: () => dashboardUrl,
    ensureSessionLoaded,
    listSessions: () => sessionCatalog(projectState),
    // A failed journal append flips the project's health flag, surfaced via
    // /api/info so the dashboard can show that writes are not landing.
    onPersistenceError: () => { projectState.persistenceHealthy = false; },
  });
  registerPrompts(server);

  let port: number | null = null;
  let httpClose: (() => Promise<void>) | null = null;
  try {
    const handle = await startHttpServer(0, projectState, lock, () => {}, () => {});
    port = handle.port;
    httpClose = handle.close;
    dashboardUrl = `http://localhost:${port}`;
  } catch (err) {
    // MCP still boots without visualization; dashboardUrl stays null so no
    // Visualization line is advertised. The authoritative dashboard URL is the
    // get_status tool response (this process is the only one that knows its
    // ephemeral port).
    console.error('[tot-mcp] HTTP visualization disabled:', (err as Error).message);
  }

  // Single-flight teardown: the first call runs the drain+close sequence and
  // every later call awaits that same promise, so concurrent shutdown triggers
  // (stdin end/close, a signal) can never let one return early and exit the
  // process while the journal drain from another is still in flight.
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        // Flush enqueued journal appends before tearing down, so a shutdown
        // mid-write does not lose an acknowledged mutation.
        await drainAll();
        if (httpClose) await httpClose();
        // Close the MCP server + its transport so the protocol layer tears down
        // cleanly rather than relying on the process exit alone.
        await server.close().catch(() => { /* already closed / never connected */ });
      })();
    }
    return closing;
  };

  return { server, projectDir, dataDir, port, dashboardUrl, close };
}

/**
 * Entry point for the MCP stdio process: builds the server, attaches the stdio
 * transport, and tears down on stdin close / termination signals.
 */
export async function startServer(projectDirArg?: string): Promise<void> {
  const session = await createSessionServer({ projectDir: projectDirArg });

  // session.close() is single-flight, so repeated triggers coalesce onto one
  // drain+teardown. A deadline bounds a stalled drain/close (e.g. a wedged
  // filesystem) so the process always exits rather than lingering.
  let exiting = false;
  const shutdown = (code: number) => {
    if (exiting) return;
    exiting = true;
    const deadline = setTimeout(() => process.exit(code), SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    void session.close().finally(() => process.exit(code));
  };

  const transport = new StdioServerTransport();
  await session.server.connect(transport);

  process.stdin.on('end', () => shutdown(0));
  process.stdin.on('close', () => shutdown(0));
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => shutdown(0));
  }
}
