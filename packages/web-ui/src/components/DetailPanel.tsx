import type { Hypothesis } from '../types';
import { EVIDENCE_TYPE_COLORS, STATUS_COLORS, STATUS_LABELS } from '../theme';

interface Props {
  hypothesis: Hypothesis;
  onClose: () => void;
}

export default function DetailPanel({ hypothesis, onClose }: Props) {
  const statusColor = STATUS_COLORS[hypothesis.status] ?? STATUS_COLORS.pending;
  const statusLabel = STATUS_LABELS[hypothesis.status] ?? STATUS_LABELS.pending;

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
          {hypothesis.score !== null && (
            <span style={{
              marginLeft: 10,
              fontSize: 14,
              fontWeight: 600,
              color: '#e1e4e8',
            }}>{(hypothesis.score * 100).toFixed(0)}%</span>
          )}
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
          {hypothesis.content}
        </div>
      </div>

      {/* Conclusion. A reopen-on-refute leaves the conclusion record on the
          hypothesis but demotes status back to 'exploring'; the banner is
          annotated as historical so the live status pill is the current
          source of truth. supersededBy distinguishes a direct refute from
          a cascade demote triggered by a refute on a descendant. */}
      {hypothesis.conclusion && (() => {
        const verdict = hypothesis.conclusion.verdict;
        const supersededBy = hypothesis.conclusion.supersededBy;
        const isHistorical = supersededBy !== undefined || hypothesis.status !== verdict;
        const accent = STATUS_COLORS[verdict] ?? STATUS_COLORS.eliminated;
        const tint =
          verdict === 'corroborated' ? '#052e1620' :
          verdict === 'out-of-scope' ? '#1f1b3a20' :
          '#1c1f26';
        const label = !isHistorical
          ? (STATUS_LABELS[verdict] ?? verdict)
          : supersededBy === 'descendant'
            ? `Reopened (refuted descendant)`
            : `Reopened from ${STATUS_LABELS[verdict] ?? verdict}`;
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

      {/* Evidence */}
      {hypothesis.evidence.length > 0 && (
        <div>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: '#8b949e',
            marginBottom: 10,
          }}>
            Evidence ({hypothesis.evidence.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {hypothesis.evidence.map((ev) => (
              <div key={ev.id} style={{
                padding: '12px 14px',
                background: '#1c1f26',
                borderRadius: 8,
                borderLeft: `3px solid ${EVIDENCE_TYPE_COLORS[ev.type] ?? '#8b949e'}`,
              }}>
                <div style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: EVIDENCE_TYPE_COLORS[ev.type],
                  marginBottom: 6,
                }}>
                  {ev.type}
                </div>
                <div style={{ fontSize: 15, lineHeight: 1.5, color: '#e1e4e8' }}>
                  {ev.content}
                </div>
                {ev.source && (
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
                    Source: {ev.source}
                  </div>
                )}
              </div>
            ))}
          </div>
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
          <div>{new Date(hypothesis.metadata.createdAt).toLocaleTimeString()}</div>
        </div>
        <div>
          <div style={{ color: '#8b949e', fontWeight: 500 }}>Children</div>
          <div>{hypothesis.children.length}</div>
        </div>
      </div>
    </div>
  );
}
