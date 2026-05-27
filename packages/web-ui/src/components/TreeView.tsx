import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Panel,
  useReactFlow,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from '@xyflow/react';
import { flextree } from 'd3-flextree';
import { hierarchy } from 'd3-hierarchy';
import '@xyflow/react/dist/style.css';
import HypothesisNode, { type HypothesisData } from './HypothesisNode';
import StatusSummary from './StatusSummary';
import Breadcrumb from './Breadcrumb';
import Legend from './Legend';
import FollowIndicator from './FollowIndicator';
import SessionSelector from './SessionSelector';
import ProjectSelector from './ProjectSelector';
import type { Hypothesis, Session } from '../types';
import type { ProjectInfo } from '../hooks/useTreeStream';
import { STATUS_COLORS, HIGHLIGHT_COLORS } from '../theme';

const NODE_WIDTH = 240;
const NODE_HEIGHT = 100;
const FIT_MAX_ZOOM = 1.5;
const FIT_PADDING_FOCUSED = 0.3;
const FIT_PADDING_OVERVIEW = 0.12;
const DURATION_INSTANT = 150;
const DURATION_QUICK = 200;
const DURATION_STANDARD = 250;
const DURATION_DELIBERATE = 300;
const GLOBAL_MIN_ZOOM = 0.05;
const GLOBAL_MAX_ZOOM = 2;
const nodeTypes = { hypothesis: HypothesisNode };

interface Props {
  hypotheses: Map<string, Hypothesis>;
  rootId: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onUserViewportInteraction?: () => void;
  panelOpen: boolean;
  recentlyChanged: Set<string>;
  lastAddedId: string | null;
  // Overlay props
  connected: boolean;
  session: Session | null;
  followMode: 'following' | 'paused' | 'off';
  onToggleFollow: () => void;
  onLoadSession: (id: string) => void;
  onProgrammaticSelect: (id: string | null) => void;
  projects: ProjectInfo[];
  currentProject: string;
  onSwitchProject: (dir: string) => void;
  projectLabel: string;
}

interface ContextMenuState {
  nodeId: string;
  x: number;
  y: number;
}

function TreeViewInner({ hypotheses, rootId, selectedId, onSelect, onUserViewportInteraction, panelOpen, recentlyChanged, lastAddedId, connected, session, followMode, onToggleFollow, onLoadSession, onProgrammaticSelect, projects, currentProject, onSwitchProject, projectLabel }: Props) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const { fitView } = useReactFlow();

  // Track whether a viewport move was triggered programmatically (fitView)
  const isProgrammaticMove = useRef(true);

  // Override fitView to mark moves as programmatic
  const fitViewTracked: typeof fitView = useCallback((...args) => {
    isProgrammaticMove.current = true;
    return fitView(...args);
  }, [fitView]);

  const onMoveEnd = useCallback(() => {
    if (isProgrammaticMove.current) {
      isProgrammaticMove.current = false;
      return;
    }
    // User manually panned or zoomed
    onUserViewportInteraction?.();
  }, [onUserViewportInteraction]);

  const hypothesesRef = useRef(hypotheses);
  hypothesesRef.current = hypotheses;

  const toggleCollapse = useCallback((nodeId: string) => {
    const h = hypothesesRef.current.get(nodeId);
    if (h && h.children.length > 0) {
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        return next;
      });
    }
  }, []);

  const pathToRoot = useMemo(() => {
    if (!selectedId) return new Set<string>();
    return getPathToRoot(selectedId, hypotheses);
  }, [selectedId, hypotheses]);

  const { nodes, edges } = useMemo(() => {
    if (!rootId || hypotheses.size === 0) return { nodes: [], edges: [] };
    const result = computeLayout(hypotheses, rootId, selectedId, pathToRoot, collapsedIds);
    for (const node of result.nodes) {
      if (recentlyChanged.has(node.id)) {
        const h = hypotheses.get(node.id);
        if (h) node.data.pulseClass = `node-pulse-${h.status}`;
      }
      if (node.id === lastAddedId) {
        node.data.pulseClass = (node.data.pulseClass || '') + ' node-new';
      }
      node.data.onToggleCollapse = toggleCollapse;
    }
    return result;
  }, [hypotheses, rootId, selectedId, pathToRoot, collapsedIds, recentlyChanged]);

  // Zoom to selected node + its children, or fit all when deselected
  const prevSelectedId = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId === prevSelectedId.current) return;
    prevSelectedId.current = selectedId;

    if (selectedId) {
      const h = hypotheses.get(selectedId);
      const nodeIds = h
        ? [{ id: selectedId }, ...h.children.filter(c => !collapsedIds.has(selectedId)).map(id => ({ id }))]
        : [{ id: selectedId }];
      requestAnimationFrame(() => {
        fitViewTracked({ nodes: nodeIds, duration: DURATION_STANDARD, padding: FIT_PADDING_FOCUSED, maxZoom: FIT_MAX_ZOOM });
      });
    } else {
      requestAnimationFrame(() => {
        fitViewTracked({ duration: DURATION_QUICK, padding: FIT_PADDING_OVERVIEW, maxZoom: FIT_MAX_ZOOM });
      });
    }
  }, [selectedId, hypotheses, collapsedIds, fitViewTracked]);

  // Fit when panel opens/closes (container resizes)
  const prevPanelOpen = useRef(panelOpen);
  useEffect(() => {
    if (panelOpen !== prevPanelOpen.current) {
      prevPanelOpen.current = panelOpen;
      setTimeout(() => {
        if (selectedId) {
          const h = hypotheses.get(selectedId);
          const nodeIds = h
            ? [{ id: selectedId }, ...h.children.map(id => ({ id }))]
            : [{ id: selectedId }];
          fitViewTracked({ nodes: nodeIds, duration: DURATION_INSTANT, padding: FIT_PADDING_FOCUSED, maxZoom: FIT_MAX_ZOOM });
        } else {
          fitViewTracked({ duration: DURATION_INSTANT, padding: FIT_PADDING_OVERVIEW, maxZoom: FIT_MAX_ZOOM });
        }
      }, 50);
    }
  }, [panelOpen, selectedId, hypotheses, fitViewTracked]);

  // Auto-fit entire tree when nodes change and no selection (follow mode)
  useEffect(() => {
    if (lastAddedId && !selectedId) {
      requestAnimationFrame(() => {
        fitViewTracked({ duration: DURATION_STANDARD, padding: FIT_PADDING_OVERVIEW, maxZoom: FIT_MAX_ZOOM });
      });
    }
  }, [lastAddedId, selectedId, hypotheses, fitViewTracked]);

  // Fit all when node count changes and no specific focus
  const prevNodeCount = useRef(nodes.length);
  useEffect(() => {
    if (nodes.length !== prevNodeCount.current && !selectedId && !lastAddedId) {
      prevNodeCount.current = nodes.length;
      requestAnimationFrame(() => {
        fitViewTracked({ duration: DURATION_QUICK, padding: FIT_PADDING_OVERVIEW, maxZoom: FIT_MAX_ZOOM });
      });
    }
    prevNodeCount.current = nodes.length;
  }, [nodes.length, selectedId, lastAddedId, fitViewTracked]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onSelect(null);
        setContextMenu(null);
        return;
      }
      if (!selectedId) return;
      const h = hypotheses.get(selectedId);
      if (!h) return;

      let targetId: string | null = null;
      switch (e.key) {
        case 'ArrowUp':
          if (h.parentId) targetId = h.parentId;
          break;
        case 'ArrowDown':
          if (h.children.length > 0) targetId = h.children[0];
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (!h.parentId) break;
          const parent = hypotheses.get(h.parentId);
          if (!parent) break;
          const idx = parent.children.indexOf(selectedId);
          const next = idx + (e.key === 'ArrowLeft' ? -1 : 1);
          if (next >= 0 && next < parent.children.length) targetId = parent.children[next];
          break;
        }
      }
      if (targetId) {
        e.preventDefault();
        onSelect(targetId);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedId, hypotheses, onSelect]);

  const onNodeClick: NodeMouseHandler = useCallback((event, node) => {
    setContextMenu(null);
    if (event.altKey) {
      toggleCollapse(node.id);
      return;
    }
    onSelect(node.id === selectedId ? null : node.id);
  }, [onSelect, selectedId, toggleCollapse]);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    setContextMenu({ nodeId: node.id, x: event.clientX, y: event.clientY });
  }, []);

  const onPaneClick = useCallback(() => {
    onSelect(null);
    setContextMenu(null);
  }, [onSelect]);

  const handleContextAction = useCallback((action: string, nodeId: string) => {
    switch (action) {
      case 'collapse': {
        setCollapsedIds((prev) => {
          const next = new Set(prev);
          if (next.has(nodeId)) next.delete(nodeId);
          else next.add(nodeId);
          return next;
        });
        break;
      }
      case 'zoom': {
        const h = hypotheses.get(nodeId);
        const nodeIds = h ? [{ id: nodeId }, ...h.children.map(id => ({ id }))] : [{ id: nodeId }];
        fitViewTracked({ nodes: nodeIds, duration: DURATION_DELIBERATE, padding: FIT_PADDING_FOCUSED, maxZoom: FIT_MAX_ZOOM });
        break;
      }
      case 'parent': {
        const h = hypotheses.get(nodeId);
        if (h?.parentId) onSelect(h.parentId);
        break;
      }
      case 'copy': {
        const h = hypotheses.get(nodeId);
        if (h) {
          try {
            navigator.clipboard?.writeText(h.content);
          } catch { /* clipboard unavailable in this context */ }
        }
        break;
      }
      case 'select': {
        onSelect(nodeId);
        break;
      }
    }
    setContextMenu(null);
  }, [hypotheses, fitViewTracked, onSelect]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        onMoveEnd={onMoveEnd}
        fitView
        fitViewOptions={{ padding: FIT_PADDING_OVERVIEW, maxZoom: FIT_MAX_ZOOM }}
        minZoom={GLOBAL_MIN_ZOOM}
        maxZoom={GLOBAL_MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#30363d" gap={20} />
        <Controls position="bottom-right" />
        <MiniMap
          nodeColor={(n) => STATUS_COLORS[(n.data as HypothesisData)?.status as keyof typeof STATUS_COLORS] ?? '#6b7280'}
          style={{ background: '#1c1f26', border: '1px solid #30363d' }}
        />

        {/* Overlays via Panel */}
        <Panel position="top-left">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="overlay-widget" style={{ fontSize: 13 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: connected ? '#3fb950' : '#f85149' }}>●</span>
                {session ? (
                  <>
                    <span>{session.problem.slice(0, 50)}{session.problem.length > 50 ? '...' : ''}</span>
                    <SessionSelector currentSessionId={session.id} onSwitch={(id) => { onLoadSession(id); onProgrammaticSelect(null); }} project={currentProject} />
                    {projects.length > 1 && (
                      <ProjectSelector projects={projects} currentProject={currentProject} onSwitch={(dir) => { onSwitchProject(dir); onProgrammaticSelect(null); }} />
                    )}
                  </>
                ) : (
                  <span style={{ color: '#8b949e' }}>
                    Waiting for session...
                    {projects.length > 1 && (
                      <ProjectSelector projects={projects} currentProject={currentProject} onSwitch={(dir) => { onSwitchProject(dir); onProgrammaticSelect(null); }} />
                    )}
                    {projectLabel && <span style={{ fontSize: 10, color: '#6b7280', marginLeft: 8 }}>{projectLabel}</span>}
                  </span>
                )}
              </div>
              {session && projectLabel && (
                <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2, fontFamily: 'monospace' }}>
                  {projectLabel}
                </div>
              )}
            </div>
            {selectedId && <Breadcrumb selectedId={selectedId} hypotheses={hypotheses} onNavigate={onSelect} />}
          </div>
        </Panel>

        <Panel position="top-right">
          {session && followMode !== 'off' && (
            <FollowIndicator followMode={followMode} onToggle={onToggleFollow} />
          )}
        </Panel>

        <Panel position="bottom-left">
          <StatusSummary hypotheses={hypotheses} session={session} />
        </Panel>

        <Panel position="bottom-right">
          <Legend />
        </Panel>
      </ReactFlow>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodeId={contextMenu.nodeId}
          hypotheses={hypotheses}
          collapsedIds={collapsedIds}
          onAction={handleContextAction}
        />
      )}
    </div>
  );
}

export default function TreeView(props: Props) {
  return (
    <ReactFlowProvider>
      <TreeViewInner {...props} />
    </ReactFlowProvider>
  );
}

// ─── Context Menu ───

function ContextMenu({ x, y, nodeId, hypotheses, collapsedIds, onAction }: {
  x: number; y: number; nodeId: string;
  hypotheses: Map<string, Hypothesis>;
  collapsedIds: Set<string>;
  onAction: (action: string, nodeId: string) => void;
}) {
  const h = hypotheses.get(nodeId);
  const hasChildren = h && h.children.length > 0;
  const isCollapsed = collapsedIds.has(nodeId);
  const hasParent = h && h.parentId;

  return (
    <div style={{
      position: 'fixed', left: x, top: y, zIndex: 1000,
      background: '#1c1f26', border: '1px solid #30363d', borderRadius: 8,
      padding: '4px 0', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      minWidth: 180,
    }}>
      <MenuItem label="View details" shortcut="Click" onClick={() => onAction('select', nodeId)} />
      <MenuItem label="Zoom to subtree" shortcut="" onClick={() => onAction('zoom', nodeId)} />
      {hasChildren && (
        <MenuItem
          label={isCollapsed ? 'Expand subtree' : 'Collapse subtree'}
          shortcut="Dbl-click"
          onClick={() => onAction('collapse', nodeId)}
        />
      )}
      {hasParent && (
        <MenuItem label="Jump to parent" shortcut="↑" onClick={() => onAction('parent', nodeId)} />
      )}
      <div style={{ height: 1, background: '#30363d', margin: '4px 0' }} />
      <MenuItem label="Copy text" shortcut="" onClick={() => onAction('copy', nodeId)} />
    </div>
  );
}

function MenuItem({ label, shortcut, onClick }: { label: string; shortcut: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', padding: '8px 14px', background: 'none', border: 'none',
        color: '#e1e4e8', fontSize: 13, cursor: 'pointer', textAlign: 'left',
      }}
      onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#21262d'; }}
      onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none'; }}
    >
      <span>{label}</span>
      {shortcut && <span style={{ color: '#6b7280', fontSize: 11 }}>{shortcut}</span>}
    </button>
  );
}

// ─── Path highlighting ───

function getPathToRoot(nodeId: string, hypotheses: Map<string, Hypothesis>): Set<string> {
  const path = new Set<string>();
  let current: string | null = nodeId;
  while (current) {
    path.add(current);
    const node = hypotheses.get(current);
    current = node?.parentId ?? null;
  }
  return path;
}

// ─── Layout computation ───

function computeLayout(
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

  // Build hierarchy for flextree
  interface TreeData { id: string; children?: TreeData[] }
  function buildTree(id: string): TreeData {
    const h = hypotheses.get(id);
    if (!h || collapsedIds.has(id)) return { id };
    const children = h.children.filter((c) => visibleIds.has(c)).map(buildTree);
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
        score: h.score,
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
          stroke: isEdgeOnPath ? HIGHLIGHT_COLORS.pathEdge : h.status === 'eliminated' ? HIGHLIGHT_COLORS.eliminatedEdge : HIGHLIGHT_COLORS.defaultEdge,
          strokeWidth: isEdgeOnPath ? 2.5 : 1.5,
        },
        animated: h.status === 'exploring',
      });
    }
  }

  return { nodes, edges };
}
