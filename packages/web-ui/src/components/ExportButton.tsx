import { useState } from 'react';
import type { Hypothesis, Session } from '../types';
import { generateMarkdown } from '../tree/exportMarkdown';

interface Props {
  session: Session | null;
  hypotheses: Map<string, Hypothesis>;
}

export default function ExportButton({ session, hypotheses }: Props) {
  const [showMenu, setShowMenu] = useState(false);

  if (!session || hypotheses.size === 0) return null;

  const exportMarkdown = () => {
    const md = generateMarkdown(session, hypotheses);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tot-${session.id.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    setShowMenu(false);
  };

  const copyMarkdown = async () => {
    const md = generateMarkdown(session, hypotheses);
    // writeText returns a Promise that can reject after the sync block exits
    // (document not focused, permission denied), so await it inside the try —
    // a sync try/catch would let the rejection escape as an unhandledrejection.
    try {
      await navigator.clipboard?.writeText(md);
    } catch { /* clipboard unavailable or write rejected */ }
    setShowMenu(false);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setShowMenu(!showMenu)}
        style={{
          background: 'none', border: '1px solid #30363d', borderRadius: 4,
          color: '#8b949e', fontSize: 11, padding: '3px 8px', cursor: 'pointer',
        }}
      >
        Export ▾
      </button>
      {showMenu && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          background: '#1c1f26', border: '1px solid #30363d', borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)', padding: '4px 0', minWidth: 160, zIndex: 1000,
        }}>
          <button onClick={exportMarkdown} style={menuItemStyle}>Download as Markdown</button>
          <button onClick={copyMarkdown} style={menuItemStyle}>Copy as Markdown</button>
        </div>
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: 'block', width: '100%', padding: '8px 14px',
  background: 'none', border: 'none', color: '#e1e4e8',
  fontSize: 13, cursor: 'pointer', textAlign: 'left',
};
