import type { Node, Edge } from '@xyflow/react';
import { flextree } from 'd3-flextree';
import { hierarchy } from 'd3-hierarchy';
import { isPruned, nodeLabel, sessionIsGrounded, type Hypothesis, type HypothesisData, type SplitFace } from '../types';
import { evidenceLedger } from '../tree/evidenceView';
import { splitAttention, splitBadge } from '../tree/splitView';
import { HIGHLIGHT_COLORS } from '../theme';
import { NODE_WIDTH, NODE_HEIGHT, NODE_GAP_X, NODE_GAP_Y } from '../geometry';
import { walkToRoot } from '../tree/walk';

/**
 * Pure tree-layout logic for the dashboard, kept free of React so it can be
 * unit-tested directly: path-to-root highlighting and the flextree node/edge
 * computation (including transient-orphan adoption).
 */


/** Returns the set of node ids on the path from `nodeId` up to the root. */
export function getPathToRoot(nodeId: string, hypotheses: Map<string, Hypothesis>): Set<string> {
  const path = new Set<string>();
  for (const node of walkToRoot(nodeId, hypotheses)) path.add(node.id);
  return path;
}

/**
 * Computes the React Flow nodes and edges for the visible tree: walks from the
 * root through non-collapsed children, adopts transient orphans (a child that
 * arrived a render before its parent's children[] update), runs the flextree
 * layout, and styles edges by path/pruned/exploring state.
 */
export function computeLayout(
  hypotheses: Map<string, Hypothesis>,
  rootId: string,
  selectedId: string | null,
  pathToRoot: Set<string>,
  collapsedIds: Set<string>,
): { nodes: Node<HypothesisData>[]; edges: Edge[] } {
  // Determine visible nodes
  const visibleIds = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visibleIds.has(id)) continue;
    visibleIds.add(id);
    if (!collapsedIds.has(id)) {
      const h = hypotheses.get(id);
      if (h) queue.push(...h.children);
    }
  }

  // Adopt transient orphans: a 'hypothesis-added' child can arrive a render
  // before its parent's 'hypothesis-updated' appends it to parent.children.
  // Such a node carries a valid parentId reaching a visible ancestor, so pull
  // it (and its own children) in via the parentId chain rather than dropping
  // it for that frame. Skip nodes whose nearest visible ancestor is collapsed.
  const orphanChildren = new Map<string, string[]>(); // parentId → [childId]
  for (const [id, h] of hypotheses) {
    if (visibleIds.has(id) || !h.parentId) continue;
    // Walk up parentId to decide visibility; guard against cycles.
    const chain: string[] = [];
    let cursor: string | null = id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      if (visibleIds.has(cursor)) break;
      cursor = hypotheses.get(cursor)?.parentId ?? null;
    }
    const anchor = cursor;
    if (anchor && visibleIds.has(anchor) && !collapsedIds.has(anchor)) {
      for (const cid of chain) {
        if (cid === anchor) continue;
        visibleIds.add(cid);
        const parentId = hypotheses.get(cid)?.parentId;
        if (parentId) {
          const list = orphanChildren.get(parentId) ?? [];
          if (!list.includes(cid)) list.push(cid);
          orphanChildren.set(parentId, list);
        }
      }
    }
  }

  // Build hierarchy for flextree. `visited` guards against a children[] cycle
  // in a corrupt tree so the recursion cannot stack-overflow the render thread;
  // a single shared set is correct because each node has at most one parent, so
  // a node reached twice is a cycle, not legitimate re-parenting.
  interface TreeData { id: string; children?: TreeData[] }
  function buildTree(id: string, visited: Set<string> = new Set()): TreeData {
    const h = hypotheses.get(id);
    if (!h || collapsedIds.has(id)) return { id };
    visited.add(id);
    // Merge real children with any adopted orphans not yet in h.children, and
    // drop any child already on the current path — a back-edge is a cycle in a
    // corrupt tree, and skipping it both prevents infinite recursion and avoids
    // emitting the node twice into the layout.
    const declared = h.children.filter((c) => visibleIds.has(c) && !visited.has(c));
    const adopted = (orphanChildren.get(id) ?? []).filter((c) => !declared.includes(c) && !visited.has(c));
    const childIds = [...declared, ...adopted];
    const children = childIds.map((c) => buildTree(c, visited));
    return children.length > 0 ? { id, children } : { id };
  }

  const root = hierarchy(buildTree(rootId), (d) => d.children);

  // Run flextree layout (keeps children grouped under parent)
  const layout = flextree<TreeData>()
    .nodeSize(() => [NODE_WIDTH + NODE_GAP_X, NODE_HEIGHT + NODE_GAP_Y])
    .spacing((a, b) => (a.parent === b.parent ? 20 : 40));

  const tree = layout(root);

  // Whether this session captured any verbatim record at all. Computed once:
  // the ungrounded mark is only meaningful relative to a session that does.
  const sessionGrounded = sessionIsGrounded(hypotheses.values());

  // Convert to React Flow nodes + edges
  const nodes: Node<HypothesisData>[] = [];
  const edges: Edge[] = [];

  for (const treeNode of tree.descendants()) {
    const id = treeNode.data.id;
    const h = hypotheses.get(id);
    if (!h) continue;

    const isOnPath = pathToRoot.has(id);
    const isCollapsed = collapsedIds.has(id) && h.children.length > 0;

    nodes.push({
      id,
      type: 'hypothesis',
      position: { x: treeNode.x - NODE_WIDTH / 2, y: treeNode.y },
      // The same box the spacing above reserved. Stating it on the node lets
      // overview widgets place the node before the DOM has measured it, and
      // spares the canvas a measure-then-relayout pass.
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: {
        label: nodeLabel(h),
        ledger: evidenceLedger(h, { sessionGrounded }),
        split: splitFace(h, hypotheses),
        status: h.status,
        selected: id === selectedId,
        childCount: h.children.length,
        onPath: isOnPath,
        collapsed: isCollapsed,
        hiddenChildren: isCollapsed ? h.children.length : 0,
      },
    });

    if (h.parentId && visibleIds.has(h.parentId)) {
      const isEdgeOnPath = pathToRoot.has(id) && pathToRoot.has(h.parentId);
      edges.push({
        id: `${h.parentId}-${id}`,
        source: h.parentId,
        target: id,
        style: {
          stroke: isEdgeOnPath
            ? HIGHLIGHT_COLORS.pathEdge
            : isPruned(h.status)
              ? HIGHLIGHT_COLORS.prunedEdge
              : HIGHLIGHT_COLORS.defaultEdge,
          strokeWidth: isEdgeOnPath ? 2.5 : 1.5,
        },
        animated: h.status === 'exploring',
      });
    }
  }

  return { nodes, edges };
}

/**
 * What a node face shows about its split, or null when it has none. The badge
 * carries which kind of attention the split needs rather than the finding text:
 * a face states that much, and the panel says how.
 */
function splitFace(h: Hypothesis, hypotheses: Map<string, Hypothesis>): SplitFace | null {
  const badge = splitBadge(h);
  if (!badge) return null;
  return { ...badge, attention: splitAttention(h, hypotheses) };
}

/**
 * The nodes a viewport may be framed on for a given selection: the selection
 * itself plus its visible children, restricted to what the canvas is actually
 * rendering.
 *
 * Empty when the selection is not on screen — a node inside a collapsed subtree
 * has no box to frame, and framing an id the canvas does not hold computes empty
 * bounds, which sends the viewport to the layout origin at full zoom. Both fit
 * effects ask this, so neither can frame something the other would refuse.
 */
export function framableNodeIds(
  selectedId: string,
  hypotheses: Map<string, Hypothesis>,
  collapsedIds: Set<string>,
  renderedIds: Set<string>,
): { id: string }[] {
  const h = hypotheses.get(selectedId);
  const wanted = h
    ? [selectedId, ...h.children.filter((c) => !collapsedIds.has(c))]
    : [selectedId];
  return wanted.filter((id) => renderedIds.has(id)).map((id) => ({ id }));
}
