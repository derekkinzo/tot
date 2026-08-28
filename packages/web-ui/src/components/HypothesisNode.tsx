import { memo, useState, useRef } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { EVIDENCE_TYPE_COLORS, STATUS_NODE_STYLES, TEXT } from '../theme';
import { NODE_WIDTH } from '../geometry';
import { isPruned, type HypothesisData } from '../types';

export type { HypothesisData };

function HypothesisNode({ id: nodeId, data }: NodeProps) {
  const d = data as unknown as HypothesisData;
  // Pruned verdicts dim and strike through so the canvas signals
  // "no further work here".
  const pruned = isPruned(d.status);
  const style = STATUS_NODE_STYLES[d.status] ?? STATUS_NODE_STYLES.pending;
  const [showTooltip, setShowTooltip] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  const borderColor = d.selected ? '#fff' : d.onPath ? '#58a6ff' : style.border;

  const handleMouseEnter = () => {
    const el = textRef.current;
    if (el && el.scrollHeight > el.clientHeight) {
      setShowTooltip(true);
    }
  };

  return (
    <>
      <Handle type="target" position={Position.Top} style={{ background: '#6b7280' }} />
      <div
        className={`hypothesis-node ${d.pulseClass || ''}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setShowTooltip(false)}
        style={{
          position: 'relative',
          background: style.bg,
          border: `2px solid ${borderColor}`,
          borderRadius: 8,
          padding: '10px 14px',
          width: NODE_WIDTH,
          opacity: pruned ? 0.5 : 1,
          boxShadow: d.onPath ? '0 0 12px rgba(88, 166, 255, 0.3)' : undefined,
          cursor: 'pointer',
        }}
      >
        {/* Status header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 14 }}>{style.icon}</span>
          <span style={{ fontSize: 12, color: TEXT.secondary, textTransform: 'capitalize' }}>
            {d.status}
          </span>
        </div>

        {/* Content text (2-line clamp) */}
        <div
          ref={textRef}
          style={{
            fontSize: 13,
            lineHeight: 1.3,
            color: pruned ? '#6b7280' : '#e1e4e8',
            textDecoration: pruned ? 'line-through' : 'none',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {d.label}
        </div>

        {/* How this node was split, stated as declared. Amber when the verdicts
            recorded under it contradict that declaration. */}
        {d.split && (
          <div
            title={
              d.split.attention === 'contradiction'
                ? `${d.split.title}\n\nA verdict recorded under this split contradicts it — open the node for detail.`
                : d.split.attention === 'gap'
                  // Nothing here contradicts the declaration; part of the space
                  // was set aside without being investigated.
                  ? `${d.split.title}\n\nPart of this split was set aside without being investigated — open the node for detail.`
                  : d.split.title
            }
            style={{
              display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 4,
              fontSize: 10, color: d.split.attention ? '#d29922' : '#6b7280',
            }}
          >
            {d.split.attention && (
              <span aria-hidden>{d.split.attention === 'contradiction' ? '⚠' : '◍'}</span>
            )}
            {d.split.label && (
              <span style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                {d.split.label}
              </span>
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {d.split.axis}
            </span>
          </div>
        )}

        {/* Footer: evidence ledger + collapse chevron. Refutation leads, and
            support is never given equal visual weight — evidence that has faced
            no refutation is the bias the method exists to counter. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          {d.ledger.refuting > 0 && (
            <span title={`Counts as ${d.ledger.refuting} refutation(s); records declared as one observation count once`}
              style={{ fontSize: 11, fontWeight: 700, color: EVIDENCE_TYPE_COLORS.refutes }}>
              ✗{d.ledger.refuting}
            </span>
          )}
          {d.ledger.supporting > 0 && (
            <span title={`Counts as ${d.ledger.supporting} supporting observation(s); records declared as one observation count once`}
              style={{ fontSize: 11, color: TEXT.secondary }}>
              ✓{d.ledger.supporting}
            </span>
          )}
          {d.ledger.neutral > 0 && (
            <span title={`${d.ledger.neutral} neutral record(s)`} style={{ fontSize: 11, color: TEXT.secondary }}>
              ·{d.ledger.neutral}
            </span>
          )}
          {d.ledger.setAside > 0 && (
            <span
              title={`${d.ledger.setAside} record(s) declared not to discriminate between the live alternatives`}
              style={{ fontSize: 11, color: TEXT.secondary }}
            >⊘{d.ledger.setAside}</span>
          )}
          {d.ledger.hasDecisive && (
            <span title="Carries a record the verdict turns on" style={{ fontSize: 11, color: '#d29922' }}>▪</span>
          )}
          {d.ledger.ungrounded && (
            <span title="Settled without any verbatim record attached" style={{ fontSize: 11, color: '#d29922' }}>⚠</span>
          )}
          {d.childCount > 0 && (
            <button
              className="nopan nodrag"
              onClick={(e) => {
                e.stopPropagation();
                d.onToggleCollapse?.(nodeId);
              }}
              style={{
                marginLeft: 'auto', background: 'none', border: 'none',
                cursor: 'pointer', fontSize: 11, padding: '2px 4px', borderRadius: 3,
                color: d.collapsed ? '#58a6ff' : '#6b7280',
              }}
            >
              {d.collapsed ? `▶ ${d.hiddenChildren} hidden` : `▼ ${d.childCount}`}
            </button>
          )}
        </div>

        {/* Tooltip (only when text is truncated) */}
        {showTooltip && (
          <div
            className="nopan nodrag"
            style={{
              position: 'absolute',
              bottom: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              marginBottom: 8,
              background: '#21262d',
              border: '1px solid #30363d',
              borderRadius: 6,
              padding: '8px 12px',
              fontSize: 12,
              color: TEXT.primary,
              maxWidth: 320,
              whiteSpace: 'pre-wrap',
              lineHeight: 1.4,
              zIndex: 10,
              pointerEvents: 'none',
              boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            }}
          >
            {d.label}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#6b7280' }} />
    </>
  );
}

export default memo(HypothesisNode);
