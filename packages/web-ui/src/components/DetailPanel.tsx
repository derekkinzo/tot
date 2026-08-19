import { nodeLabel, type Evidence, type Hypothesis } from '../types';
import { orderEvidenceRows } from '../tree/evidenceView';
import { EVIDENCE_TYPE_COLORS, STATUS_COLORS, STATUS_LABELS } from '../theme';
import { conclusionStatus } from '../tree/conclusion';

interface Props {
  hypothesis: Hypothesis;
  onClose: () => void;
}

export default function DetailPanel({ hypothesis, onClose }: Props) {
  const statusColor = STATUS_COLORS[hypothesis.status] ?? STATUS_COLORS.pending;
  const statusLabel = STATUS_LABELS[hypothesis.status] ?? STATUS_LABELS.pending;
  // A partial/legacy stream record may be missing optional arrays or a valid
  // timestamp; default them so the panel renders a graceful fallback instead
  // of throwing (it sits in its own ErrorBoundary, but degrading is friendlier).
  const evidence = hypothesis.evidence ?? [];
  const rows = orderEvidenceRows({ ...hypothesis, evidence });
  const childCount = hypothesis.children?.length ?? 0;
  const createdAt = new Date(hypothesis.metadata?.createdAt ?? '');
  const createdLabel = Number.isNaN(createdAt.getTime()) ? '—' : createdAt.toLocaleTimeString();

  return (
    <div style={{
      width: 400,
      borderLeft: '1px solid #30363d',
      background: '#161b22',
      padding: '24px',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 20,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <span style={{
            display: 'inline-block',
            padding: '3px 10px',
            borderRadius: 12,
            fontSize: 12,
            fontWeight: 600,
            background: `${statusColor}20`,
            color: statusColor,
            border: `1px solid ${statusColor}40`,
          }}>{statusLabel}</span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: '#21262d', border: '1px solid #30363d', color: '#8b949e',
            cursor: 'pointer', fontSize: 16, lineHeight: 1, borderRadius: 4,
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >×</button>
      </div>

      {/* Content */}
      <div>
        <div style={{ fontSize: 18, fontWeight: 500, lineHeight: 1.4, color: '#e1e4e8' }}>
          {hypothesis.statement ?? nodeLabel(hypothesis)}
        </div>
      </div>

      {/* Conclusion. A reopen-on-refute leaves the conclusion record on the
          hypothesis but demotes status back to 'exploring'; the banner is
          annotated as historical so the live status pill is the current
          source of truth. supersededBy distinguishes a direct refute from
          a cascade demote triggered by a refute on a descendant. */}
      {hypothesis.conclusion && (() => {
        const status = conclusionStatus(hypothesis)!;
        const verdict = status.verdict;
        const isHistorical = status.isHistorical;
        const accent = STATUS_COLORS[verdict] ?? STATUS_COLORS.eliminated;
        const tint =
          verdict === 'corroborated' ? '#052e1620' :
          verdict === 'out-of-scope' ? '#1f1b3a20' :
          '#1c1f26';
        // Falls back to the raw verdict if a malformed/legacy record carries a
        // value outside the label map (TS types are erased at the wire boundary).
        const verdictLabel = STATUS_LABELS[verdict] ?? verdict;
        const label = !isHistorical
          ? verdictLabel
          : status.supersededByDescendant
            ? `Reopened (refuted descendant)`
            : `Reopened from ${verdictLabel}`;
        return (
          <div style={{
            padding: '14px 16px',
            background: tint,
            borderRadius: 8,
            borderLeft: `3px solid ${accent}`,
            opacity: isHistorical ? 0.6 : 1,
          }}>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: accent,
              marginBottom: 6,
            }}>
              {label}
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.5, color: '#e1e4e8' }}>
              {hypothesis.conclusion.reason}
            </div>
          </div>
        );
      })()}

      {/* Evidence, in reading order: refutation first, then neutral, then
          support, and records asserted not to discriminate last. */}
      {evidence.length > 0 && (
        <div>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: '#8b949e',
            marginBottom: 10,
          }}>
            Evidence ({evidence.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[...rows.refuters, ...rows.neutral, ...rows.supports].map((ev) => (
              <EvidenceRow key={ev.id} ev={ev} />
            ))}
          </div>
          {rows.tray.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
                Considered, not discriminating ({rows.tray.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, opacity: 0.65 }}>
                {rows.tray.map((ev) => <EvidenceRow key={ev.id} ev={ev} />)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Metadata */}
      <div style={{
        paddingTop: 16,
        borderTop: '1px solid #21262d',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 8,
        fontSize: 12,
        color: '#6b7280',
      }}>
        <div>
          <div style={{ color: '#8b949e', fontWeight: 500 }}>ID</div>
          <div style={{ fontFamily: 'monospace' }}>{hypothesis.id.slice(0, 8)}</div>
        </div>
        <div>
          <div style={{ color: '#8b949e', fontWeight: 500 }}>Depth</div>
          <div>{hypothesis.depth}</div>
        </div>
        <div>
          <div style={{ color: '#8b949e', fontWeight: 500 }}>Created</div>
          <div>{createdLabel}</div>
        </div>
        <div>
          <div style={{ color: '#8b949e', fontWeight: 500 }}>Children</div>
          <div>{childCount}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * One evidence record. Verbatim capture and paraphrase are labelled distinctly,
 * because whether a claim rests on bytes or on a retelling is the first thing an
 * auditor needs to know.
 */
function EvidenceRow({ ev }: { ev: Evidence }) {
  const accent = EVIDENCE_TYPE_COLORS[ev.type] ?? '#8b949e';
  return (
    <div style={{
      padding: '12px 14px',
      background: '#1c1f26',
      borderRadius: 8,
      borderLeft: `3px solid ${accent}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: accent }}>
          {ev.type}
        </span>
        <span
          title={ev.kind === 'artifact' ? 'Verbatim captured bytes' : 'Paraphrased by the agent'}
          style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 10,
            border: '1px solid #30363d',
            color: ev.kind === 'artifact' ? '#3fb950' : '#8b949e',
          }}
        >
          {ev.kind === 'artifact' ? 'verbatim' : 'paraphrase'}
        </span>
        {ev.decisive && (
          <span title="The verdict turns on this record" style={{ fontSize: 11, color: '#d29922' }}>▪ decisive</span>
        )}
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.5, color: '#e1e4e8' }}>{ev.content}</div>
      {ev.source && (
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>Source: {ev.source}</div>
      )}
    </div>
  );
}
