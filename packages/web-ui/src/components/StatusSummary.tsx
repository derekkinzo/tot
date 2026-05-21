import type { Hypothesis, Session } from '../types';
import ExportButton from './ExportButton';

interface Props {
  hypotheses: Map<string, Hypothesis>;
  session: Session | null;
}

export default function StatusSummary({ hypotheses, session }: Props) {
  let pending = 0, exploring = 0, eliminated = 0, confirmed = 0;
  for (const [, h] of hypotheses) {
    switch (h.status) {
      case 'pending': pending++; break;
      case 'exploring': exploring++; break;
      case 'eliminated': eliminated++; break;
      case 'confirmed': confirmed++; break;
    }
  }

  const total = hypotheses.size;
  if (total === 0) return null;

  return (
    <div className="overlay-widget" style={{
      display: 'flex',
      gap: 12,
      fontSize: 12,
    }}>
      {pending > 0 && <Pill color="#3b82f6" label="Pending" count={pending} />}
      {exploring > 0 && <Pill color="#eab308" label="Exploring" count={exploring} />}
      {eliminated > 0 && <Pill color="#ef4444" label="Eliminated" count={eliminated} />}
      {confirmed > 0 && <Pill color="#22c55e" label="Confirmed" count={confirmed} />}
      <span style={{ color: '#6b7280', borderLeft: '1px solid #30363d', paddingLeft: 12 }}>
        {total} total
      </span>
      <span style={{ borderLeft: '1px solid #30363d', paddingLeft: 12 }}>
        <ExportButton session={session} hypotheses={hypotheses} />
      </span>
    </div>
  );
}

function Pill({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
      }} />
      <span style={{ color: '#8b949e' }}>{count} {label}</span>
    </span>
  );
}
