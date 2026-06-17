import type { TreeManager } from './tree-manager.js';
import type { ToolHandler } from './tools.js';
import type { SessionIndex } from './persistence.js';

/**
 * In-memory state for one project's tree: the engine, its tool handlers, a
 * lightweight session index, and a lazy session loader. Shared by the HTTP
 * layer (which reads it to serve the dashboard) and the server host.
 */
export interface ProjectState {
  projectDir: string;
  dataDir: string;
  tm: TreeManager;
  handlers: Map<string, ToolHandler>;
  sessionIndex: SessionIndex[];
  ensureSessionLoaded: (sessionId: string) => boolean;
  lastAccessTime: number;
  persistenceHealthy: boolean;
}
