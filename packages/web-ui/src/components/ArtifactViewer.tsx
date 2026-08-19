import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactRef } from '../types';
import {
  artifactSummary,
  artifactUrls,
  formatBytes,
  initialWindow,
  integrityNotice,
  type LineRange,
} from '../tree/artifactView';

interface Props {
  /** The reference recorded on the evidence, which is what authorizes the read. */
  artifact: ArtifactRef;
  /** The claim the capture was filed against, kept in view while reading it. */
  claim: string;
  onClose: () => void;
}

interface Window {
  lines: string[];
  from: number;
  to: number;
  totalLines: number;
  truncated: boolean;
}

/**
 * Reads a captured artifact: the bytes themselves, paged, with the cited excerpt
 * marked and the integrity of the stored copy stated.
 *
 * Owns the keyboard while open — the caller counts it as a stacked layer, so the
 * canvas shortcuts stand down and Escape closes the viewer rather than clearing
 * the selection behind it.
 */
export default function ArtifactViewer({ artifact, claim, onClose }: Props) {
  const urls = artifactUrls(artifact);
  const [range, setRange] = useState<LineRange>(() => initialWindow(artifact));
  const [window, setWindow] = useState<Window | null>(null);
  const [integrity, setIntegrity] = useState<'verified' | 'mismatch' | 'missing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const excerptRef = useRef<HTMLDivElement | null>(null);

  // The digest verdict is recomputed server-side on every read, so it is fetched
  // rather than taken from the record.
  useEffect(() => {
    let live = true;
    fetch(urls.meta)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((meta: { integrity: 'verified' | 'mismatch' | 'missing' }) => {
        if (live) setIntegrity(meta.integrity);
      })
      .catch(() => { if (live) setIntegrity(null); });
    return () => { live = false; };
  }, [urls.meta]);

  useEffect(() => {
    let live = true;
    setError(null);
    fetch(urls.lines(range.from, range.to))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((w: Window) => { if (live) setWindow(w); })
      .catch(() => { if (live) setError('Could not read the stored bytes.'); });
    return () => { live = false; };
  }, [urls, range.from, range.to]);

  // Escape belongs to the topmost layer, which is this one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Bring the cited lines into view once they render; a reader opening a record
  // about line 800 should not have to hunt for it.
  useEffect(() => {
    excerptRef.current?.scrollIntoView({ block: 'center' });
  }, [window]);

  const page = useCallback((direction: -1 | 1) => {
    setRange((r) => {
      const span = Math.max(1, r.to - r.from + 1);
      const shift = direction * span;
      const from = Math.max(1, r.from + shift);
      return { from, to: from + span - 1 };
    });
  }, []);

  const notice = integrity ? integrityNotice(integrity) : null;
  const total = window?.totalLines ?? artifact.lineCount;
  const atStart = range.from <= 1;
  const atEnd = total !== undefined && (window?.to ?? range.to) >= total;
  const isText = artifact.mediaType.startsWith('text/') || artifact.mediaType === 'application/json';

  return (
    <div
      role="dialog"
      aria-label={`Captured evidence: ${artifact.filename}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000,
        background: 'rgba(1, 4, 9, 0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32,
      }}
    >
      <div style={{
        display: 'flex', flexDirection: 'column',
        width: 'min(1000px, 100%)', height: '100%',
        background: '#0d1117', border: '1px solid #30363d', borderRadius: 10, overflow: 'hidden',
      }}>
        <header style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '14px 16px', borderBottom: '1px solid #21262d', background: '#161b22',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 10,
                border: '1px solid #238636', color: '#3fb950',
              }}>verbatim</span>
              <span style={{
                fontFamily: 'monospace', fontSize: 13, color: '#e1e4e8',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{artifactSummary(artifact)}</span>
            </div>
            <div style={{ fontSize: 12, color: '#8b949e', marginTop: 4 }}>{claim}</div>
            {artifact.command && (
              <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                $ {artifact.command}
              </div>
            )}
          </div>
          <a
            href={urls.raw} target="_blank" rel="noreferrer"
            style={{
              fontSize: 12, color: '#8b949e', textDecoration: 'none',
              border: '1px solid #30363d', borderRadius: 4, padding: '4px 8px', whiteSpace: 'nowrap',
            }}
          >open raw</a>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: '#21262d', border: '1px solid #30363d', color: '#8b949e',
              cursor: 'pointer', fontSize: 16, lineHeight: 1, borderRadius: 4,
              width: 28, height: 28, flexShrink: 0,
            }}
          >×</button>
        </header>

        {notice && (
          <div style={{ padding: '8px 16px', background: '#3d1d1d', color: '#fecaca', fontSize: 12 }}>
            ⚠ {notice.message}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', background: '#0d1117' }}>
          {error && <div style={{ padding: 16, color: '#f85149', fontSize: 13 }}>{error}</div>}
          {!error && !isText && (
            <div style={{ padding: 16, color: '#8b949e', fontSize: 13 }}>
              {formatBytes(artifact.bytes)} of {artifact.mediaType}. Use “open raw” to download it.
            </div>
          )}
          {!error && isText && window && (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
              <tbody>
                {window.lines.map((line, i) => {
                  const lineNo = window.from + i;
                  const cited = artifact.excerpt !== undefined
                    && lineNo >= artifact.excerpt.startLine && lineNo <= artifact.excerpt.endLine;
                  const firstCited = cited && lineNo === artifact.excerpt!.startLine;
                  return (
                    <tr key={lineNo} style={{ background: cited ? '#1f2937' : 'transparent' }}>
                      <td style={{
                        width: 1, whiteSpace: 'nowrap', textAlign: 'right', userSelect: 'none',
                        padding: '0 10px', color: cited ? '#d29922' : '#484f58',
                        fontFamily: 'monospace', borderRight: '1px solid #21262d',
                      }}>{lineNo}</td>
                      <td style={{ padding: '0 12px', fontFamily: 'monospace', color: '#c9d1d9', whiteSpace: 'pre-wrap' }}>
                        {firstCited ? <div ref={excerptRef}>{line}</div> : line}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <footer style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 16px', borderTop: '1px solid #21262d', background: '#161b22',
          fontSize: 12, color: '#8b949e',
        }}>
          <button
            onClick={() => page(-1)} disabled={atStart}
            style={pagerStyle(atStart)}
          >← earlier</button>
          <button
            onClick={() => page(1)} disabled={atEnd}
            style={pagerStyle(atEnd)}
          >later →</button>
          <span>
            {window
              ? `lines ${window.from}–${window.to} of ${window.totalLines}`
              : `lines ${range.from}–${range.to}`}
          </span>
          {window?.truncated && (
            <span title="One request is capped; page to read further" style={{ color: '#d29922' }}>
              window capped
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}

function pagerStyle(disabled: boolean): React.CSSProperties {
  return {
    background: '#21262d', border: '1px solid #30363d', borderRadius: 4,
    color: disabled ? '#484f58' : '#c9d1d9', cursor: disabled ? 'default' : 'pointer',
    padding: '3px 10px', fontSize: 12,
  };
}
