import { useState, useEffect, useCallback, useRef } from 'react';
import { useTreeStream } from './hooks/useTreeStream';
import TreeView from './components/TreeView';
import DetailPanel from './components/DetailPanel';

export default function App() {
  const { session, hypotheses, connected, loadSession, recentlyChanged, lastAddedId, projects, currentProject, switchProject } = useTreeStream();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [followMode, setFollowMode] = useState<'following' | 'paused' | 'off'>('off');

  // Track whether selection change is programmatic (from follow mode)
  const isProgrammaticSelect = useRef(false);

  const selected = selectedId ? hypotheses.get(selectedId) ?? null : null;

  // When a session starts, enter following mode
  useEffect(() => {
    if (session && followMode === 'off') {
      setFollowMode('following');
    }
  }, [session?.id]);

  // Follow mode dual behavior:
  // - hypothesis-added (new nodes): fit all (see tree growing)
  // - hypothesis-updated (evidence/status): zoom to that node (see work happening)
  // - re-enabled with no recent activity: fit all (resume overview)
  useEffect(() => {
    if (followMode !== 'following') return;

    if (lastAddedId) {
      // New node added → fit all to see the tree growing
      if (selectedId !== null) {
        isProgrammaticSelect.current = true;
        setSelectedId(null);
      }
    } else if (recentlyChanged.size > 0) {
      // Status/evidence update → focus on the changed node
      const targetId = [...recentlyChanged][recentlyChanged.size - 1];
      if (targetId !== selectedId) {
        isProgrammaticSelect.current = true;
        setSelectedId(targetId);
      }
    } else {
      // No recent activity (user re-enabled follow) → fit all
      if (selectedId !== null) {
        isProgrammaticSelect.current = true;
        setSelectedId(null);
      }
    }
  }, [followMode, lastAddedId, recentlyChanged]);

  // User-initiated select (from node click, keyboard, breadcrumb, etc.)
  const handleUserSelect = useCallback((id: string | null) => {
    if (isProgrammaticSelect.current) {
      isProgrammaticSelect.current = false;
      return;
    }
    // User interaction pauses follow mode
    if (followMode === 'following') {
      setFollowMode('paused');
    }
    setSelectedId(id);
  }, [followMode]);

  // Direct setSelectedId for programmatic use (follow mode, session switch)
  const handleProgrammaticSelect = useCallback((id: string | null) => {
    isProgrammaticSelect.current = true;
    setSelectedId(id);
  }, []);

  // Callback for TreeView user interactions (pan, zoom, keyboard nav)
  const handleUserViewportInteraction = useCallback(() => {
    if (followMode === 'following') {
      setFollowMode('paused');
    }
  }, [followMode]);

  // Toggle follow mode
  const toggleFollowMode = useCallback(() => {
    if (followMode === 'following') {
      setFollowMode('paused');
    } else {
      setFollowMode('following');
    }
  }, [followMode]);

  // Keyboard shortcut: F to toggle follow mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'f' || e.key === 'F') {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          toggleFollowMode();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [toggleFollowMode]);

  // Derive displayable project name
  const projectLabel = currentProject ? currentProject.split('/').slice(-2).join('/') : '';

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {/* Tree visualization with all overlays rendered inside via Panel */}
        {hypotheses.size > 0 ? (
          <TreeView
            hypotheses={hypotheses}
            rootId={session?.rootNodeId ?? null}
            selectedId={selectedId}
            onSelect={handleUserSelect}
            onUserViewportInteraction={handleUserViewportInteraction}
            panelOpen={selected !== null}
            recentlyChanged={recentlyChanged}
            lastAddedId={lastAddedId}
            connected={connected}
            session={session}
            followMode={followMode}
            onToggleFollow={toggleFollowMode}
            onLoadSession={loadSession}
            onProgrammaticSelect={handleProgrammaticSelect}
            projects={projects}
            currentProject={currentProject}
            onSwitchProject={switchProject}
            projectLabel={projectLabel}
          />
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: '#8b949e',
          }}>
            <div style={{ textAlign: 'center' }}>
              <h2 style={{ marginBottom: 8, fontWeight: 500 }}>tot-mcp</h2>
              <p>Waiting for agent to create a tree...</p>
              <p style={{ fontSize: 12, marginTop: 12, color: '#6b7280' }}>
                Double-click nodes to collapse/expand subtrees
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <DetailPanel hypothesis={selected} onClose={() => handleUserSelect(null)} />
      )}
    </div>
  );
}
