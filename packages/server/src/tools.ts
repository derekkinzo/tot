import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TreeError, type TreeManager } from './tree-manager.js';
import { Persistence } from './persistence.js';
import * as fmt from './responses.js';
import { STATUS_ICONS } from './types.js';

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
    description: 'Start a new Tree of Thought reasoning session. Use when facing a complex problem that requires systematic investigation — root cause analysis, differential diagnosis, hypothesis-driven inquiry, or multi-factor decisions across any domain.',
    schema: {
      problem: z.string().min(1).max(10000).describe('The problem statement to investigate'),
    },
  },
  decompose: {
    description: 'Decompose a hypothesis into sibling sub-hypotheses comparable along a single framing axis. 2-5 keeps the tree legible; up to 20 are accepted when the domain genuinely warrants more. Aim for non-overlapping siblings unless the domain co-instantiates them (cf. Mackie INUS conditions). Use at any depth to drill deeper into a branch.',
    schema: {
      parentId: z.string().min(1).describe('ID of the hypothesis to decompose'),
      children: z.array(z.string().min(1)).min(2).max(20).describe('Array of sub-hypothesis content strings'),
    },
  },
  add_hypothesis: {
    description: 'Add a single sibling hypothesis to the tree. Use when an existing decomposition is missing a possibility.',
    schema: {
      parentId: z.string().min(1).describe('ID of the parent hypothesis'),
      content: z.string().min(1).max(10000).describe('Description of the new hypothesis'),
    },
  },
  add_evidence: {
    description: 'Attach evidence to a hypothesis. After adding, consider whether this evidence also affects sibling hypotheses.',
    schema: {
      hypothesisId: z.string().min(1).describe('ID of the hypothesis'),
      type: z.enum(['supports', 'refutes', 'neutral']).describe('How this evidence relates to the hypothesis'),
      content: z.string().min(1).max(10000).describe('Description of the evidence'),
      source: z.string().max(10000).optional().describe('Where this evidence came from (logs, tests, docs, etc.)'),
    },
  },
  eliminate_hypothesis: {
    description: 'Mark a hypothesis as eliminated, grounded in refuting evidence. Per Popper, elimination is the operational form of falsification — a counter-instance must exist on the hypothesis. Call add_evidence(type=refutes) first, or use set_out_of_scope to mark a branch as uninvestigated without claiming refutation.',
    schema: {
      hypothesisId: z.string().min(1).describe('ID of the hypothesis to eliminate'),
      reason: z.string().min(1).max(10000).describe('Why this hypothesis is being eliminated'),
      refutingEvidenceIds: z.array(z.string().min(1)).min(1).optional().describe('Optional explicit ids of refutes-typed evidence records that ground this verdict. When omitted, all refutes-typed records on the hypothesis are bound.'),
    },
  },
  corroborate_hypothesis: {
    description: 'Mark a hypothesis as corroborated — it has survived the refutation tests applied to it. Per Popper, corroboration is provisional retention, not verification: the verdict can be reopened by later refuting evidence. Resolves the session only when every other top-level branch is terminal (eliminated, corroborated, or out-of-scope).',
    schema: {
      hypothesisId: z.string().min(1).describe('ID of the hypothesis to corroborate'),
      reason: z.string().min(1).max(10000).describe('Why this hypothesis has survived refutation'),
    },
  },
  set_out_of_scope: {
    description: 'Mark a hypothesis as out-of-scope: terminal but no refutation claimed. Use to set aside a branch the agent does not want to investigate. Distinct from elimination, which asserts a refuting record. Closure treats both as pruning — descendants of an out-of-scope node are not required to be terminal.',
    schema: {
      hypothesisId: z.string().min(1).describe('ID of the hypothesis to set out-of-scope'),
      reason: z.string().min(1).max(10000).describe('Why this branch is being set aside without investigation'),
    },
  },
  score_hypothesis: {
    description: 'Update the confidence score for a hypothesis (0-1). Use to track relative likelihood among competing hypotheses.',
    schema: {
      hypothesisId: z.string().min(1).describe('ID of the hypothesis to score'),
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
      parentId: z.string().min(1).describe('ID of the parent hypothesis whose children to validate'),
    },
  },
};

const schemas = {
  create_tree: z.object({
    problem: z.string().min(1).max(10000),
  }),
  decompose: z.object({
    parentId: z.string().min(1),
    children: z.array(z.string().min(1)).min(2).max(20),
  }),
  add_hypothesis: z.object({
    parentId: z.string().min(1),
    content: z.string().min(1).max(10000),
  }),
  add_evidence: z.object({
    hypothesisId: z.string().min(1),
    type: z.enum(['supports', 'refutes', 'neutral']),
    content: z.string().min(1).max(10000),
    source: z.string().max(10000).optional(),
  }),
  eliminate_hypothesis: z.object({
    hypothesisId: z.string().min(1),
    reason: z.string().min(1).max(10000),
    refutingEvidenceIds: z.array(z.string().min(1)).min(1).optional(),
  }),
  corroborate_hypothesis: z.object({
    hypothesisId: z.string().min(1),
    reason: z.string().min(1).max(10000),
  }),
  set_out_of_scope: z.object({
    hypothesisId: z.string().min(1),
    reason: z.string().min(1).max(10000),
  }),
  score_hypothesis: z.object({
    hypothesisId: z.string().min(1),
    score: z.number().min(0).max(1),
    rationale: z.string().max(10000).optional(),
  }),
  get_tree: z.object({
    format: z.enum(['full', 'compact', 'path']).optional().default('compact'),
  }),
  get_status: z.object({}),
  validate_decomposition: z.object({
    parentId: z.string().min(1),
  }),
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
export function getToolHandlers(tm: TreeManager, getDataDir: () => string, onPersistenceError?: (err: Error) => void): Map<string, ToolHandler> {
  const persistenceMap = new Map<string, Persistence>();

  function getPersistence(sessionId: string): Persistence {
    let p = persistenceMap.get(sessionId);
    if (!p) {
      p = new Persistence(getDataDir(), sessionId, onPersistenceError);
      persistenceMap.set(sessionId, p);
    }
    return p;
  }

  /**
   * Journals the wire event corresponding to a session-status transition.
   * 'session-completed' covers both terminal transitions (resolved and
   * abandoned); 'session-reopened' covers a corroborated leaf returning
   * to open after refuting evidence. Callers compute the prior status
   * before the mutation so the helper sees the transition direction.
   */
  async function journalSessionTransition(
    p: Persistence,
    sessionId: string,
    priorStatus: 'open' | 'resolved' | 'abandoned' | undefined,
    nextStatus: 'open' | 'resolved' | 'abandoned' | undefined,
  ): Promise<void> {
    if (!nextStatus || nextStatus === priorStatus) return;
    if (nextStatus === 'resolved' || nextStatus === 'abandoned') {
      await p.append('session-completed', { sessionId, terminalStatus: nextStatus });
    } else if (priorStatus === 'resolved' && nextStatus === 'open') {
      await p.append('session-reopened', { sessionId });
    }
  }

  function toolResult(text: string, isError = false) {
    return { content: [{ type: 'text' as const, text }], isError };
  }

  const handlers = new Map<string, ToolHandler>();

  handlers.set('create_tree', async (args) => {
    try {
      const { problem } = schemas.create_tree.parse(args);
      const { session, root } = tm.createSession(problem);
      const p = getPersistence(session.id);
      await p.append('session-created', session);
      await p.append('hypothesis-added', root);
      return toolResult(fmt.formatCreateTree(session.id, root.id, problem));
    } catch (e) {
      if (e instanceof z.ZodError) {
        return toolResult(`Validation error: ${e.issues.map(i => i.message).join(', ')}`, true);
      }
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('decompose', async (args) => {
    try {
      const { parentId, children: childContents } = schemas.decompose.parse(args);
      const created = tm.decompose(parentId, childContents);
      const check = tm.validateDecomposition(parentId);
      const p = getPersistence(created[0].sessionId);
      for (const child of created) await p.append('hypothesis-added', child);
      const parent = tm.getHypothesis(parentId)!;
      await p.append('hypothesis-updated', parent);
      return toolResult(fmt.formatDecompose(created, check, tm));
    } catch (e) {
      if (e instanceof z.ZodError) {
        return toolResult(`Validation error: ${e.issues.map(i => i.message).join(', ')}`, true);
      }
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('add_hypothesis', async (args) => {
    try {
      const { parentId, content } = schemas.add_hypothesis.parse(args);
      const hypothesis = tm.addHypothesis(parentId, content);
      const p = getPersistence(hypothesis.sessionId);
      await p.append('hypothesis-added', hypothesis);
      const parent = tm.getHypothesis(parentId)!;
      await p.append('hypothesis-updated', parent);
      return toolResult(fmt.formatAddHypothesis(hypothesis, tm));
    } catch (e) {
      if (e instanceof z.ZodError) {
        return toolResult(`Validation error: ${e.issues.map(i => i.message).join(', ')}`, true);
      }
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('add_evidence', async (args) => {
    try {
      const { hypothesisId, type, content, source } = schemas.add_evidence.parse(args);
      const target = tm.getHypothesis(hypothesisId);
      const sessionIdForPrior = target?.sessionId;
      const priorStatus = sessionIdForPrior
        ? tm.getAllSessions().find((s) => s.id === sessionIdForPrior)?.status
        : undefined;
      tm.addEvidence(hypothesisId, type, content, source);
      const hypothesis = tm.getHypothesis(hypothesisId)!;
      const p = getPersistence(hypothesis.sessionId);
      await p.append('hypothesis-updated', hypothesis);
      const session = tm.getAllSessions().find((s) => s.id === hypothesis.sessionId);
      await journalSessionTransition(p, hypothesis.sessionId, priorStatus, session?.status);
      return toolResult(fmt.formatAddEvidence(hypothesisId, hypothesis, tm));
    } catch (e) {
      if (e instanceof z.ZodError) {
        return toolResult(`Validation error: ${e.issues.map(i => i.message).join(', ')}`, true);
      }
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('eliminate_hypothesis', async (args) => {
    try {
      const { hypothesisId, reason, refutingEvidenceIds } = schemas.eliminate_hypothesis.parse(args);
      const target = tm.getHypothesis(hypothesisId);
      const sessionIdForPrior = target?.sessionId;
      const priorStatus = sessionIdForPrior
        ? tm.getAllSessions().find((s) => s.id === sessionIdForPrior)?.status
        : undefined;
      const hypothesis = tm.eliminateHypothesis(hypothesisId, reason, refutingEvidenceIds);
      const p = getPersistence(hypothesis.sessionId);
      await p.append('hypothesis-updated', hypothesis);
      const session = tm.getAllSessions().find((s) => s.id === hypothesis.sessionId);
      await journalSessionTransition(p, hypothesis.sessionId, priorStatus, session?.status);
      return toolResult(fmt.formatEliminate(hypothesis, tm));
    } catch (e) {
      if (e instanceof z.ZodError) {
        return toolResult(`Validation error: ${e.issues.map(i => i.message).join(', ')}`, true);
      }
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('corroborate_hypothesis', async (args) => {
    try {
      const { hypothesisId, reason } = schemas.corroborate_hypothesis.parse(args);
      const target = tm.getHypothesis(hypothesisId);
      const sessionIdForPrior = target?.sessionId;
      const priorStatus = sessionIdForPrior
        ? tm.getAllSessions().find((s) => s.id === sessionIdForPrior)?.status
        : undefined;
      const hypothesis = tm.corroborateHypothesis(hypothesisId, reason);
      const p = getPersistence(hypothesis.sessionId);
      await p.append('hypothesis-updated', hypothesis);
      const session = tm.getAllSessions().find((s) => s.id === hypothesis.sessionId);
      await journalSessionTransition(p, hypothesis.sessionId, priorStatus, session?.status);
      return toolResult(fmt.formatCorroborate(hypothesis, tm));
    } catch (e) {
      if (e instanceof z.ZodError) {
        return toolResult(`Validation error: ${e.issues.map(i => i.message).join(', ')}`, true);
      }
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('set_out_of_scope', async (args) => {
    try {
      const { hypothesisId, reason } = schemas.set_out_of_scope.parse(args);
      const target = tm.getHypothesis(hypothesisId);
      const sessionIdForPrior = target?.sessionId;
      const priorStatus = sessionIdForPrior
        ? tm.getAllSessions().find((s) => s.id === sessionIdForPrior)?.status
        : undefined;
      const hypothesis = tm.setOutOfScope(hypothesisId, reason);
      const p = getPersistence(hypothesis.sessionId);
      await p.append('hypothesis-updated', hypothesis);
      const session = tm.getAllSessions().find((s) => s.id === hypothesis.sessionId);
      await journalSessionTransition(p, hypothesis.sessionId, priorStatus, session?.status);
      return toolResult(fmt.formatSetOutOfScope(hypothesis, tm));
    } catch (e) {
      if (e instanceof z.ZodError) {
        return toolResult(`Validation error: ${e.issues.map(i => i.message).join(', ')}`, true);
      }
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('score_hypothesis', async (args) => {
    try {
      const { hypothesisId, score, rationale } = schemas.score_hypothesis.parse(args);
      const hypothesis = tm.scoreHypothesis(hypothesisId, score, rationale);
      const p = getPersistence(hypothesis.sessionId);
      await p.append('hypothesis-updated', hypothesis);
      return toolResult(fmt.formatScore(hypothesis, tm));
    } catch (e) {
      if (e instanceof z.ZodError) {
        return toolResult(`Validation error: ${e.issues.map(i => i.message).join(', ')}`, true);
      }
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('get_tree', async (args) => {
    try {
      const { format } = schemas.get_tree.parse(args);
      const state = tm.getTree();
      if (!state) return toolResult('No open session. Call create_tree to start.');

      if (format === 'full') {
        const hypotheses = Object.fromEntries(state.hypotheses);
        return toolResult(JSON.stringify({ session: state.session, hypotheses }, null, 2));
      }

      let result = `Problem: "${state.session.problem}"\n\n`;
      result += renderCompactTree(state.hypotheses, state.session.rootNodeId, '');
      return toolResult(result);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return toolResult(`Validation error: ${e.issues.map(i => i.message).join(', ')}`, true);
      }
      return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
    }
  });

  handlers.set('get_status', async () => {
    return toolResult(fmt.formatStatus(tm));
  });

  handlers.set('validate_decomposition', async (args) => {
    try {
      const { parentId } = schemas.validate_decomposition.parse(args);
      const check = tm.validateDecomposition(parentId);
      return toolResult(fmt.formatValidateDecomposition(parentId, check));
    } catch (e) {
      if (e instanceof z.ZodError) {
        return toolResult(`Validation error: ${e.issues.map(i => i.message).join(', ')}`, true);
      }
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

  const scoreStr = node.score !== null ? ` (${node.score.toFixed(2)})` : '';
  let line = `${indent}${STATUS_ICONS[node.status]} ${node.content}${scoreStr}\n`;

  for (const childId of node.children) {
    line += renderCompactTree(hypotheses, childId, indent + '  ');
  }

  return line;
}
