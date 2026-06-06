import { useState } from 'react';
import type { Hypothesis, Session } from '../types';
import { STATUS_NODE_STYLES } from '../theme';

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

  const copyMarkdown = () => {
    const md = generateMarkdown(session, hypotheses);
    try {
      navigator.clipboard?.writeText(md);
    } catch { /* clipboard unavailable */ }
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
          position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
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

function generateMarkdown(session: Session, hypotheses: Map<string, Hypothesis>): string {
  const lines: string[] = [];
  lines.push(`# ${session.problem}`);
  lines.push('');
  lines.push(`Status: ${session.status} | Created: ${new Date(session.createdAt).toLocaleString()}`);
  lines.push('');
  lines.push('## Hypothesis Tree');
  lines.push('');

  const root = hypotheses.get(session.rootNodeId);
  if (root) {
    renderNode(root, hypotheses, lines, 0);
  }

  return lines.join('\n');
}

function renderNode(node: Hypothesis, hypotheses: Map<string, Hypothesis>, lines: string[], depth: number): void {
  const indent = '  '.repeat(depth);
  const icon = STATUS_NODE_STYLES[node.status]?.icon ?? '?';
  const score = node.score !== null ? ` (${(node.score * 100).toFixed(0)}%)` : '';

  lines.push(`${indent}- ${icon} **${node.content}**${score} [${node.status}]`);

  if (node.conclusion) {
    lines.push(`${indent}  > ${node.conclusion.verdict}: ${node.conclusion.reason}`);
  }

  for (const ev of node.evidence) {
    lines.push(`${indent}  - _${ev.type}_: ${ev.content}${ev.source ? ` (${ev.source})` : ''}`);
  }

  for (const childId of node.children) {
    const child = hypotheses.get(childId);
    if (child) renderNode(child, hypotheses, lines, depth + 1);
  }
}
