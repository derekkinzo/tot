/**
 * One-time, non-destructive migration of legacy per-project session journals
 * ({projectDir}/.tot/sessions/*.jsonl) into central storage. Copies — never
 * moves — with exclusive create, so an existing central file is never
 * overwritten even when two servers migrate the same project concurrently. Safe
 * to run on every startup; it cannot lose or clobber data.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, constants as fsConstants } from 'node:fs';
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
    try {
      // Exclusive create: the copy itself fails with EEXIST if a central file is
      // already present, rather than checking existsSync first (a TOCTOU that a
      // concurrent second server could slip through and clobber). The central
      // copy is authoritative and may have advanced past this legacy snapshot,
      // so an existing dest is the expected, non-error outcome.
      copyFileSync(join(legacyDir, file), dest, fsConstants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      console.error(`[tot-mcp] Warning: failed to migrate legacy session ${file}: ${err}`);
    }
  }
}
