import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rendersAsLines, ARTIFACT_ROUTE_PREFIX } from '../types';
import {
  artifactUrls,
  artifactSummary,
  initialWindow,
  integrityNotice,
  formatBytes,
  shiftWindow,
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
    expect(u.meta).toBe(`${ARTIFACT_ROUTE_PREFIX}/${SESSION}/${ID}/meta`);
    expect(u.raw).toBe(`${ARTIFACT_ROUTE_PREFIX}/${SESSION}/${ID}/raw`);
    expect(u.lines(3, 9)).toBe(`${ARTIFACT_ROUTE_PREFIX}/${SESSION}/${ID}/lines?from=3&to=9`);
  });

  it('composes the prefix the server routes rather than restating it', () => {
    // Two independent spellings of one route drift silently: the viewer keeps
    // compiling and only fails when it asks for bytes.
    expect(artifactUrls(ref()).meta.startsWith(`${ARTIFACT_ROUTE_PREFIX}/`)).toBe(true);
  });
});

describe('initialWindow addresses a range the read endpoint accepts', () => {
  // parseArtifactRoute refuses a range that ends before it starts, and answers
  // 400; the viewer reports that as "could not read the stored bytes", which is
  // a lie about bytes that verify against their digest.
  const valid = (r: { from: number; to: number }) => r.from >= 1 && r.to >= r.from;

  it('opens on a readable range for an artifact with no lines at all', () => {
    expect(valid(initialWindow(ref({ lineCount: 0 })))).toBe(true);
  });

  it('opens on a readable range when the citation lies past the end', () => {
    // Nothing validates a cited line against the length at capture time, so the
    // viewer has to survive one.
    const w = initialWindow(ref({ lineCount: 10, excerpt: { startLine: 31, endLine: 31 } }));
    expect(valid(w)).toBe(true);
    expect(w.to).toBeLessThanOrEqual(10);
  });

  it('never addresses a line beyond the recorded length', () => {
    for (const lineCount of [0, 1, 5, 500]) {
      for (const startLine of [1, 3, 40, 600]) {
        const w = initialWindow(ref({ lineCount, excerpt: { startLine, endLine: startLine } }));
        expect(valid(w), `lineCount ${lineCount}, startLine ${startLine}`).toBe(true);
        expect(w.to, `lineCount ${lineCount}, startLine ${startLine}`).toBeLessThanOrEqual(Math.max(1, lineCount));
      }
    }
  });
});

describe('shiftWindow', () => {
  it('resumes at the line after the last one served', () => {
    // The endpoint caps a window. Advancing by the span that was *asked* for
    // steps over the lines the cap withheld, and nothing can reach them again.
    const asked = { from: 1, to: 2000 };
    const served = { from: 1, to: 500, truncated: true };
    expect(shiftWindow(asked, 1, served)).toEqual({ from: 501, to: 1000 });
  });

  it('leaves no gap over a run of forward pages', () => {
    // Walk forward the way a reader does, with the server capping every read.
    const CAP = 500;
    let range = { from: 1, to: 2000 };
    let expectedNext = 1;
    for (let i = 0; i < 5; i++) {
      const served = { from: range.from, to: Math.min(range.to, range.from + CAP - 1), truncated: true };
      expect(served.from).toBe(expectedNext);
      expectedNext = served.to + 1;
      range = shiftWindow(range, 1, served);
    }
  });

  it('steps back to the lines just before the ones served', () => {
    expect(shiftWindow({ from: 501, to: 1000 }, -1, { from: 501, to: 1000, truncated: false }))
      .toEqual({ from: 1, to: 500 });
  });

  it('stops at the first line rather than addressing line zero', () => {
    const back = shiftWindow({ from: 1, to: 200 }, -1, { from: 1, to: 200, truncated: false });
    expect(back.from).toBe(1);
    expect(back.to).toBeGreaterThanOrEqual(back.from);
  });

  it('keeps the page size when the file runs out before the page does', () => {
    // Paging back toward the top leaves fewer lines than a page. Taking the page
    // size from that short window shrinks every later page too, so a reader who
    // walks to the start is left reading two lines at a time.
    const span = 43;
    const served = { from: 3, to: 45, truncated: false };
    const back = shiftWindow({ from: 3, to: 45 }, -1, served);
    expect(back.from).toBe(1);
    expect(back.to - back.from + 1).toBe(span);
  });

  it('holds the page size over a walk to the top and back', () => {
    const SPAN = 43;
    const TOTAL = 860;
    let range = { from: 400, to: 400 + SPAN - 1 };
    for (let i = 0; i < 15; i++) {
      const served = {
        from: Math.max(1, range.from),
        to: Math.min(TOTAL, range.to),
        truncated: false,
      };
      range = shiftWindow(range, -1, served);
      expect(range.to - range.from + 1, `page ${i} lost its size`).toBe(SPAN);
      expect(range.from).toBeGreaterThanOrEqual(1);
    }
    // And forward again, still a full page.
    const served = { from: 1, to: SPAN, truncated: false };
    const fwd = shiftWindow(range, 1, served);
    expect(fwd.to - fwd.from + 1).toBe(SPAN);
  });

  it('adopts the served size only when the endpoint capped the window', () => {
    // A cut window sets the page size from then on, so later requests match what
    // the endpoint will actually serve.
    const capped = shiftWindow({ from: 1, to: 5000 }, 1, { from: 1, to: 2000, truncated: true });
    expect(capped).toEqual({ from: 2001, to: 4000 });
  });

  it('falls back to the requested range before anything has been served', () => {
    expect(shiftWindow({ from: 1, to: 100 }, 1)).toEqual({ from: 101, to: 200 });
  });
});

describe('the viewer never depends on a value rebuilt every render', () => {
  // An effect that lists a freshly-built object refires on every render, and its
  // own setState causes that render: one open viewer then fetches without bound.
  //
  // Checked as the property rather than by naming the identifier that once caused
  // it, so the same defect under a different name is still caught.
  const SRC = readFileSync(resolve(__dirname, '../components/ArtifactViewer.tsx'), 'utf-8');

  /**
   * Component-scope bindings rebuilt on every render AND compared by identity:
   * assigned straight from a call that is not a memoising hook, and used
   * somewhere as an object (a property read or an invocation).
   *
   * A call returning a primitive is excluded — a string or a boolean is compared
   * by value, so listing it is stable and correct.
   */
  const unstableBindings = (src: string): string[] => {
    const found: string[] = [];
    const decl = /^  const (\w+) = (?:await\s+)?(\w+)\s*\(/gm;
    for (const m of src.matchAll(decl)) {
      const [, name, callee] = m;
      if (/^(useMemo|useCallback|useState|useRef|useReducer|useContext)$/.test(callee)) continue;
      const usedAsObject = new RegExp(`\\b${name}(\\.|\\()`).test(src);
      if (usedAsObject) found.push(name);
    }
    return found;
  };

  /** Every dependency array in the file, as lists of identifiers. */
  const dependencyLists = (src: string): string[][] =>
    [...src.matchAll(/\}, \[([^\]]*)\]\);/g)]
      .map((m) => m[1].split(',').map((d) => d.trim()).filter(Boolean));

  it('lists no render-built binding among its effect dependencies', () => {
    const unstable = unstableBindings(SRC);
    const lists = dependencyLists(SRC);
    expect(lists.length, 'no dependency arrays found — the check would pass vacuously').toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const list of lists) {
      for (const dep of list) {
        // A member read off a binding is a value, not the binding itself.
        if (dep.includes('.')) continue;
        if (unstable.includes(dep)) offenders.push(`${dep} in [${list.join(', ')}]`);
      }
    }
    expect(offenders, `these dependencies are rebuilt every render:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('recognises the shape it is guarding against', () => {
    // Guards the guard: the detector must flag a binding assigned from a plain
    // call and ignore one wrapped in a memoising hook.
    const sample = [
      '  const built = makeThing(a, b);',
      '  const flag = isThing(a);',
      '  const held = useMemo(() => makeThing(a, b), [a, b]);',
      '  fetch(built.url);',
      '  if (flag) return null;',
      '  }, [built, held]);',
    ].join('\n');
    // `built` is read as an object; `flag` is a primitive; `held` is memoised.
    expect(unstableBindings(sample)).toEqual(['built']);
    expect(dependencyLists(sample)).toEqual([['built', 'held']]);
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

  it('distinguishes a check that could not be run from one that passed', () => {
    // Rendering an unrun check as a pass claims a verification that never
    // happened, which is the one thing a verbatim record must not do.
    const unknown = integrityNotice('unknown');
    expect(unknown).not.toBeNull();
    expect(unknown?.tone).toBe('warning');
    expect(unknown?.message).not.toBe(integrityNotice('mismatch')?.message);
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

describe('rendersAsLines', () => {
  // The store counts lines exactly for the bytes it treated as text, so the
  // viewer reads that judgement instead of making its own.
  it('is true for an artifact the capture counted lines for', () => {
    expect(rendersAsLines(ref({ lineCount: 500 }))).toBe(true);
  });

  it('is true for a counted but empty artifact, which renders as no lines', () => {
    expect(rendersAsLines(ref({ lineCount: 0 }))).toBe(true);
  });

  it('is false for bytes that were never counted, which are offered as a download', () => {
    expect(rendersAsLines(ref({ lineCount: undefined }))).toBe(false);
  });
});
