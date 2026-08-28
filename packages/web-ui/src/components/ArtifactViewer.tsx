import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TEXT } from '../theme';
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
const VERBATIM_PILL: Record<'verified' | 'unchecked' | 'mismatch' | 'gone', { border: string; color: string; title: string }> = {
  verified: { border: '#238636', color: '#3fb950', title: 'The stored bytes match the digest recorded at capture' },
  unchecked: { border: '#9e6a03', color: '#d29922', title: 'The stored bytes have not been checked against their digest' },
  mismatch: { border: '#da3633', color: '#f85149', title: 'The stored bytes do not match the digest recorded at capture' },
  // Nothing was compared here, so the pill must not claim a comparison failed.
  gone: { border: '#da3633', color: '#f85149', title: 'The stored bytes are gone, so nothing could be checked against the digest' },
};

function pillState(integrity: IntegrityState): keyof typeof VERBATIM_PILL {
  if (integrity === 'verified') return 'verified';
  if (integrity === 'mismatch') return 'mismatch';
  if (integrity === 'missing') return 'gone';
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
  const [reading, setReading] = useState(false);
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
    setReading(true);
    fetch(linesUrl)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((p: ArtifactLineWindow) => { if (live) setPage(p); })
      .catch(() => {
        if (!live) return;
        // The window on screen no longer describes what was asked for, so the
        // pager must not anchor on it: another turn would recompute the range
        // already requested and the click would go nowhere.
        setPage(null);
        setError('Could not read the stored bytes.');
      })
      .finally(() => { if (live) setReading(false); });
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

  // Anchored on the window that is actually on screen. A turn taken while the
  // next window is still in flight would otherwise recompute the range already
  // displayed, and the effect — seeing the same URL — would never refire, so the
  // click would be silently swallowed; the pager stands down until the read lands.
  const turnPage = useCallback((direction: -1 | 1) => {
    setRange((r) => shiftWindow(r, direction, page ?? undefined));
  }, [page]);

  const notice = integrity ? integrityNotice(integrity) : null;
  const pill = VERBATIM_PILL[pillState(integrity)];
  const total = page?.totalLines ?? artifact.lineCount;
  // Paging is unavailable while a read is in flight and after one failed: in both
  // cases the served window does not match the range, so a turn taken from it
  // would resolve to a range already requested.
  const pagerIdle = !reading && error === null;
  const atStart = !pagerIdle || range.from <= 1;
  const atEnd = !pagerIdle || (total !== undefined && (page?.to ?? range.to) >= total);

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
                fontFamily: 'monospace', fontSize: 13, color: TEXT.primary,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{artifactSummary(artifact)}</span>
            </div>
            <div style={{ fontSize: 12, color: TEXT.secondary, marginTop: 4 }}>{claim}</div>
            {artifact.command && (
              <div style={{ fontFamily: 'monospace', fontSize: 11, color: TEXT.secondary, marginTop: 4 }}>
                $ {artifact.command}
              </div>
            )}
          </div>
          <a
            href={urls.raw} target="_blank" rel="noreferrer"
            style={{
              fontSize: 12, color: TEXT.secondary, textDecoration: 'none',
              border: '1px solid #30363d', borderRadius: 4, padding: '4px 8px', whiteSpace: 'nowrap',
            }}
          >open raw</a>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: '#21262d', border: '1px solid #30363d', color: TEXT.secondary,
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
            <div style={{ padding: 16, color: TEXT.secondary, fontSize: 13 }}>
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
          fontSize: 12, color: TEXT.secondary,
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
