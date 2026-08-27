import type { TreeManager } from './tree-manager.js';
import type { SessionIndex } from './persistence.js';

/**
 * In-memory state for one project's tree: the engine, a lightweight session
 * index, a lazy session loader, and a persistence-health flag. Read by the HTTP
 * layer to serve the dashboard and its /api endpoints.
 */
export interface ProjectState {
  projectDir: string;
  dataDir: string;
  /** Where this project's captured evidence bytes live. */
  artifactsDir: string;
  tm: TreeManager;
  sessionIndex: SessionIndex[];
  ensureSessionLoaded: (sessionId: string) => boolean;
  persistenceHealthy: boolean;
}

/** One session as a caller listing them sees it. */
export interface SessionSummary {
  id: string;
  problem: string;
  status: string;
  createdAt: string;
  nodeCount: number;
}

/**
 * Every session this project has, newest first.
 *
 * The union of what is in memory and what the boot scan found on disk: the
 * index alone misses sessions created since the scan, and memory alone misses
 * the ones never loaded. A loaded session wins the tie because its node count
 * is live. Every surface that enumerates sessions reads this, so a count and a
 * list of the same project cannot disagree.
 */
export function sessionCatalog(project: ProjectState): SessionSummary[] {
  const { tm, sessionIndex } = project;
  const summaries: SessionSummary[] = tm.getAllSessions().map((s) => ({
    id: s.id,
    problem: s.problem,
    status: s.status,
    createdAt: s.createdAt,
    nodeCount: tm.getHypothesesBySession(s.id).length,
  }));
  const loadedIds = new Set(summaries.map((s) => s.id));
  for (const entry of sessionIndex) {
    if (loadedIds.has(entry.id)) continue;
    summaries.push({
      id: entry.id,
      problem: entry.problem,
      status: entry.status,
      createdAt: entry.createdAt,
      nodeCount: entry.nodeCount,
    });
  }
  return summaries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
