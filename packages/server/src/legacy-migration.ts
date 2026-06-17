/**
 * One-time, non-destructive migration of legacy per-project session journals
 * ({projectDir}/.tot/sessions/*.jsonl) into central storage. Copies — never
 * moves — and never overwrites an existing central file, so it is safe to run
 * on every startup and cannot lose or clobber data.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCentralSessionsDir } from './central-storage.js';

export function migrateLegacySessions(projectDir: string): void {
  const legacyDir = join(projectDir, '.tot', 'sessions');
  if (!existsSync(legacyDir)) return;

  let files: string[];
  try {
    files = readdirSync(legacyDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return;
  }
  if (files.length === 0) return;

  const centralDir = getCentralSessionsDir(projectDir);
  mkdirSync(centralDir, { recursive: true });

  for (const file of files) {
    const dest = join(centralDir, file);
    // Skip files already present centrally — the central copy is authoritative
    // and may have advanced past this legacy snapshot.
    if (existsSync(dest)) continue;
    try {
      copyFileSync(join(legacyDir, file), dest);
    } catch (err) {
      console.error(`[tot-mcp] Warning: failed to migrate legacy session ${file}: ${err}`);
    }
  }
}
