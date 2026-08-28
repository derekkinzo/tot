import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Panel,
  useReactFlow,
  useStore,
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
import { nodeLabel, type Hypothesis, type Session } from '../types';
import { STATUS_COLORS, TEXT } from '../theme';
import { getPathToRoot, computeLayout, framableNodeIds } from '../hooks/treeLayout';
import { nextNavTarget } from '../hooks/navTarget';
import { canvasOwnsKey, type KeyTarget } from '../hooks/keyboardOwnership';
import { HEADER_TEXT_MAX_WIDTH, MINIMAP_MAX_WIDTH, overlayFit } from '../geometry';

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
  /** A session the agent started while this one is on screen, or null. */
  newerSession: Session | null;
  /** Layers stacked above the canvas that read keys; while any is open the
   *  canvas shortcuts stand down. */
  overlayCount: number;
}

interface ContextMenuState {
  nodeId: string;
  x: number;
  y: number;
}

function TreeViewInner({ hypotheses, rootId, selectedId, onSelect, panelOpen, recentlyChanged, lastAddedId, connected, session, followMode, onToggleFollow, onLoadSession, newerSession, overlayCount }: Props) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const { fitView } = useReactFlow();
  // The overlays compete for the canvas, not for the window: a detail panel beside
  // it can leave far less room than the viewport suggests.
  const canvasWidth = useStore((s) => s.width);
  const fit = overlayFit(canvasWidth);

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
  const renderedIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);

  // Tracks the selection the viewport was last framed on, not merely the last
  // selection seen: a selection that could not be framed yet — one inside a
  // collapsed subtree — must still be framed when it appears, so the guard only
  // advances once the fit actually happened.
  const framedSelection = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId === framedSelection.current) return;

    if (selectedId) {
      const nodeIds = framableNodeIds(selectedId, hypotheses, collapsedIds, renderedIds);
      if (nodeIds.length === 0) return;
      framedSelection.current = selectedId;
      requestAnimationFrame(() => {
        fitView({ nodes: nodeIds, duration: DURATION_STANDARD, padding: FIT_PADDING_FOCUSED, maxZoom: FIT_MAX_ZOOM });
      });
    } else {
      framedSelection.current = null;
      requestAnimationFrame(() => {
        fitView({ duration: DURATION_QUICK, padding: FIT_PADDING_OVERVIEW, maxZoom: FIT_MAX_ZOOM });
      });
    }
  }, [selectedId, hypotheses, collapsedIds, fitView, renderedIds]);

  // Fit when panel opens/closes (container resizes)
  const prevPanelOpen = useRef(panelOpen);
  useEffect(() => {
    if (panelOpen !== prevPanelOpen.current) {
      prevPanelOpen.current = panelOpen;
      setTimeout(() => {
        // Same rule as the selection effect: never frame an id the canvas is not
        // rendering, or the resize fit lands on the layout origin.
        const nodeIds = selectedId
          ? framableNodeIds(selectedId, hypotheses, collapsedIds, renderedIds)
          : [];
        if (nodeIds.length > 0) {
          fitView({ nodes: nodeIds, duration: DURATION_INSTANT, padding: FIT_PADDING_FOCUSED, maxZoom: FIT_MAX_ZOOM });
        } else {
          fitView({ duration: DURATION_INSTANT, padding: FIT_PADDING_OVERVIEW, maxZoom: FIT_MAX_ZOOM });
        }
      }, 50);
    }
  }, [panelOpen, selectedId, hypotheses, collapsedIds, renderedIds, fitView]);

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
      // A layer above the canvas owns the keyboard while it is open, including
      // Escape: closing it must not also clear the selection behind it.
      if (!canvasOwnsKey({ overlays: overlayCount, target: e.target as KeyTarget | null })) return;
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
  }, [selectedId, hypotheses, onSelect, overlayCount]);

  const onNodeClick: NodeMouseHandler = useCallback((event, node) => {
    setContextMenu(null);
    if (event.altKey) {
      toggleCollapse(node.id);
      return;
    }
    // The second click of a double-click also arrives here; letting it through
    // would toggle the selection back off while the double-click collapses.
    if (event.detail > 1) return;
    onSelect(node.id === selectedId ? null : node.id);
  }, [onSelect, selectedId, toggleCollapse]);

  const onNodeDoubleClick: NodeMouseHandler = useCallback((_event, node) => {
    setContextMenu(null);
    toggleCollapse(node.id);
  }, [toggleCollapse]);

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
        const nodeIds = framableNodeIds(nodeId, hypotheses, collapsedIds, renderedIds);
        if (nodeIds.length > 0) {
          fitView({ nodes: nodeIds, duration: DURATION_DELIBERATE, padding: FIT_PADDING_FOCUSED, maxZoom: FIT_MAX_ZOOM });
        }
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
          void Promise.resolve(navigator.clipboard?.writeText(h.statement ?? nodeLabel(h))).catch(() => {});
        }
        break;
      }
      case 'select': {
        onSelect(nodeId);
        break;
      }
    }
    setContextMenu(null);
  }, [hypotheses, collapsedIds, renderedIds, fitView, onSelect]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
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
        {fit.showMinimap && (
          <MiniMap
            position="bottom-right"
            nodeColor={(n) => STATUS_COLORS[(n.data as HypothesisData)?.status as keyof typeof STATUS_COLORS] ?? '#6b7280'}
            style={{ background: '#1c1f26', border: '1px solid #30363d', width: MINIMAP_MAX_WIDTH }}
          />
        )}

        {/* Info overlays cluster in the top corners, each corner a vertical
            stack so widgets flow instead of overlapping. */}
        <Panel position="top-left" style={{ maxWidth: fit.headerMaxWidth }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <div className="overlay-widget" style={{ fontSize: 13 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  role="status"
                  aria-label={connected ? 'Connected to the server' : 'Not connected to the server'}
                  title={connected ? 'Connected to the server' : 'Not connected — retrying'}
                  style={{ color: connected ? '#3fb950' : '#f85149' }}
                >●</span>
                {/* Colour alone cannot carry a state a reader has to act on. */}
                {!connected && (
                  <span style={{ color: '#f85149', fontSize: 11 }}>offline</span>
                )}
                {session ? (
                  <>
                    <span
                      title={session.problem}
                      style={{
                        maxWidth: HEADER_TEXT_MAX_WIDTH, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >{session.problem}</span>
                    <SessionSelector currentSessionId={session.id} onSwitch={(id) => { onLoadSession(id); onSelect(null); }} />
                  </>
                ) : (
                  <span style={{ color: TEXT.secondary }}>Waiting for session...</span>
                )}
              </div>
            </div>
            {selectedId && <Breadcrumb selectedId={selectedId} hypotheses={hypotheses} onNavigate={onSelect} />}
            <StatusSummary hypotheses={hypotheses} session={session} />
            {newerSession && (
              <button
                onClick={() => { onLoadSession(newerSession.id); onSelect(null); }}
                title={newerSession.problem}
                className="overlay-widget"
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                  border: '1px solid #9e6a03', color: '#d29922', cursor: 'pointer',
                  fontSize: 12, minWidth: 0,
                }}
              >
                <span aria-hidden>→</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {/* Only what the announcement establishes: a tree was started.
                      Whether work is still going on in it is not known here. */}
                  A newer tree was started — open it
                </span>
              </button>
            )}
          </div>
        </Panel>

        <Panel position="top-right">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
            {session && (
              <FollowIndicator followMode={followMode} onToggle={onToggleFollow} />
            )}
            {fit.showLegend && <Legend />}
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
        color: TEXT.primary, fontSize: 13, cursor: 'pointer', textAlign: 'left',
      }}
      onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#21262d'; }}
      onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none'; }}
    >
      <span>{label}</span>
      {shortcut && <span style={{ color: TEXT.secondary, fontSize: 11 }}>{shortcut}</span>}
    </button>
  );
}

