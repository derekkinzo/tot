import { ARTIFACT_ROUTE_PREFIX } from '../types';
import type { ArtifactIntegrity, ArtifactLineWindow, ArtifactRef } from '../types';

/**
 * Pure projections for reading a captured artifact, kept out of the component so
 * the addressing, the line windowing, and the integrity wording are testable
 * without a browser.
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
  const base = `${ARTIFACT_ROUTE_PREFIX}/${ref.sessionId}/${ref.id}`;
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
 * surrounding context rather than at the top of a long log. The range is kept
 * inside the artifact: a citation past the end, or a file with no lines at all,
 * would otherwise address a range the read endpoint refuses, and the reader
 * would be told the bytes could not be read when they are intact.
 */
export function initialWindow(ref: Pick<ArtifactRef, 'excerpt' | 'lineCount'>): LineRange {
  const last = ref.lineCount;
  // An empty artifact still has a line 1 to ask for; it comes back empty.
  const clamp = (n: number) => (last === undefined ? n : Math.min(n, Math.max(1, last)));
  if (!ref.excerpt) {
    return { from: 1, to: clamp(WINDOW_DEFAULT_LINES) };
  }
  const from = clamp(Math.max(1, ref.excerpt.startLine - WINDOW_CONTEXT_LINES));
  return { from, to: clamp(Math.max(from, ref.excerpt.endLine + WINDOW_CONTEXT_LINES)) };
}

/**
 * The next window when the reader pages.
 *
 * Anchored to what the last read actually served, not to what was asked for: the
 * endpoint caps a window, so advancing by the requested span would step over the
 * lines the cap withheld and leave them unreachable.
 */
export function shiftWindow(
  current: LineRange,
  direction: -1 | 1,
  served?: Pick<ArtifactLineWindow, 'from' | 'to' | 'truncated'>,
): LineRange {
  // The page size is the range the reader asked for. A window the endpoint CUT to
  // its cap resets that size, so later pages match what it will actually serve; a
  // window merely short because the file ran out does not, or walking to the top
  // of a log would shrink the page and leave every later page shrunk with it.
  const requested = Math.max(1, current.to - current.from + 1);
  const span = served?.truncated
    ? Math.max(1, served.to - served.from + 1)
    : requested;
  const anchor = served ?? current;
  if (direction === 1) {
    const from = anchor.to + 1;
    return { from, to: from + span - 1 };
  }
  const from = Math.max(1, anchor.from - span);
  return { from, to: from + span - 1 };
}

export interface IntegrityNotice {
  tone: 'error' | 'warning';
  message: string;
}

/**
 * What to tell a reader about the stored bytes, or null when they match the
 * digest recorded at capture — the ordinary case, which needs no notice.
 *
 * 'unknown' is its own case rather than a silent pass: a check that could not be
 * run says nothing about the bytes, and rendering it as a clean result would
 * claim a verification that never happened.
 */
export function integrityNotice(verdict: ArtifactIntegrity | 'unknown'): IntegrityNotice | null {
  switch (verdict) {
    case 'verified':
      return null;
    case 'mismatch':
      return { tone: 'error', message: 'The stored bytes no longer match the digest recorded when they were captured.' };
    case 'missing':
      return { tone: 'error', message: 'The stored bytes are gone, so this record can no longer be checked against them.' };
    case 'unknown':
      return { tone: 'warning', message: 'The stored bytes could not be checked against their digest.' };
  }
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
