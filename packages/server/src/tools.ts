import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TreeError, type TreeManager } from './tree-manager.js';
import { Persistence } from './persistence.js';
import { JournalSink } from './journal-sink.js';
import * as fmt from './responses.js';
import { STATUS_ICONS } from './types.js';
import { nodeLabel, splitProse } from '@tot-mcp/shared';

// ─── Types ───

/** Handler function signature for tool execution. Receives parsed args, returns MCP-compatible content. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }>;

export interface ToolSchema {
  description: string;
  schema: Record<string, any>;
}

// ─── Tool Schemas ───

/** Non-blank free text: rejects whitespace-only input (which z.string().min(1)
 *  would accept) at the wire boundary, matching the engine's content guards. */
const nonBlank = (max: number) =>
  z.string().min(1).max(max).refine((s) => s.trim().length > 0, 'must not be empty or whitespace-only');

/** An opaque identifier supplied by a previous tool response. */
const identifier = () => z.string().min(1);

/**
 * Canonical tool definitions: one Zod object per tool. Its `.shape` is what MCP
 * advertises through listTools and the object itself is what validates args
 * before dispatch, so the published contract and the enforced contract are the
 * same schema rather than two that can describe different constraints.
 */
const TOOL_DEFS = {
  create_tree: {
    description: 'Start a new Tree of Thought reasoning session. Use when facing a complex problem that requires systematic investigation — root cause analysis, differential diagnosis, hypothesis-driven inquiry, or multi-factor decisions across any domain.',
    input: z.object({
      problem: nonBlank(10000).describe('The problem statement to investigate'),
    }),
  },
  decompose: {
    description: 'Decompose a hypothesis into sibling sub-hypotheses comparable along a single framing axis. 2-5 keeps the tree legible; up to 20 are accepted when the domain genuinely warrants more. Aim for non-overlapping siblings unless the domain co-instantiates them (cf. Mackie INUS conditions). Use at any depth to drill deeper into a branch.',
    input: z.object({
      parentId: identifier().describe('ID of the hypothesis to decompose'),
      children: z.array(nonBlank(10000)).min(2).max(20).describe('Array of sub-hypothesis content strings'),
    }),
  },
  add_hypothesis: {
    description: 'Add a single sibling hypothesis to the tree. Use when an existing decomposition is missing a possibility.',
    input: z.object({
      parentId: identifier().describe('ID of the parent hypothesis'),
      content: nonBlank(10000).describe('Description of the new hypothesis'),
    }),
  },
  add_evidence: {
    description: 'Attach evidence to a hypothesis. After adding, consider whether this evidence also affects sibling hypotheses.',
    input: z.object({
      hypothesisId: identifier().describe('ID of the hypothesis'),
      type: z.enum(['supports', 'refutes', 'neutral']).describe('How this evidence relates to the hypothesis'),
      content: nonBlank(10000).describe('Description of the evidence'),
      source: z.string().max(10000).optional().describe('Where this evidence came from (logs, tests, docs, etc.)'),
    }),
  },
  eliminate_hypothesis: {
    description: 'Mark a hypothesis as eliminated, grounded in refuting evidence. Per Popper, elimination is the operational form of falsification — a counter-instance must exist on the hypothesis. Call add_evidence(type=refutes) first, or use set_out_of_scope to mark a branch as uninvestigated without claiming refutation.',
    input: z.object({
      hypothesisId: identifier().describe('ID of the hypothesis to eliminate'),
      reason: nonBlank(10000).describe('Why this hypothesis is being eliminated'),
      refutingEvidenceIds: z.array(identifier()).min(1).optional().describe('Optional explicit ids of refutes-typed evidence records that ground this verdict. When omitted, all refutes-typed records on the hypothesis are bound.'),
    }),
  },
  corroborate_hypothesis: {
    description: 'Mark a hypothesis as corroborated — it has survived the refutation tests applied to it. Per Popper, corroboration is provisional retention, not verification: the verdict can be reopened by later refuting evidence. Resolves the session only when every other top-level branch is terminal (eliminated, corroborated, or out-of-scope).',
    input: z.object({
      hypothesisId: identifier().describe('ID of the hypothesis to corroborate'),
      reason: nonBlank(10000).describe('Why this hypothesis has survived refutation'),
    }),
  },
  set_out_of_scope: {
    description: 'Mark a hypothesis as out-of-scope: terminal but no refutation claimed. Use to set aside a branch the agent does not want to investigate. Distinct from elimination, which asserts a refuting record. Closure treats both as pruning — descendants of an out-of-scope node are not required to be terminal.',
    input: z.object({
      hypothesisId: identifier().describe('ID of the hypothesis to set out-of-scope'),
      reason: nonBlank(10000).describe('Why this branch is being set aside without investigation'),
    }),
  },
  get_tree: {
    description: 'View a hypothesis tree structure. Defaults to the active session; pass sessionId to view another open session.',
    input: z.object({
      format: z.enum(['full', 'compact']).optional().default('compact').describe('Output format'),
      sessionId: identifier().optional().describe('Session to view (defaults to the active session)'),
    }),
  },
  get_status: {
    description: 'Get a summary of the current investigation: progress, unexplored branches, and stagnation check.',
    input: z.object({}),
  },
  validate_decomposition: {
    description: 'Check structural properties of a decomposition (child count, overlaps, catch-all). For semantic MECE validation, reason about whether hypotheses truly don\'t overlap and cover all possibilities.',
    input: z.object({
      parentId: identifier().describe('ID of the parent hypothesis whose children to validate'),
    }),
  },
} satisfies Record<string, { description: string; input: z.ZodObject<z.ZodRawShape> }>;

/** Discovery projection of {@link TOOL_DEFS}: the same schemas, shape-wise. */
export const TOOL_SCHEMAS: Record<string, ToolSchema> = Object.fromEntries(
  Object.entries(TOOL_DEFS).map(([name, def]) => [name, { description: def.description, schema: def.input.shape }]),
);

// ─── Tool Handlers ───

/** Tool handlers plus the journal flush handle a host awaits on shutdown. */
export interface ToolHandlers {
  handlers: Map<string, ToolHandler>;
  /** Resolves once every enqueued journal append has settled (for clean shutdown). */
  drainAll: () => Promise<void>;
}

/**
 * Creates the map of tool name to handler function.
 *
 * Journaling is event-sourced: a {@link JournalSink} subscribes to the engine's
 * event stream (the same stream the SSE layer consumes) and writes each
 * journaled event to the per-session JSONL file. Handlers do not append by
 * hand; after invoking an engine mutator (whose events are emitted
 * synchronously and enqueued by the sink) a mutating handler awaits
 * `sink.drain(sessionId)` so the write lands before the tool result returns
 * (write-before-acknowledge).
 *
 * @param tm - The TreeManager instance that owns all hypothesis state
 * @param getDataDir - Thunk returning the data directory path (deferred for testability)
 */
export function getToolHandlers(tm: TreeManager, getDataDir: () => string, onPersistenceError?: (err: Error) => void, getDashboardUrl?: () => string | null): ToolHandlers {
  const persistenceMap = new Map<string, Persistence>();

  function getPersistence(sessionId: string): Persistence {
    let p = persistenceMap.get(sessionId);
    if (!p) {
      p = new Persistence(getDataDir(), sessionId, onPersistenceError);
      persistenceMap.set(sessionId, p);
    }
    return p;
  }

  // One sink per TreeManager, subscribed once at construction (before any
  // handler can run a mutation) so the first session-created is captured.
  const sink = new JournalSink(getPersistence);
  sink.subscribe(tm);

  function toolResult(text: string, isError = false) {
    return { content: [{ type: 'text' as const, text }], isError };
  }

  /**
   * Wraps a tool body in the invariant skeleton shared by every mutating
   * handler: Zod parse → run `fn` → (when `fn` reports a sessionId) await the
   * journal drain so the write lands before the result returns → toolResult.
   * The one error mapping (ZodError → validation message, TreeError → its
   * message, anything else → "Unknown error") lives here once. `fn` supplies
   * only the varying body and returns the response text plus, for mutators, the
   * sessionId whose journal must be flushed.
   */
  function dispatch<S extends z.ZodTypeAny>(
    schema: S,
    fn: (input: z.infer<S>) => { text: string; sessionId?: string },
  ): ToolHandler {
    return async (args) => {
      try {
        const { text, sessionId } = fn(schema.parse(args));
        if (sessionId) {
          // The in-memory mutation succeeded, but if its journal append failed
          // the state was not durably recorded — acknowledge the failure rather
          // than reporting a success the next restart would silently drop.
          const persistFailed = await sink.drain(sessionId);
          if (persistFailed) {
            return toolResult(
              `Error: the change was applied in memory but could not be saved to disk; it will be lost on restart. Check the data directory is writable.`,
              true,
            );
          }
        }
        return toolResult(text);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return toolResult(`Validation error: ${e.issues.map(i => i.message).join(', ')}`, true);
        }
        return toolResult(`Error: ${e instanceof TreeError ? e.message : 'Unknown error'}`, true);
      }
    };
  }

  const handlers = new Map<string, ToolHandler>();

  handlers.set('create_tree', dispatch(TOOL_DEFS.create_tree.input, ({ problem }) => {
    const { session, root } = tm.createSession(problem);
    return { text: fmt.formatCreateTree(session.id, root.id, problem), sessionId: session.id };
  }));

  handlers.set('decompose', dispatch(TOOL_DEFS.decompose.input, ({ parentId, children }) => {
    const created = tm.decompose(parentId, children);
    const check = tm.validateDecomposition(parentId);
    return { text: fmt.formatDecompose(created, check, tm), sessionId: created[0].sessionId };
  }));

  handlers.set('add_hypothesis', dispatch(TOOL_DEFS.add_hypothesis.input, ({ parentId, content }) => {
    const hypothesis = tm.addHypothesis(parentId, content);
    return { text: fmt.formatAddHypothesis(hypothesis, tm), sessionId: hypothesis.sessionId };
  }));

  handlers.set('add_evidence', dispatch(TOOL_DEFS.add_evidence.input, ({ hypothesisId, type, content, source }) => {
    tm.addEvidence(hypothesisId, type, content, source);
    // Re-read: addEvidence returns the cascade detail, but the formatter needs
    // the post-mutation hypothesis snapshot.
    const hypothesis = tm.getHypothesis(hypothesisId)!;
    return { text: fmt.formatAddEvidence(hypothesisId, hypothesis, tm), sessionId: hypothesis.sessionId };
  }));

  handlers.set('eliminate_hypothesis', dispatch(TOOL_DEFS.eliminate_hypothesis.input, ({ hypothesisId, reason, refutingEvidenceIds }) => {
    const hypothesis = tm.eliminateHypothesis(hypothesisId, reason, refutingEvidenceIds);
    return { text: fmt.formatEliminate(hypothesis, tm), sessionId: hypothesis.sessionId };
  }));

  handlers.set('corroborate_hypothesis', dispatch(TOOL_DEFS.corroborate_hypothesis.input, ({ hypothesisId, reason }) => {
    const hypothesis = tm.corroborateHypothesis(hypothesisId, reason);
    return { text: fmt.formatCorroborate(hypothesis, tm), sessionId: hypothesis.sessionId };
  }));

  handlers.set('set_out_of_scope', dispatch(TOOL_DEFS.set_out_of_scope.input, ({ hypothesisId, reason }) => {
    const hypothesis = tm.setOutOfScope(hypothesisId, reason);
    return { text: fmt.formatSetOutOfScope(hypothesis, tm), sessionId: hypothesis.sessionId };
  }));

  // Read-only: no sessionId → dispatch skips the drain.
  handlers.set('validate_decomposition', dispatch(TOOL_DEFS.validate_decomposition.input, ({ parentId }) => {
    const check = tm.validateDecomposition(parentId);
    return { text: fmt.formatValidateDecomposition(parentId, check) };
  }));

  // get_tree returns a non-thrown isError result ("No such session"), which the
  // dispatch {text, sessionId} contract has no channel for, so it registers
  // directly.
  handlers.set('get_tree', async (args) => {
    try {
      const { format, sessionId } = TOOL_DEFS.get_tree.input.parse(args);
      if (sessionId && !tm.hasSession(sessionId)) {
        return toolResult(`No such session: ${sessionId}`, true);
      }
      const state = tm.getTree(sessionId);
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
    return toolResult(fmt.formatStatus(tm, getDashboardUrl?.() ?? null));
  });

  return { handlers, drainAll: () => sink.drainAll() };
}

// ─── MCP Registration (wraps getToolHandlers for McpServer) ───

/**
 * Registers all tools on an McpServer instance (for direct in-process MCP usage).
 * Wraps getToolHandlers to bridge between McpServer's registration API and our
 * handler map. Returns `drainAll`, which resolves once every enqueued journal
 * append has settled — a host awaits it on shutdown so no acknowledged
 * mutation is lost to process exit.
 * @param server - The MCP server instance to register tools on
 * @param tm - TreeManager for hypothesis state
 * @param getDataDir - Thunk returning the persistence directory
 * @param opts.getDashboardUrl - Optional thunk returning the live dashboard URL, surfaced in get_status
 * @param opts.onPersistenceError - Optional callback fired when a journal append fails
 */
export function registerTools(
  server: McpServer,
  tm: TreeManager,
  getDataDir: () => string,
  opts: { getDashboardUrl?: () => string | null; onPersistenceError?: (err: Error) => void } = {},
): { drainAll: () => Promise<void> } {
  const { handlers, drainAll } = getToolHandlers(tm, getDataDir, opts.onPersistenceError, opts.getDashboardUrl);

  for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
    const handler = handlers.get(name)!;
    server.tool(name, schema.description, schema.schema, async (args: any) => {
      return handler(args);
    });
  }

  return { drainAll };
}

// ─── Helpers ───

function renderCompactTree(
  hypotheses: Map<string, import('./types.js').Hypothesis>,
  nodeId: string,
  indent: string,
  visited: Set<string> = new Set(),
): string {
  const node = hypotheses.get(nodeId);
  if (!node) return '';
  // Guard against a children cycle from a corrupt/hand-edited journal so a
  // get_tree render terminates instead of overflowing the stack.
  if (visited.has(nodeId)) return `${indent}↺ (cycle)\n`;
  visited.add(nodeId);

  let line = `${indent}${STATUS_ICONS[node.status]} ${nodeLabel(node)}\n`;

  for (const childId of node.children) {
    line += renderCompactTree(hypotheses, childId, indent + '  ', visited);
  }

  return line;
}
