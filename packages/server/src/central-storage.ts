/**
 * Central per-project storage layout. Session journals live under
 * <totDir>/projects/<hash>/sessions/ where <hash> is derived from the project's
 * absolute path, so trees are discoverable in one place (like ~/.claude/projects)
 * and repos stay free of a per-project .tot directory.
 */
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { writeFileSync, renameSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { getTotDir } from './daemon-lifecycle.js';

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

/**
 * Records the real project path alongside its hash so a future cross-project
 * listing can display human-readable paths. Atomic (temp + rename); idempotent.
 */
export function writeProjectMeta(projectDir: string): void {
  const dir = getCentralProjectDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const metaPath = join(dir, 'meta.json');
  const absPath = resolve(projectDir);
  if (existsSync(metaPath)) {
    try {
      const existing = JSON.parse(readFileSync(metaPath, 'utf-8'));
      if (existing.projectDir === absPath) return; // unchanged
    } catch {
      // fall through to rewrite a corrupt meta
    }
  }
  const tmp = metaPath + '.tmp';
  writeFileSync(tmp, JSON.stringify({ projectDir: absPath }, null, 2));
  renameSync(tmp, metaPath);
}
