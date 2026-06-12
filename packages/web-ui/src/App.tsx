import { useState, useEffect, useCallback } from 'react';
import { useTreeStream } from './hooks/useTreeStream';
import { useFollowMode } from './hooks/useFollowMode';
import TreeView from './components/TreeView';
import DetailPanel from './components/DetailPanel';
import { ErrorBoundary } from './components/ErrorBoundary';

function readProjectFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const param = new URLSearchParams(window.location.search).get('project');
  return param ? param : undefined;
}

export default function App() {
  const { session, hypotheses, connected, loadSession, recentlyChanged, lastAddedId, projects, currentProject, switchProject } = useTreeStream(readProjectFromUrl());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { followMode, followTarget, reportUserInteraction, toggleFollow } = useFollowMode({
    lastAddedId,
    recentlyChanged,
  });

  const selected = selectedId ? hypotheses.get(selectedId) ?? null : null;

  useEffect(() => {
    if (followMode === 'following') {
      setSelectedId(followTarget);
    }
  }, [followMode, followTarget]);

  const handleUserSelect = useCallback((id: string | null) => {
    reportUserInteraction();
    setSelectedId(id);
  }, [reportUserInteraction]);

  const handleProgrammaticSelect = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

  const handleUserViewportInteraction = useCallback(() => {
    reportUserInteraction();
  }, [reportUserInteraction]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'f' || e.key === 'F') {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          toggleFollow();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [toggleFollow]);

  const projectLabel = currentProject ? currentProject.split('/').slice(-2).join('/') : '';

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {hypotheses.size > 0 ? (
          <ErrorBoundary>
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
              onToggleFollow={toggleFollow}
              onLoadSession={loadSession}
              onProgrammaticSelect={handleProgrammaticSelect}
              projects={projects}
              currentProject={currentProject}
              onSwitchProject={switchProject}
              projectLabel={projectLabel}
            />
          </ErrorBoundary>
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

      {selected && (
        <DetailPanel hypothesis={selected} onClose={() => handleUserSelect(null)} />
      )}
    </div>
  );
}
