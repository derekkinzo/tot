/**
 * Library entry point — re-exports for consumers.
 */

export { TreeManager } from './tree-manager.js';
export { registerTools, getToolHandlers, TOOL_SCHEMAS } from './tools.js';
export type { ToolHandler, ToolSchema } from './tools.js';
export type { Hypothesis, Evidence, Session, TreeEvent } from './types.js';
