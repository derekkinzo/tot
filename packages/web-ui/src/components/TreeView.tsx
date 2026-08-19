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
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import HypothesisNode, { type HypothesisData } from './HypothesisNode';
import StatusSummary from './StatusSummary';
import Breadcrumb from './Breadcrumb';
import Legend from './Legend';
import FollowIndicator from './FollowIndicator';
import SessionSelector from './SessionSelector';
import { type Hypothesis, type Session } from '../types';
import { STATUS_COLORS } from '../theme';
import { getPathToRoot, computeLayout } from '../hooks/treeLayout';
import { nextNavTarget } from '../hooks/navTarget';

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
  panelOpen: boolean;
  recentlyChanged: Set<string>;
  lastAddedId: string | null;
  // Overlay props
  connected: boolean;
  session: Session | null;
  followMode: 'following' | 'paused';
  onToggleFollow: () => void;
  onLoadSession: (id: string) => void;
}

interface ContextMenuState {
  nodeId: string;
  x: number;
  y: number;
}

function TreeViewInner({ hypotheses, rootId, selectedId, onSelect, panelOpen, recentlyChanged, lastAddedId, connected, session, followMode, onToggleFollow, onLoadSession }: Props) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const { fitView } = useReactFlow();

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
        ? [{ id: selectedId }, ...h.children.filter(c => !collapsedIds.has(c)).map(id => ({ id }))]
        : [{ id: selectedId }];
      requestAnimationFrame(() => {
        fitView({ nodes: nodeIds, duration: DURATION_STANDARD, padding: FIT_PADDING_FOCUSED, maxZoom: FIT_MAX_ZOOM });
      });
    } else {
      requestAnimationFrame(() => {
        fitView({ duration: DURATION_QUICK, padding: FIT_PADDING_OVERVIEW, maxZoom: FIT_MAX_ZOOM });
      });
    }
  }, [selectedId, hypotheses, collapsedIds, fitView]);

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
          fitView({ nodes: nodeIds, duration: DURATION_INSTANT, padding: FIT_PADDING_FOCUSED, maxZoom: FIT_MAX_ZOOM });
        } else {
          fitView({ duration: DURATION_INSTANT, padding: FIT_PADDING_OVERVIEW, maxZoom: FIT_MAX_ZOOM });
        }
      }, 50);
    }
  }, [panelOpen, selectedId, hypotheses, fitView]);

  // With no selection (follow paused and deselected), keep the whole tree
  // framed as nodes arrive. When following, the selection effect above
  // focuses the active node instead.
  useEffect(() => {
    if (lastAddedId && !selectedId) {
      requestAnimationFrame(() => {
        fitView({ duration: DURATION_STANDARD, padding: FIT_PADDING_OVERVIEW, maxZoom: FIT_MAX_ZOOM });
      });
    }
  }, [lastAddedId, selectedId, hypotheses, fitView]);

  // Fit all when node count changes and no specific focus
  const prevNodeCount = useRef(nodes.length);
  useEffect(() => {
    if (nodes.length !== prevNodeCount.current && !selectedId && !lastAddedId) {
      requestAnimationFrame(() => {
        fitView({ duration: DURATION_QUICK, padding: FIT_PADDING_OVERVIEW, maxZoom: FIT_MAX_ZOOM });
      });
    }
    prevNodeCount.current = nodes.length;
  }, [nodes.length, selectedId, lastAddedId, fitView]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onSelect(null);
        setContextMenu(null);
        return;
      }
      const targetId = nextNavTarget(e.key, selectedId, hypotheses);
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
        fitView({ nodes: nodeIds, duration: DURATION_DELIBERATE, padding: FIT_PADDING_FOCUSED, maxZoom: FIT_MAX_ZOOM });
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
          // Swallow a rejected writeText Promise (unfocused doc / denied
          // permission) so it doesn't surface as an unhandledrejection.
          void Promise.resolve(navigator.clipboard?.writeText(h.content)).catch(() => {});
        }
        break;
      }
      case 'select': {
        onSelect(nodeId);
        break;
      }
    }
    setContextMenu(null);
  }, [hypotheses, fitView, onSelect]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: FIT_PADDING_OVERVIEW, maxZoom: FIT_MAX_ZOOM }}
        minZoom={GLOBAL_MIN_ZOOM}
        maxZoom={GLOBAL_MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#30363d" gap={20} />
        {/* Controls and MiniMap each own a bottom corner; no Panel shares
            those corners, so the zoom/fit buttons stay clickable. */}
        <Controls position="bottom-left" />
        <MiniMap
          position="bottom-right"
          nodeColor={(n) => STATUS_COLORS[(n.data as HypothesisData)?.status as keyof typeof STATUS_COLORS] ?? '#6b7280'}
          style={{ background: '#1c1f26', border: '1px solid #30363d' }}
        />

        {/* Info overlays cluster in the top corners, each corner a vertical
            stack so widgets flow instead of overlapping. */}
        <Panel position="top-left">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="overlay-widget" style={{ fontSize: 13 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: connected ? '#3fb950' : '#f85149' }}>●</span>
                {session ? (
                  <>
                    <span>{session.problem.slice(0, 50)}{session.problem.length > 50 ? '...' : ''}</span>
                    <SessionSelector currentSessionId={session.id} onSwitch={(id) => { onLoadSession(id); onSelect(null); }} />
                  </>
                ) : (
                  <span style={{ color: '#8b949e' }}>Waiting for session...</span>
                )}
              </div>
            </div>
            {selectedId && <Breadcrumb selectedId={selectedId} hypotheses={hypotheses} onNavigate={onSelect} />}
            <StatusSummary hypotheses={hypotheses} session={session} />
          </div>
        </Panel>

        <Panel position="top-right">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
            {session && (
              <FollowIndicator followMode={followMode} onToggle={onToggleFollow} />
            )}
            <Legend />
          </div>
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

