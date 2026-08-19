import type { ArtifactRef } from '../types';

/**
 * Pure projections for reading a captured artifact, kept out of the component so
 * the addressing, the opening line window, and the integrity wording are
 * testable without a browser.
 */

/** Lines shown either side of a cited excerpt, so a reader sees what surrounds it. */
export const WINDOW_CONTEXT_LINES = 20;

/** Lines fetched when nothing was cited and the length is unknown. */
export const WINDOW_DEFAULT_LINES = 200;

export interface ArtifactUrls {
  meta: string;
  raw: string;
  lines: (from: number, to: number) => string;
}

/** Read endpoints for one artifact. Relative, so the dashboard talks to whichever
 *  port its own session server bound. */
export function artifactUrls(ref: Pick<ArtifactRef, 'id' | 'sessionId'>): ArtifactUrls {
  const base = `/api/artifacts/${ref.sessionId}/${ref.id}`;
  return {
    meta: `${base}/meta`,
    raw: `${base}/raw`,
    lines: (from, to) => `${base}/lines?from=${from}&to=${to}`,
  };
}

export interface LineRange {
  from: number;
  to: number;
}

/**
 * The window to open on.
 *
 * A cited excerpt is what the record is about, so the reader lands there with
 * surrounding context rather than at the top of a long log.
 */
export function initialWindow(ref: Pick<ArtifactRef, 'excerpt' | 'lineCount'>): LineRange {
  const last = ref.lineCount;
  if (!ref.excerpt) {
    return { from: 1, to: last !== undefined ? Math.min(last, WINDOW_DEFAULT_LINES) : WINDOW_DEFAULT_LINES };
  }
  const from = Math.max(1, ref.excerpt.startLine - WINDOW_CONTEXT_LINES);
  const wanted = ref.excerpt.endLine + WINDOW_CONTEXT_LINES;
  return { from, to: last !== undefined ? Math.min(last, wanted) : wanted };
}

/** One page of an artifact's lines, as the line-window endpoint returns it. */
export interface ArtifactPage {
  lines: string[];
  from: number;
  to: number;
  totalLines: number;
  /** True when the requested range was cut to the server's window cap. */
  truncated: boolean;
}

/**
 * Whether this artifact is shown as numbered lines rather than offered as a
 * download.
 *
 * Reads the line count the capture recorded, which is present exactly when the
 * bytes were treated as text there — restating that judgement here would let the
 * two drift, and a viewer would then page a file the store never counted.
 */
export function rendersAsLines(ref: Pick<ArtifactRef, 'lineCount'>): boolean {
  return ref.lineCount !== undefined;
}

export interface IntegrityNotice {
  tone: 'error';
  message: string;
}

/**
 * What to tell a reader about the stored bytes, or null when they match the
 * digest recorded at capture — the ordinary case, which needs no notice.
 */
export function integrityNotice(verdict: 'verified' | 'mismatch' | 'missing'): IntegrityNotice | null {
  if (verdict === 'verified') return null;
  return {
    tone: 'error',
    message: verdict === 'mismatch'
      ? 'The stored bytes no longer match the digest recorded when they were captured.'
      : 'The stored bytes are gone, so this record can no longer be checked against them.',
  };
}

/** One line describing the capture: what it is, how big, and how the command it
 *  came from ended when that ending was a failure. */
export function artifactSummary(ref: ArtifactRef): string {
  const parts = [ref.filename];
  if (ref.lineCount !== undefined) parts.push(`${ref.lineCount} lines`);
  parts.push(formatBytes(ref.bytes));
  // A zero status is the expected case and says nothing a reader needs.
  if (ref.exitCode !== undefined && ref.exitCode !== 0) parts.push(`exit ${ref.exitCode}`);
  return parts.join(' · ');
}

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** Size in the largest unit that keeps the number small, with at most one decimal. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
}
