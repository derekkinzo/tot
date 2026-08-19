import { describe, it, expect } from 'vitest';
import {
  artifactUrls,
  artifactSummary,
  initialWindow,
  integrityNotice,
  formatBytes,
  WINDOW_CONTEXT_LINES,
} from './artifactView';
import type { ArtifactRef } from '../types';

const SESSION = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

function ref(over: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    id: ID, sessionId: SESSION, filename: 'build.log', mediaType: 'text/plain',
    bytes: 2048, lineCount: 500, digest: { alg: 'sha-256', value: 'abc' },
    capturedAt: '2024-01-01T00:00:00.000Z', ...over,
  };
}

describe('artifactUrls', () => {
  it('addresses an artifact by session and id', () => {
    const u = artifactUrls(ref());
    expect(u.meta).toBe(`/api/artifacts/${SESSION}/${ID}/meta`);
    expect(u.raw).toBe(`/api/artifacts/${SESSION}/${ID}/raw`);
    expect(u.lines(3, 9)).toBe(`/api/artifacts/${SESSION}/${ID}/lines?from=3&to=9`);
  });
});

describe('initialWindow', () => {
  it('centres the window on the cited excerpt, with context around it', () => {
    // The point of an excerpt is that a reader lands on the lines the claim is
    // about, not at the top of a 500-line log.
    const w = initialWindow(ref({ excerpt: { startLine: 200, endLine: 205 } }));
    expect(w.from).toBe(200 - WINDOW_CONTEXT_LINES);
    expect(w.to).toBe(205 + WINDOW_CONTEXT_LINES);
  });

  it('never asks for a line before the first', () => {
    const w = initialWindow(ref({ excerpt: { startLine: 2, endLine: 3 } }));
    expect(w.from).toBe(1);
  });

  it('never asks past the last line when the count is known', () => {
    const w = initialWindow(ref({ lineCount: 12, excerpt: { startLine: 11, endLine: 12 } }));
    expect(w.to).toBe(12);
  });

  it('starts at the top when no excerpt was cited', () => {
    const w = initialWindow(ref({ excerpt: undefined }));
    expect(w.from).toBe(1);
    expect(w.to).toBeGreaterThan(1);
  });

  it('asks for the whole of a short artifact rather than a fixed page', () => {
    expect(initialWindow(ref({ lineCount: 4, excerpt: undefined }))).toEqual({ from: 1, to: 4 });
  });
});

describe('integrityNotice', () => {
  it('says nothing in the ordinary case, so the exceptions stand out', () => {
    expect(integrityNotice('verified')).toBeNull();
  });

  it('reports altered bytes as an error naming what changed', () => {
    const n = integrityNotice('mismatch');
    expect(n?.tone).toBe('error');
    expect(n?.message).toMatch(/changed since|no longer match/i);
  });

  it('reports absent bytes distinctly from altered ones', () => {
    const n = integrityNotice('missing');
    expect(n?.tone).toBe('error');
    expect(n?.message).not.toBe(integrityNotice('mismatch')?.message);
  });
});

describe('artifactSummary', () => {
  it('leads with the filename and states the size in readable units', () => {
    expect(artifactSummary(ref({ bytes: 2048, lineCount: 500 }))).toBe('build.log · 500 lines · 2 KB');
  });

  it('omits a line count for bytes that are not lines', () => {
    const s = artifactSummary(ref({ filename: 'core.bin', mediaType: 'application/octet-stream', lineCount: undefined }));
    expect(s).toBe('core.bin · 2 KB');
  });

  it('reports a failing exit status, which is often the whole point of the capture', () => {
    expect(artifactSummary(ref({ exitCode: 1 }))).toContain('exit 1');
  });

  it('omits a successful exit status rather than adding noise', () => {
    expect(artifactSummary(ref({ exitCode: 0 }))).not.toContain('exit');
  });
});

describe('formatBytes', () => {
  it('scales to the unit that keeps the number readable', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3 MB');
  });
});
