import { useState } from 'react';
import { STATUS_COLORS, STATUS_LABELS, STATUS_NODE_STYLES } from '../theme';

export default function Legend() {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div className="overlay-widget" style={{
      fontSize: 12, maxWidth: 220,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 600, color: '#8b949e' }}>Legend</span>
        <button
          onClick={() => setDismissed(true)}
          style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 14 }}
        >×</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <LegendItem color={STATUS_COLORS.pending} icon={STATUS_NODE_STYLES.pending.icon} label={STATUS_LABELS.pending} />
        <LegendItem color={STATUS_COLORS.exploring} icon={STATUS_NODE_STYLES.exploring.icon} label={STATUS_LABELS.exploring} />
        <LegendItem color={STATUS_COLORS.eliminated} icon={STATUS_NODE_STYLES.eliminated.icon} label={STATUS_LABELS.eliminated} />
        <LegendItem color={STATUS_COLORS.corroborated} icon={STATUS_NODE_STYLES.corroborated.icon} label={STATUS_LABELS.corroborated} />
        <LegendItem color={STATUS_COLORS['out-of-scope']} icon={STATUS_NODE_STYLES['out-of-scope'].icon} label={STATUS_LABELS['out-of-scope']} />
      </div>
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #30363d', color: '#6b7280', lineHeight: 1.4 }}>
        Click: select • Alt+click: collapse<br/>
        ▼/▶ chevron: collapse/expand<br/>
        Right-click: context menu<br/>
        ↑↓←→: navigate • Esc: deselect
      </div>
    </div>
  );
}

function LegendItem({ color, icon, label }: { color: string; icon: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, border: `2px solid ${color}`, display: 'inline-block' }} />
      <span style={{ fontSize: 13 }}>{icon}</span>
      <span style={{ color: '#8b949e' }}>{label}</span>
    </div>
  );
}
