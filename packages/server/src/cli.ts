#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { getCentralSessionsDir, hashProjectDir } from './central-storage.js';
import { getTotDir } from './storage-paths.js';
import { scanSessions } from './persistence.js';

const USAGE = `tot-mcp [command]
  (default)  Start the per-session MCP server (stdio). One process per agent;
             the visualization dashboard URL is reported by the get_status tool.
  status     Show this project's central storage location and recent sessions
  --help     Show this message

Environment:
  TOT_DATA_DIR   Override the state root (default: $XDG_STATE_HOME/tot or ~/.tot)`;

const args = process.argv.slice(2);

if (args[0] === '--help' || args[0] === '-h') {
  console.log(USAGE);
} else if (args[0] === 'status') {
  for (const line of statusLines()) console.log(line);
} else if (args[0] === undefined) {
  import('./per-session.js').then(({ startServer }) => {
    startServer().catch((err) => {
      console.error('[tot-mcp] Fatal:', err);
      process.exit(1);
    });
  });
} else {
  console.error(`Unknown command: ${args[0]}. Use --help for usage.`);
  process.exit(1);
}

/**
 * Builds the lines printed by `tot-mcp status`: a pure read of central storage
 * for the current project (no running server is required or queried).
 */
export function statusLines(): string[] {
  const lines: string[] = [];
  const totDir = getTotDir();
  const projectDir = process.env['CLAUDE_PROJECT_DIR'] || process.cwd();
  const dataDir = getCentralSessionsDir(projectDir);

  lines.push(`State root: ${totDir}`);
  lines.push(`Project: ${projectDir}`);
  lines.push(`  hash: ${hashProjectDir(projectDir)}`);
  lines.push(`  sessions: ${dataDir}`);
  lines.push('');

  if (!existsSync(dataDir)) {
    lines.push('No sessions yet for this project.');
    return lines;
  }

  const sessions = scanSessions(dataDir);
  if (sessions.length === 0) {
    lines.push('No sessions yet for this project.');
    return lines;
  }

  lines.push(`Sessions: ${sessions.length}`);
  // Open sessions first (then most-recent), so the truncated list always shows
  // any still-open session — the SessionStart hook greps this output for one.
  const sorted = [...sessions].sort((a, b) => {
    const aOpen = a.status === 'open' ? 0 : 1;
    const bOpen = b.status === 'open' ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  for (const s of sorted.slice(0, 5)) {
    const icon = s.status === 'open' ? '*' : s.status === 'resolved' ? '+' : '-';
    lines.push(`  [${icon}] ${s.id.slice(0, 8)} "${s.problem.slice(0, 50)}" (${s.nodeCount} nodes)`);
  }
  if (sorted.length > 5) {
    lines.push(`  ... and ${sorted.length - 5} more`);
  }
  return lines;
}
