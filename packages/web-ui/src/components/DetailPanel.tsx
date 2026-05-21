import type { Hypothesis } from '../types';

interface Props {
  hypothesis: Hypothesis;
  onClose: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  supports: '#22c55e',
  refutes: '#ef4444',
  neutral: '#8b949e',
};

const STATUS_STYLES: Record<string, { color: string; label: string }> = {
  pending: { color: '#3b82f6', label: 'Pending' },
  exploring: { color: '#eab308', label: 'Exploring' },
  eliminated: { color: '#ef4444', label: 'Eliminated' },
  confirmed: { color: '#22c55e', label: 'Confirmed' },
};

export default function DetailPanel({ hypothesis, onClose }: Props) {
  const statusStyle = STATUS_STYLES[hypothesis.status] ?? STATUS_STYLES.pending;

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
            background: `${statusStyle.color}20`,
            color: statusStyle.color,
            border: `1px solid ${statusStyle.color}40`,
          }}>{statusStyle.label}</span>
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

      {/* Conclusion */}
      {hypothesis.conclusion && (
        <div style={{
          padding: '14px 16px',
          background: hypothesis.conclusion.verdict === 'confirmed' ? '#052e1620' : '#1c1f26',
          borderRadius: 8,
          borderLeft: `3px solid ${hypothesis.conclusion.verdict === 'confirmed' ? '#22c55e' : '#ef4444'}`,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: hypothesis.conclusion.verdict === 'confirmed' ? '#22c55e' : '#ef4444',
            marginBottom: 6,
          }}>
            {hypothesis.conclusion.verdict === 'confirmed' ? 'Root Cause' : 'Eliminated'}
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.5, color: '#e1e4e8' }}>
            {hypothesis.conclusion.reason}
          </div>
        </div>
      )}

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
                borderLeft: `3px solid ${TYPE_COLORS[ev.type] ?? '#8b949e'}`,
              }}>
                <div style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: TYPE_COLORS[ev.type],
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
