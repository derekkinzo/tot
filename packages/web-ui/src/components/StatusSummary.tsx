import { useMemo } from 'react';
import type { Hypothesis, Session } from '../types';
import ExportButton from './ExportButton';
import { STATUS_COLORS } from '../theme';

interface Props {
  hypotheses: Map<string, Hypothesis>;
  session: Session | null;
}

export default function StatusSummary({ hypotheses, session }: Props) {
  const counts = useMemo(() => {
    let pending = 0, exploring = 0, eliminated = 0, corroborated = 0;
    for (const [, h] of hypotheses) {
      switch (h.status) {
        case 'pending': pending++; break;
        case 'exploring': exploring++; break;
        case 'eliminated': eliminated++; break;
        case 'corroborated': corroborated++; break;
      }
    }
    return { pending, exploring, eliminated, corroborated, total: hypotheses.size };
  }, [hypotheses]);

  if (counts.total === 0) return null;

  return (
    <div className="overlay-widget" style={{
      display: 'flex',
      gap: 12,
      fontSize: 12,
    }}>
      {counts.pending > 0 && <Pill color={STATUS_COLORS.pending} label="Pending" count={counts.pending} />}
      {counts.exploring > 0 && <Pill color={STATUS_COLORS.exploring} label="Exploring" count={counts.exploring} />}
      {counts.eliminated > 0 && <Pill color={STATUS_COLORS.eliminated} label="Eliminated" count={counts.eliminated} />}
      {counts.corroborated > 0 && <Pill color={STATUS_COLORS.corroborated} label="Corroborated" count={counts.corroborated} />}
      <span style={{ color: '#6b7280', borderLeft: '1px solid #30363d', paddingLeft: 12 }}>
        {counts.total} total
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
