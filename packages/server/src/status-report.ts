/**
 * The read-out of a project's central storage: where its trees are kept and
 * which sessions are there.
 *
 * A pure read — no server is started, queried, or required — kept apart from the
 * command that prints it so the wording can be held to the same standard as
 * every other surface that reports on stored trees.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getCentralSessionsDir, hashProjectDir, readProjectMeta } from './central-storage.js';
import { getTotDir } from './storage-paths.js';
import { scanSessions } from './persistence.js';

/**
 * Collapses whitespace and truncates, so agent-supplied text occupies exactly
 * one line. A status line is read by eye and matched by line-oriented tools; an
 * embedded newline would let a problem statement forge a second line.
 */
function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Builds the lines printed for a project's stored sessions.
 *
 * Defaults to the project the command was launched for: what the client named,
 * else the working directory.
 */
export function statusLines(
  projectDir: string = process.env['CLAUDE_PROJECT_DIR'] || process.cwd(),
): string[] {
  const lines: string[] = [];
  const dataDir = getCentralSessionsDir(projectDir);

  lines.push(`State root: ${getTotDir()}`);
  lines.push(`Project: ${projectDir}`);
  lines.push(`  hash: ${hashProjectDir(projectDir)}`);
  lines.push(`  sessions: ${dataDir}`);
  // The store's own account of whose trees these are. The path above is the one
  // this command was launched with, and the directory is named by its digest, so
  // the two agreeing is what establishes that the sessions below belong to this
  // project rather than to another that lands on the same directory.
  const recorded = readProjectMeta(projectDir);
  if (recorded !== undefined && recorded !== resolve(projectDir)) {
    lines.push(`  ⚠ recorded for: ${recorded}`);
    lines.push('  The sessions below were written for that path, not this one.');
  }
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
    let line = `  [${icon}] ${s.id.slice(0, 8)} "${oneLine(s.problem, 50)}" (${s.nodeCount} nodes)`;
    // Named against the session it belongs to, because the tree that is short is
    // the one a reader will open, and a project-level total says nothing about
    // which that is.
    if (s.unreadableLines > 0) line += ` ⚠ ${s.unreadableLines} unreadable`;
    lines.push(line);
  }
  if (sorted.length > 5) {
    lines.push(`  ... and ${sorted.length - 5} more`);
  }
  return lines;
}
