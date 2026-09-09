/**
 * Central per-project storage layout. Session journals live under
 * <totDir>/projects/<hash>/sessions/ where <hash> is derived from the project's
 * absolute path, so trees are discoverable in one place (like ~/.claude/projects)
 * and repos stay free of a per-project .tot directory.
 */
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite, ensureStoreDir, getTotDir } from './storage-paths.js';
import { artifactsDirFor } from './artifacts.js';

/**
 * Stable directory key for a project: the first 16 hex chars of
 * sha256(resolve(projectDir)). resolve() normalizes path form (./, ..) but does
 * NOT resolve symlinks — two distinct symlinks to the same target hash apart,
 * which is the intended "key by the path the agent was launched with" behavior.
 */
export function hashProjectDir(projectDir: string): string {
  return createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 16);
}

/** <totDir>/projects/<hash> — the per-project directory. */
export function getCentralProjectDir(projectDir: string): string {
  return join(getTotDir(), 'projects', hashProjectDir(projectDir));
}

/** <totDir>/projects/<hash>/sessions — where this project's JSONL journals live. */
export function getCentralSessionsDir(projectDir: string): string {
  return join(getCentralProjectDir(projectDir), 'sessions');
}
/** <totDir>/projects/<hash>/artifacts — where this project's captured bytes live. */
export function getCentralArtifactsDir(projectDir: string): string {
  return artifactsDirFor(getCentralSessionsDir(projectDir));
}


/**
 * The project path a store directory was written for, or undefined when it
 * records none.
 *
 * The directory name is a digest, so it cannot be read back into a path. This is
 * the only account of which project the trees inside belong to — worth consulting
 * before reading them, because a directory reached by hashing one path while
 * holding trees recorded for another is describing a different project's
 * investigation.
 */
export function readProjectMeta(projectDir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(getCentralProjectDir(projectDir), 'meta.json'), 'utf-8'),
    );
    const recorded = (parsed as { projectDir?: unknown }).projectDir;
    return typeof recorded === 'string' && recorded !== '' ? recorded : undefined;
  } catch {
    // Absent, unreadable, or not describing a path: all say the same thing to a
    // caller, which is that this store does not name its project.
    return undefined;
  }
}

/**
 * Records the real project path alongside its hash so a cross-project listing
 * can display human-readable paths. Atomic (temp + rename); idempotent.
 * Best-effort: meta.json is non-essential, so any failure is logged and
 * swallowed rather than aborting server startup.
 *
 * Creates the project directory, so call it for a project that has trees — a
 * directory holding only this file describes a project with nothing in it.
 */
export function writeProjectMeta(projectDir: string): void {
  const absPath = resolve(projectDir);
  try {
    const dir = getCentralProjectDir(projectDir);
    ensureStoreDir(dir);
    const metaPath = join(dir, 'meta.json');
    if (existsSync(metaPath)) {
      try {
        const existing: unknown = JSON.parse(readFileSync(metaPath, 'utf-8'));
        if (typeof existing === 'object' && existing !== null
          && (existing as { projectDir?: unknown }).projectDir === absPath) {
          return; // unchanged
        }
      } catch {
        // fall through to rewrite a corrupt or non-object meta
      }
    }
    atomicWrite(metaPath, JSON.stringify({ projectDir: absPath }, null, 2));
  } catch (err) {
    console.error(`[tot-mcp] Warning: failed to write project meta: ${err}`);
  }
}
