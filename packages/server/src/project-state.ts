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
