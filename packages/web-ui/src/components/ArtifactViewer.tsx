import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rendersAsLines } from '../types';
import type { ArtifactIntegrity, ArtifactLineWindow, ArtifactRef } from '../types';
import {
  artifactSummary,
  artifactUrls,
  formatBytes,
  initialWindow,
  integrityNotice,
  shiftWindow,
  type LineRange,
} from '../tree/artifactView';

/** Pending, or the verdict of the check the server ran on this read. */
type IntegrityState = ArtifactIntegrity | 'unknown' | null;

const NOTICE_TONES = {
  error: { background: '#3d1d1d', color: '#fecaca' },
  warning: { background: '#3b2f12', color: '#f2cc60' },
} as const;

/** The pill states that the record is a capture; its colour states whether the
 *  stored bytes were checked against the digest taken at capture. */
const VERBATIM_PILL: Record<'verified' | 'unchecked' | 'broken', { border: string; color: string; title: string }> = {
  verified: { border: '#238636', color: '#3fb950', title: 'The stored bytes match the digest recorded at capture' },
  unchecked: { border: '#9e6a03', color: '#d29922', title: 'The stored bytes have not been checked against their digest' },
  broken: { border: '#da3633', color: '#f85149', title: 'The stored bytes do not match the digest recorded at capture' },
};

function pillState(integrity: IntegrityState): keyof typeof VERBATIM_PILL {
  if (integrity === 'verified') return 'verified';
  if (integrity === 'mismatch' || integrity === 'missing') return 'broken';
  return 'unchecked';
}

interface Props {
  /** The reference recorded on the evidence, which is what authorizes the read. */
  artifact: ArtifactRef;
  /** The claim the capture was filed against, kept in view while reading it. */
  claim: string;
  onClose: () => void;
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
  const urls = useMemo(() => artifactUrls(artifact), [artifact.sessionId, artifact.id]);
  const [range, setRange] = useState<LineRange>(() => initialWindow(artifact));
  const [page, setPage] = useState<ArtifactLineWindow | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityState>(null);
  const [error, setError] = useState<string | null>(null);
  const excerptRef = useRef<HTMLDivElement | null>(null);
  const isText = rendersAsLines(artifact);

  // The digest verdict is recomputed server-side on every read, so it is fetched
  // rather than taken from the record.
  useEffect(() => {
    let live = true;
    fetch(urls.meta)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((meta: { integrity: ArtifactIntegrity }) => {
        if (live) setIntegrity(meta.integrity);
      })
      // A check that could not be run is its own state; reporting it as pending
      // would leave the reader looking at an unqualified 'verbatim' pill.
      .catch(() => { if (live) setIntegrity('unknown'); });
    return () => { live = false; };
  }, [urls.meta]);

  const linesUrl = urls.lines(range.from, range.to);
  useEffect(() => {
    // Bytes that are not shown as lines have no window to fetch, and a line
    // count taken over them would describe nothing a reader can see.
    if (!isText) return;
    let live = true;
    setError(null);
    fetch(linesUrl)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((p: ArtifactLineWindow) => { if (live) setPage(p); })
      .catch(() => { if (live) setError('Could not read the stored bytes.'); });
    return () => { live = false; };
  }, [linesUrl, isText]);

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
  }, [page]);

  const servedRef = useRef<ArtifactLineWindow | null>(null);
  servedRef.current = page;
  const turnPage = useCallback((direction: -1 | 1) => {
    setRange((r) => shiftWindow(r, direction, servedRef.current ?? undefined));
  }, []);

  const notice = integrity ? integrityNotice(integrity) : null;
  const pill = VERBATIM_PILL[pillState(integrity)];
  const total = page?.totalLines ?? artifact.lineCount;
  const atStart = range.from <= 1;
  const atEnd = total !== undefined && (page?.to ?? range.to) >= total;

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
              <span
                title={pill.title}
                style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 10,
                  border: `1px solid ${pill.border}`, color: pill.color,
                }}
              >verbatim</span>
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
          <div style={{ padding: '8px 16px', ...NOTICE_TONES[notice.tone], fontSize: 12 }}>
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
          {!error && isText && page && (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
              <tbody>
                {page.lines.map((line, i) => {
                  const lineNo = page.from + i;
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

        {isText && <footer style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 16px', borderTop: '1px solid #21262d', background: '#161b22',
          fontSize: 12, color: '#8b949e',
        }}>
          <button
            onClick={() => turnPage(-1)} disabled={atStart}
            style={pagerStyle(atStart)}
          >← earlier</button>
          <button
            onClick={() => turnPage(1)} disabled={atEnd}
            style={pagerStyle(atEnd)}
          >later →</button>
          <span>
            {page
              ? `lines ${page.from}–${page.to} of ${page.totalLines}`
              : `lines ${range.from}–${range.to}`}
          </span>
          {page?.truncated && (
            <span title="One request is capped; page to read further" style={{ color: '#d29922' }}>
              window capped
            </span>
          )}
        </footer>}
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
