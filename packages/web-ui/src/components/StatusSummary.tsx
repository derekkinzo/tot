import { useMemo } from 'react';
import type { Hypothesis, Session } from '../types';
import ExportButton from './ExportButton';
import { groundingMeter } from '../tree/evidenceView';
import { STATUS_COLORS, STATUS_LABELS } from '../theme';

interface Props {
  hypotheses: Map<string, Hypothesis>;
  session: Session | null;
}

export default function StatusSummary({ hypotheses, session }: Props) {
  // How many settled leaves rest on verbatim evidence: a session-level read on
  // whether the conclusions can be checked at all.
  const grounding = useMemo(() => groundingMeter(hypotheses.values()), [hypotheses]);
  const counts = useMemo(() => {
    let pending = 0, exploring = 0, eliminated = 0, corroborated = 0, outOfScope = 0;
    for (const [, h] of hypotheses) {
      switch (h.status) {
        case 'pending': pending++; break;
        case 'exploring': exploring++; break;
        case 'eliminated': eliminated++; break;
        case 'corroborated': corroborated++; break;
        case 'out-of-scope': outOfScope++; break;
      }
    }
    return { pending, exploring, eliminated, corroborated, outOfScope, total: hypotheses.size };
  }, [hypotheses]);

  if (counts.total === 0) return null;


  return (
    <div className="overlay-widget" style={{
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 12,
      fontSize: 12,
    }}>
      {counts.pending > 0 && <Pill color={STATUS_COLORS.pending} label={STATUS_LABELS.pending} count={counts.pending} />}
      {counts.exploring > 0 && <Pill color={STATUS_COLORS.exploring} label={STATUS_LABELS.exploring} count={counts.exploring} />}
      {counts.eliminated > 0 && <Pill color={STATUS_COLORS.eliminated} label={STATUS_LABELS.eliminated} count={counts.eliminated} />}
      {counts.corroborated > 0 && <Pill color={STATUS_COLORS.corroborated} label={STATUS_LABELS.corroborated} count={counts.corroborated} />}
      {counts.outOfScope > 0 && <Pill color={STATUS_COLORS['out-of-scope']} label={STATUS_LABELS['out-of-scope']} count={counts.outOfScope} />}
      <span style={{ color: '#6b7280', borderLeft: '1px solid #30363d', paddingLeft: 12 }}>
        {counts.total} total
      </span>
      {grounding.total > 0 && (
        <span
          title="Settled leaves whose verdict rests on a verbatim record rather than a paraphrase"
          style={{
            borderLeft: '1px solid #30363d', paddingLeft: 12,
            color: grounding.grounded === grounding.total ? '#3fb950' : '#d29922',
          }}
        >
          grounded {grounding.grounded}/{grounding.total}
        </span>
      )}
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
