import { memo, useState, useRef } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { STATUS_NODE_STYLES, EVIDENCE_TYPE_COLORS } from '../theme';
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
          <span style={{ fontSize: 12, color: '#8b949e', textTransform: 'capitalize' }}>
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
            title={d.split.conflicted ? `${d.split.title}\n\nThe verdicts recorded under this split contradict it — open the node for detail.` : d.split.title}
            style={{
              display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 4,
              fontSize: 10, color: d.split.conflicted ? '#d29922' : '#6b7280',
            }}
          >
            {d.split.conflicted && <span aria-hidden>⚠</span>}
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
            <span title={`${d.ledger.refuting} independent refutation(s)`}
              style={{ fontSize: 11, fontWeight: 700, color: EVIDENCE_TYPE_COLORS.refutes }}>
              ✗{d.ledger.refuting}
            </span>
          )}
          {d.ledger.supporting > 0 && (
            <span title={`${d.ledger.supporting} independent supporting observation(s)`}
              style={{ fontSize: 11, color: '#8b949e' }}>
              ✓{d.ledger.supporting}
            </span>
          )}
          {d.ledger.neutral > 0 && (
            <span title={`${d.ledger.neutral} neutral record(s)`} style={{ fontSize: 11, color: '#6b7280' }}>
              ·{d.ledger.neutral}
            </span>
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
              color: '#e1e4e8',
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
