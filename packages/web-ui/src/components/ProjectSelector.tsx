import { useState } from 'react';
import type { ProjectInfo } from '../hooks/useTreeStream';

interface Props {
  projects: ProjectInfo[];
  currentProject: string;
  onSwitch: (dir: string) => void;
}

export default function ProjectSelector({ projects, currentProject, onSwitch }: Props) {
  const [open, setOpen] = useState(false);

  if (projects.length <= 1) return null;

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none', border: '1px solid #30363d', borderRadius: 4,
          color: '#8b949e', fontSize: 11, padding: '3px 8px', cursor: 'pointer',
          marginLeft: 6,
        }}
      >
        Projects ▾
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          background: '#1c1f26', border: '1px solid #30363d', borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 1000,
          minWidth: 300, maxHeight: 300, overflowY: 'auto',
          padding: '4px 0',
        }}>
          {projects.map((p) => {
            const label = p.dir.split('/').slice(-2).join('/');
            const isActive = p.dir === currentProject;

            return (
              <button
                key={p.dir}
                onClick={() => { onSwitch(p.dir); setOpen(false); }}
                style={{
                  display: 'block', width: '100%', padding: '10px 14px',
                  background: isActive ? '#21262d' : 'none',
                  border: 'none', color: '#e1e4e8', fontSize: 13,
                  cursor: 'pointer', textAlign: 'left',
                }}
                onMouseEnter={(e) => { if (!isActive) (e.target as HTMLElement).style.background = '#21262d'; }}
                onMouseLeave={(e) => { if (!isActive) (e.target as HTMLElement).style.background = 'none'; }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{
                    fontFamily: 'monospace', fontSize: 12,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220,
                  }}>{label}</span>
                  <span style={{
                    fontSize: 10, padding: '2px 6px', borderRadius: 10,
                    background: p.activeProblem ? '#22c55e20' : '#6b728020',
                    color: p.activeProblem ? '#22c55e' : '#6b7280',
                  }}>{p.sessionCount} sessions</span>
                </div>
                {p.activeProblem && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.activeProblem}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
