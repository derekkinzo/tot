import { useState, useEffect } from 'react';

interface SessionSummary {
  id: string;
  problem: string;
  status: string;
  createdAt: string;
  nodeCount: number;
}

interface Props {
  currentSessionId: string | null;
  onSwitch: (sessionId: string) => void;
}

export default function SessionSelector({ currentSessionId, onSwitch }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch('/api/sessions')
      .then((r) => r.json())
      .then((d) => setSessions(d.sessions ?? []))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open]);

  if (!currentSessionId) return null;

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none', border: '1px solid #30363d', borderRadius: 4,
          color: '#8b949e', fontSize: 11, padding: '3px 8px', cursor: 'pointer',
          marginLeft: 10,
        }}
      >
        Sessions ▾
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          background: '#1c1f26', border: '1px solid #30363d', borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 1000,
          minWidth: 280, maxHeight: 300, overflowY: 'auto',
          padding: '4px 0',
        }}>
          {loading && <div style={{ padding: '10px 14px', color: '#6b7280', fontSize: 12 }}>Loading…</div>}
          {!loading && error && <div style={{ padding: '10px 14px', color: '#f87171', fontSize: 12 }}>Failed to load sessions.</div>}
          {!loading && !error && sessions.length === 0 && <div style={{ padding: '10px 14px', color: '#6b7280', fontSize: 12 }}>No sessions.</div>}
          {!loading && !error && sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => { onSwitch(s.id); setOpen(false); }}
              style={{
                display: 'block', width: '100%', padding: '10px 14px',
                background: s.id === currentSessionId ? '#21262d' : 'none',
                border: 'none', color: '#e1e4e8', fontSize: 13,
                cursor: 'pointer', textAlign: 'left',
              }}
              onMouseEnter={(e) => { if (s.id !== currentSessionId) (e.target as HTMLElement).style.background = '#21262d'; }}
              onMouseLeave={(e) => { if (s.id !== currentSessionId) (e.target as HTMLElement).style.background = 'none'; }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200,
                }}>{s.problem}</span>
                <span style={{
                  fontSize: 10, padding: '2px 6px', borderRadius: 10,
                  background: s.status === 'open' ? '#22c55e20' : '#6b728020',
                  color: s.status === 'open' ? '#22c55e' : '#6b7280',
                }}>{s.status}</span>
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>
                {s.nodeCount} nodes • {new Date(s.createdAt).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
