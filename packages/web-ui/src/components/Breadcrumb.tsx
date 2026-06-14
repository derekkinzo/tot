import type { Hypothesis } from '../types';

interface Props {
  selectedId: string | null;
  hypotheses: Map<string, Hypothesis>;
  onNavigate: (id: string) => void;
}

export default function Breadcrumb({ selectedId, hypotheses, onNavigate }: Props) {
  if (!selectedId) return null;

  const path: Hypothesis[] = [];
  const seen = new Set<string>();
  let current: string | null = selectedId;
  // Stop on a revisit so a malformed parentId cycle can't loop forever.
  while (current && !seen.has(current)) {
    seen.add(current);
    const h = hypotheses.get(current);
    if (h) path.unshift(h);
    current = h?.parentId ?? null;
  }

  if (path.length <= 1) return null;

  return (
    <div className="overlay-widget" style={{
      fontSize: 12, display: 'flex', alignItems: 'center',
      gap: 4, maxWidth: '60%', overflow: 'hidden',
    }}>
      {path.map((h, i) => (
        <span key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {i > 0 && <span style={{ color: '#6b7280' }}>›</span>}
          <button
            onClick={() => onNavigate(h.id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: h.id === selectedId ? '#e1e4e8' : '#8b949e',
              fontWeight: h.id === selectedId ? 600 : 400,
              fontSize: 12, padding: 0,
              maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {h.content.slice(0, 30)}{h.content.length > 30 ? '…' : ''}
          </button>
        </span>
      ))}
    </div>
  );
}
