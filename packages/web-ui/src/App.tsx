import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import { useTreeStream } from './hooks/useTreeStream';
import { useFollowMode } from './hooks/useFollowMode';
import TreeView from './components/TreeView';
import DetailPanel from './components/DetailPanel';
import ArtifactViewer from './components/ArtifactViewer';
import { canvasOwnsKey, type KeyTarget } from './hooks/keyboardOwnership';
import { DETAIL_PANEL_WIDTH } from './geometry';
import type { ArtifactRef } from './types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NOTICE_COLORS } from './theme';

/** Shared shape of a full-width notice across the top of the canvas. */
const NOTICE: CSSProperties = { textAlign: 'center', padding: '6px 12px', fontSize: 13 };

export default function App() {
  const {
    session, hypotheses, connected, newerSession, loadSession,
    recentlyChanged, lastAddedId, lastActivityId, persistenceHealthy, unreadableLines,
  } = useTreeStream();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The captured evidence being read, if any. Held here rather than in the
  // panel because it is a layer above the canvas: while it is open the canvas
  // shortcuts stand down.
  const [openArtifact, setOpenArtifact] = useState<{ artifact: ArtifactRef; claim: string } | null>(null);

  const { followMode, followTarget, toggleFollow } = useFollowMode({
    sessionId: session?.id ?? null,
    lastActivityId,
  });

  const selected = selectedId ? hypotheses.get(selectedId) ?? null : null;
  // Layers stacked above the canvas that read keys.
  const overlayCount = openArtifact ? 1 : 0;

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
      if (!canvasOwnsKey({ overlays: overlayCount, target: e.target as KeyTarget | null })) return;
      if (e.key === 'f' || e.key === 'F') {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          toggleFollow();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [toggleFollow, overlayCount]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      {/* A row above the workspace rather than a layer over it. A notice that
          overlays the canvas covers the controls along its top edge — including
          the sessions list this one tells the reader to open — and covers more of
          them the more there is to say. Taking the height out of the workspace
          instead keeps every control reachable whatever is showing.

          Stacked, so a second notice appears under the first rather than behind
          it, and absent entirely when there is nothing to say. */}
      {(!persistenceHealthy || unreadableLines > 0) && (
        <div style={{ flexShrink: 0 }}>
          {!persistenceHealthy && (
            <div style={{ ...NOTICE, background: NOTICE_COLORS.failure.bg, color: NOTICE_COLORS.failure.fg }}>
              ⚠ Saving failed — this tree is not being written to disk. Check the server logs and disk space.
            </div>
          )}
          {unreadableLines > 0 && (
            <div style={{ ...NOTICE, background: NOTICE_COLORS.caution.bg, color: NOTICE_COLORS.caution.fg }}>
              ⚠ {unreadableLines} saved record{unreadableLines === 1 ? '' : 's'} of this project could not be
              read back. A tree that lost records is shown without them, so it may be missing nodes, evidence,
              or verdicts — check the Sessions list for which one.
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
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
                newerSession={newerSession}
                overlayCount={overlayCount}
              />
            </ErrorBoundary>
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100%', color: '#8b949e',
            }}>
              <div style={{ textAlign: 'center' }}>
                <h2 style={{ marginBottom: 8, fontWeight: 500 }}>tot-mcp</h2>
                {connected ? (
                  // No gesture is taught here: there is nothing to perform one
                  // on, and the legend teaches them beside the tree they act on —
                  // where a second list of them could name a different key.
                  <p>Waiting for agent to create a tree...</p>
                ) : (
                  // An unreachable server looks exactly like an idle agent from
                  // here, so the one that is actually known is what gets said.
                  <>
                    <p style={{ color: '#f85149' }}>Not connected to the server</p>
                    <p style={{ fontSize: 12, marginTop: 12, color: '#6b7280' }}>
                      Retrying. Whether a tree exists cannot be known until the
                      connection is back.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {selected && (
          <ErrorBoundary
            fallback={
              <div style={{
                width: DETAIL_PANEL_WIDTH, borderLeft: '1px solid #30363d', background: '#161b22',
                padding: 24, color: '#8b949e',
              }}>
                Failed to render detail panel.
              </div>
            }
          >
            <DetailPanel
              hypothesis={selected}
              hypotheses={hypotheses}
              onClose={() => handleSelect(null)}
              onOpenArtifact={(artifact, claim) => setOpenArtifact({ artifact, claim })}
            />
          </ErrorBoundary>
        )}
      </div>

      {openArtifact && (
        <ErrorBoundary>
          <ArtifactViewer
            // Keyed by the capture: its window, page and integrity verdict are
            // state seeded from this reference, so opening a different one must
            // start over rather than show the previous bytes under a new header.
            key={openArtifact.artifact.id}
            artifact={openArtifact.artifact}
            claim={openArtifact.claim}
            onClose={() => setOpenArtifact(null)}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}
