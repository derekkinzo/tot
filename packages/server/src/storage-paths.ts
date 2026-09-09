/**
 * Filesystem helpers for the tot state root.
 *
 * The state root holds central per-project storage
 * (<totDir>/projects/<hash>/sessions/). Resolution precedence:
 * $TOT_DATA_DIR (explicit override) > $XDG_STATE_HOME/tot > ~/.tot.
 */

import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Creates a directory of the state root, and any parents, readable only by the
 * user who owns it.
 *
 * A stored tree holds whatever the investigation looked at: log excerpts, command
 * output, and file contents captured verbatim from the machine it ran on. The
 * default mode leaves all of that readable by every account on the host, and the
 * store's path is derivable rather than secret, so it is readable in practice and
 * not merely in principle.
 *
 * The mode applies to directories this creates; one that already exists keeps
 * whatever mode it has, since a user may have set it deliberately.
 */
export function ensureStoreDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Returns the tot state root directory.
 * Precedence: $TOT_DATA_DIR (explicit override) > $XDG_STATE_HOME/tot > ~/.tot.
 */
export function getTotDir(): string {
  const override = process.env['TOT_DATA_DIR'];
  if (override) return override;
  const xdg = process.env['XDG_STATE_HOME'];
  if (xdg) return join(xdg, 'tot');
  return join(homedir(), '.tot');
}

/**
 * Writes `content` to `filePath` atomically: write to a temp sibling then
 * rename (atomic on the same filesystem). Falls back to a direct write if the
 * rename fails.
 */
export function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, content, 'utf-8');
  try {
    renameSync(tmpPath, filePath);
  } catch {
    writeFileSync(filePath, content, 'utf-8');
    try { unlinkSync(tmpPath); } catch { /* temp already gone */ }
  }
}
