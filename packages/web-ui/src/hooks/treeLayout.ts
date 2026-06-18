import type { Node, Edge } from '@xyflow/react';
import { flextree } from 'd3-flextree';
import { hierarchy } from 'd3-hierarchy';
import { isPruned, type Hypothesis, type HypothesisData } from '../types';
import { HIGHLIGHT_COLORS } from '../theme';
import { walkToRoot } from '../tree/walk';

/**
 * Pure tree-layout logic for the dashboard, kept free of React so it can be
 * unit-tested directly: path-to-root highlighting and the flextree node/edge
 * computation (including transient-orphan adoption).
 */

const NODE_WIDTH = 240;
const NODE_HEIGHT = 100;

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

  // Build hierarchy for flextree
  interface TreeData { id: string; children?: TreeData[] }
  function buildTree(id: string): TreeData {
    const h = hypotheses.get(id);
    if (!h || collapsedIds.has(id)) return { id };
    // Merge real children with any adopted orphans not yet in h.children.
    const declared = h.children.filter((c) => visibleIds.has(c));
    const adopted = (orphanChildren.get(id) ?? []).filter((c) => !declared.includes(c));
    const childIds = [...declared, ...adopted];
    const children = childIds.map(buildTree);
    return children.length > 0 ? { id, children } : { id };
  }

  const root = hierarchy(buildTree(rootId), (d) => d.children);

  // Run flextree layout (keeps children grouped under parent)
  const layout = flextree<TreeData>()
    .nodeSize(() => [NODE_WIDTH + 40, NODE_HEIGHT + 60])
    .spacing((a, b) => (a.parent === b.parent ? 20 : 40));

  const tree = layout(root);

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
      data: {
        label: h.content,
        status: h.status,
        evidenceCount: h.evidence.length,
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
