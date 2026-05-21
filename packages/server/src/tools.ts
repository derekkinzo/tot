import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TreeError, type TreeManager } from './tree-manager.js';
import { Persistence } from './persistence.js';
import * as fmt from './responses.js';

// ─── Types ───

/** Handler function signature for tool execution. Receives parsed args, returns MCP-compatible content. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }>;

export interface ToolSchema {
  description: string;
  schema: Record<string, any>;
}

// ─── Tool Schemas (shared between shim and daemon) ───

/**
 * Canonical tool definitions shared between two execution paths:
 * - The shim uses these for MCP tool discovery (listTools)
 * - The daemon uses them to validate args and dispatch handlers
 * This single source of truth prevents schema drift between the two.
 */
export const TOOL_SCHEMAS: Record<string, ToolSchema> = {
  create_tree: {
    description: 'Start a new Tree of Thought reasoning session. Use when facing a complex problem that requires systematic investigation — especially debugging, root cause analysis, or multi-factor decisions.',
    schema: {
      problem: z.string().max(10000).describe('The problem statement to investigate'),
    },
  },
  decompose: {
    description: 'Decompose a hypothesis into mutually exclusive, collectively exhaustive sub-hypotheses. Use at any depth to drill deeper into a branch.',
    schema: {
      parentId: z.string().describe('ID of the hypothesis to decompose'),
      children: z.array(z.string()).min(2).max(20).describe('Array of sub-hypothesis content strings'),
    },
  },
  add_hypothesis: {
    description: 'Add a single hypothesis to the tree. Use when you realize a MECE decomposition is missing a possibility.',
    schema: {
      parentId: z.string().describe('ID of the parent hypothesis'),
      content: z.string().max(10000).describe('Description of the new hypothesis'),
    },
  },
  add_evidence: {
    description: 'Attach evidence to a hypothesis. After adding, consider whether this evidence also affects sibling hypotheses.',
    schema: {
      hypothesisId: z.string().describe('ID of the hypothesis'),
      type: z.enum(['supports', 'refutes', 'neutral']).describe('How this evidence relates to the hypothesis'),
      content: z.string().max(10000).describe('Description of the evidence'),
      source: z.string().max(10000).optional().describe('Where this evidence came from (logs, tests, docs, etc.)'),
    },
  },
  eliminate_hypothesis: {
    description: 'Mark a hypothesis as eliminated (dead end). Provide the reason — this creates an audit trail.',
    schema: {
      hypothesisId: z.string().describe('ID of the hypothesis to eliminate'),
      reason: z.string().max(10000).describe('Why this hypothesis is being eliminated'),
    },
  },
  confirm_hypothesis: {
    description: 'Mark a hypothesis as confirmed (the answer/root cause). This completes the session.',
    schema: {
      hypothesisId: z.string().describe('ID of the hypothesis to confirm'),
      reason: z.string().max(10000).describe('Why this hypothesis is confirmed as the answer'),
    },
  },
  score_hypothesis: {
    description: 'Update the confidence score for a hypothesis (0-1). Use to track relative likelihood among competing hypotheses.',
    schema: {
      hypothesisId: z.string().describe('ID of the hypothesis to score'),
      score: z.number().min(0).max(1).describe('Confidence score between 0 and 1'),
      rationale: z.string().max(10000).optional().describe('Why this score was assigned'),
    },
  },
  get_tree: {
    description: 'View the current hypothesis tree structure.',
    schema: {
      format: z.enum(['full', 'compact', 'path']).optional().default('compact').describe('Output format'),
    },
  },
  get_status: {
    description: 'Get a summary of the current investigation: progress, unexplored branches, best lead, and stagnation check.',
    schema: {},
  },
  validate_decomposition: {
    description: 'Check structural properties of a decomposition (child count, overlaps, catch-all). For semantic MECE validation, reason about whether hypotheses truly don\'t overlap and cover all possibilities.',
    schema: {
      parentId: z.string().describe('ID of the parent hypothesis whose children to validate'),
    },
  },
};

// ─── Tool Handlers (used by daemon directly) ───

/**
 * Creates the map of tool name to handler function.
 * Handlers own persistence (one Persistence instance per session) and
 * format responses via the responses module.
 * @param tm - The TreeManager instance that owns all hypothesis state
 * @param getDataDir - Thunk returning the data directory path (deferred for testability)
 * @returns Map of tool name to async handler
 */
export function getToolHandlers(tm: TreeManager, getDataDir: () => string): Map<string, ToolHandler> {
  const persistenceMap = new Map<string, Persistence>();

  function getPersistence(sessionId: string): Persistence {
    let p = persistenceMap.get(sessionId);
    if (!p) {
      p = new Persistence(getDataDir(), sessionId);
      persistenceMap.set(sessionId, p);
    }
    return p;
  }

  function toolResult(text: string, isError = false) {
    return { content: [{ type: 'text' as const, text }], isError };
  }

  const handlers = new Map<string, ToolHandler>();

  handlers.set('create_tree', async (args) => {
    const problem = args.problem as string;
    try {
      const { session, root } = tm.createSession(problem);
      const p = getPersistence(session.id);
      await p.append('session-created', session);
      await p.append('hypothesis-added', root);
      return toolResult(fmt.formatCreateTree(session.id, root.id, problem));
    } catch (e) {
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('decompose', async (args) => {
    const parentId = args.parentId as string;
    const childContents = args.children as string[];
    try {
      const created = tm.decompose(parentId, childContents);
      const check = tm.validateDecomposition(parentId);
      const p = getPersistence(created[0].sessionId);
      for (const child of created) await p.append('hypothesis-added', child);
      const parent = tm.getHypothesis(parentId)!;
      await p.append('hypothesis-updated', parent);
      return toolResult(fmt.formatDecompose(created, check, tm));
    } catch (e) {
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('add_hypothesis', async (args) => {
    const parentId = args.parentId as string;
    const content = args.content as string;
    try {
      const hypothesis = tm.addHypothesis(parentId, content);
      const p = getPersistence(hypothesis.sessionId);
      await p.append('hypothesis-added', hypothesis);
      const parent = tm.getHypothesis(parentId)!;
      await p.append('hypothesis-updated', parent);
      return toolResult(fmt.formatAddHypothesis(hypothesis, tm));
    } catch (e) {
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('add_evidence', async (args) => {
    const hypothesisId = args.hypothesisId as string;
    const type = args.type as 'supports' | 'refutes' | 'neutral';
    const content = args.content as string;
    const source = args.source as string | undefined;
    try {
      const evidence = tm.addEvidence(hypothesisId, type, content, source);
      const hypothesis = tm.getHypothesis(hypothesisId)!;
      const p = getPersistence(hypothesis.sessionId);
      // Only persist hypothesis-updated (contains full evidence array); evidence-added event still emitted via TreeManager for SSE
      await p.append('hypothesis-updated', hypothesis);
      return toolResult(fmt.formatAddEvidence(hypothesisId, hypothesis, tm));
    } catch (e) {
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('eliminate_hypothesis', async (args) => {
    const hypothesisId = args.hypothesisId as string;
    const reason = args.reason as string;
    try {
      const hypothesis = tm.eliminateHypothesis(hypothesisId, reason);
      const p = getPersistence(hypothesis.sessionId);
      await p.append('hypothesis-updated', hypothesis);
      return toolResult(fmt.formatEliminate(hypothesis, tm));
    } catch (e) {
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('confirm_hypothesis', async (args) => {
    const hypothesisId = args.hypothesisId as string;
    const reason = args.reason as string;
    try {
      const hypothesis = tm.confirmHypothesis(hypothesisId, reason);
      const p = getPersistence(hypothesis.sessionId);
      await p.append('hypothesis-updated', hypothesis);
      await p.append('session-completed', { sessionId: hypothesis.sessionId });
      return toolResult(fmt.formatConfirm(hypothesis, tm));
    } catch (e) {
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('score_hypothesis', async (args) => {
    const hypothesisId = args.hypothesisId as string;
    const score = args.score as number;
    const rationale = args.rationale as string | undefined;
    try {
      const hypothesis = tm.scoreHypothesis(hypothesisId, score, rationale);
      const p = getPersistence(hypothesis.sessionId);
      await p.append('hypothesis-updated', hypothesis);
      return toolResult(fmt.formatScore(hypothesis, tm));
    } catch (e) {
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('get_tree', async (args) => {
    const format = (args.format as string) || 'compact';
    const state = tm.getTree();
    if (!state) return toolResult('No active session. Call create_tree to start.');

    if (format === 'full') {
      const hypotheses = Object.fromEntries(state.hypotheses);
      return toolResult(JSON.stringify({ session: state.session, hypotheses }, null, 2));
    }

    let result = `Problem: "${state.session.problem}"\n\n`;
    result += renderCompactTree(state.hypotheses, state.session.rootNodeId, '');
    return toolResult(result);
  });

  handlers.set('get_status', async () => {
    return toolResult(fmt.formatStatus(tm));
  });

  handlers.set('validate_decomposition', async (args) => {
    const parentId = args.parentId as string;
    try {
      const check = tm.validateDecomposition(parentId);
      return toolResult(fmt.formatValidateDecomposition(parentId, check));
    } catch (e) {
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  return handlers;
}

// ─── MCP Registration (wraps getToolHandlers for McpServer) ───

/**
 * Registers all tools on an McpServer instance (for direct in-process MCP usage).
 * Wraps getToolHandlers to bridge between McpServer's registration API and our handler map.
 * @param server - The MCP server instance to register tools on
 * @param tm - TreeManager for hypothesis state
 * @param getDataDir - Thunk returning the persistence directory
 */
export function registerTools(server: McpServer, tm: TreeManager, getDataDir: () => string): void {
  const handlers = getToolHandlers(tm, getDataDir);

  for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
    const handler = handlers.get(name)!;
    server.tool(name, schema.description, schema.schema, async (args: any) => {
      return handler(args);
    });
  }
}

// ─── Helpers ───

function renderCompactTree(hypotheses: Map<string, import('./types.js').Hypothesis>, nodeId: string, indent: string): string {
  const node = hypotheses.get(nodeId);
  if (!node) return '';

  const statusIcon = {
    pending: '○',
    exploring: '◉',
    eliminated: '✗',
    confirmed: '✓',
  }[node.status];

  const scoreStr = node.score !== null ? ` (${node.score.toFixed(2)})` : '';
  let line = `${indent}${statusIcon} ${node.content}${scoreStr}\n`;

  for (const childId of node.children) {
    line += renderCompactTree(hypotheses, childId, indent + '  ');
  }

  return line;
}
