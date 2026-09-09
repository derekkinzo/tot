/**
 * One-time, non-destructive migration of legacy per-project session journals
 * ({projectDir}/.tot/sessions/*.jsonl) into central storage. Copies — never
 * moves — with exclusive create, so an existing central file is never
 * overwritten even when two servers migrate the same project concurrently.
 *
 * Runs at startup and records that it ran, because the legacy directory stays
 * where it is: without a marker, a session the user later deleted from central
 * storage would be copied back from it at the next startup, and the deletion
 * would not hold.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { getCentralProjectDir, getCentralSessionsDir } from './central-storage.js';
import { atomicWrite } from './storage-paths.js';

/** Records that the legacy directory has already been read, so it is read once. */
function markerPath(projectDir: string): string {
  return join(getCentralProjectDir(projectDir), 'legacy-migrated.json');
}

export function migrateLegacySessions(projectDir: string): void {
  const legacyDir = join(projectDir, '.tot', 'sessions');
  if (!existsSync(legacyDir)) return;
  if (existsSync(markerPath(projectDir))) return;

  let files: string[];
  try {
    files = readdirSync(legacyDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return;
  }
  if (files.length === 0) return;

  const centralDir = getCentralSessionsDir(projectDir);
  mkdirSync(centralDir, { recursive: true });

  let copiedAll = true;
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
      copiedAll = false;
      console.error(`[tot-mcp] Warning: failed to migrate legacy session ${file}: ${err}`);
    }
  }

  // Only once every journal is accounted for, so a startup that could not read
  // one of them tries again rather than leaving it behind permanently.
  if (!copiedAll) return;
  try {
    atomicWrite(
      markerPath(projectDir),
      JSON.stringify({ legacyDir, migratedAt: new Date().toISOString() }, null, 2),
    );
  } catch (err) {
    // The copies landed, which is the part that matters; without the marker the
    // next startup repeats a run that cannot clobber anything.
    console.error(`[tot-mcp] Warning: failed to record legacy migration: ${err}`);
  }
}
