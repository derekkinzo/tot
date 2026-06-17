import { useState, useEffect, useCallback } from 'react';
import { useTreeStream } from './hooks/useTreeStream';
import { useFollowMode } from './hooks/useFollowMode';
import TreeView from './components/TreeView';
import DetailPanel from './components/DetailPanel';
import { ErrorBoundary } from './components/ErrorBoundary';

export default function App() {
  const { session, hypotheses, connected, loadSession, recentlyChanged, lastAddedId, persistenceHealthy } = useTreeStream();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { followMode, followTarget, toggleFollow } = useFollowMode({
    lastAddedId,
    recentlyChanged,
  });

  const selected = selectedId ? hypotheses.get(selectedId) ?? null : null;

  // While following, pin selection to the active node. This also fires when
  // follow is toggled on, so enabling follow focuses the active hypothesis.
  useEffect(() => {
    if (followMode === 'following' && followTarget) {
      setSelectedId(followTarget);
    }
  }, [followMode, followTarget]);

  // Selecting a node (by click, keyboard, or a selector switch) does not
  // pause follow — only the follow button or the F key toggles it.
  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

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

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      {!persistenceHealthy && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2000,
          background: '#7f1d1d', color: '#fecaca', textAlign: 'center',
          padding: '6px 12px', fontSize: 13,
        }}>
          ⚠ Saving failed — this tree is not being written to disk. Check the server logs and disk space.
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {hypotheses.size > 0 ? (
          <ErrorBoundary>
            <TreeView
              hypotheses={hypotheses}
              rootId={session?.rootNodeId ?? null}
              selectedId={selectedId}
              onSelect={handleSelect}
              panelOpen={selected !== null}
              recentlyChanged={recentlyChanged}
              lastAddedId={lastAddedId}
              connected={connected}
              session={session}
              followMode={followMode}
              onToggleFollow={toggleFollow}
              onLoadSession={loadSession}
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
        <ErrorBoundary
          fallback={
            <div style={{
              width: 400, borderLeft: '1px solid #30363d', background: '#161b22',
              padding: 24, color: '#8b949e',
            }}>
              Failed to render detail panel.
            </div>
          }
        >
          <DetailPanel hypothesis={selected} onClose={() => handleSelect(null)} />
        </ErrorBoundary>
      )}
    </div>
  );
}
