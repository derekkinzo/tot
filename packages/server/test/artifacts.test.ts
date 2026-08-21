import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureArtifact,
  resolveArtifactPath,
  readLineWindow,
  checkIntegrity,
  discardArtifact,
  sniffMediaType,
  ARTIFACT_MAX_BYTES,
  ArtifactError,
} from '../src/artifacts.js';

describe('text is recognised by its bytes, not only by its name', () => {
  // Command output is captured under whatever name the agent chose. Deciding
  // text-ness from a short extension table means an excerpt cited against
  // 'ci-run.out' can never be rendered as lines, and the capture-time bound check
  // on that excerpt is skipped along with it.
  let artifactsDir: string;
  let sourceDir: string;
  const sessionId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'tot-sniff-art-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'tot-sniff-src-'));
  });
  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  const capture = (name: string, body: string | Buffer) => {
    const p = join(sourceDir, name);
    writeFileSync(p, body);
    return captureArtifact({ artifactsDir, sessionId, sourcePath: p });
  };

  it('counts the lines of text captured under an unlisted extension', async () => {
    const ref = await capture('ci-run.out', 'first\nsecond\nthird\n');
    expect(ref.lineCount).toBe(3);
    expect(ref.mediaType.startsWith('text/')).toBe(true);
  });

  it('counts the lines of text captured with no extension at all', async () => {
    const ref = await capture('build-output', 'one\ntwo\n');
    expect(ref.lineCount).toBe(2);
  });

  it('refuses an excerpt cited against bytes that have no lines', async () => {
    // Citing 'lines 3-5' of something the store never counted as lines describes
    // nothing a reader can be shown, and the viewer offers it as a download.
    const p = join(sourceDir, 'heap.dump');
    writeFileSync(p, Buffer.from([0x00, 0x01, 0x02]));
    await expect(captureArtifact({
      artifactsDir, sessionId, sourcePath: p, excerpt: { startLine: 1, endLine: 2 },
    })).rejects.toThrow(ArtifactError);
  });

  it('reads valid UTF-8 as text even where it contains a replacement character', async () => {
    // U+FFFD is a legal character that logs genuinely carry, often because some
    // upstream tool already substituted it. Treating its presence as proof the
    // bytes are not text makes the capture undisplayable and refuses its excerpt.
    const ref = await capture('unicode.out', 'first line\nsecond \uFFFD line\nthird\n');
    expect(ref.lineCount).toBe(3);
    expect(ref.mediaType.startsWith('text/')).toBe(true);
  });

  it('still offers genuinely binary bytes as a download', async () => {
    const ref = await capture('heap.dump', Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
    expect(ref.lineCount).toBeUndefined();
    expect(ref.mediaType).toBe('application/octet-stream');
  });

  it('bounds an excerpt against bytes it now knows the length of', async () => {
    const p = join(sourceDir, 'ci-run.out');
    writeFileSync(p, 'a\nb\n');
    await expect(captureArtifact({
      artifactsDir, sessionId, sourcePath: p, excerpt: { startLine: 9, endLine: 9 },
    })).rejects.toThrow(ArtifactError);
  });
});

describe('resolveArtifactPath', () => {
  // A reference reaches this function from a request the router already checked,
  // but also from a journal written by an earlier build. The path is joined here,
  // so this is where the components have to be answerable for.
  const DIR = '/state/artifacts';
  const GOOD = '11111111-1111-4111-8111-111111111111';

  it('keeps every resolved path inside the artifacts directory', () => {
    const hostile = [
      '..', '../..', '../../etc', '.', '', '/etc/passwd', 'a/../../b',
      '%2e%2e%2f', '..\\..', `${GOOD}/../..`, 'null', 'x'.repeat(300),
    ];
    for (const bad of hostile) {
      for (const ref of [{ sessionId: bad, id: GOOD }, { sessionId: GOOD, id: bad }]) {
        let resolved: string | null = null;
        try {
          resolved = resolveArtifactPath(DIR, ref);
        } catch {
          continue; // Refusing is the other acceptable outcome.
        }
        expect(resolved.startsWith(`${DIR}/`), `${bad} resolved to ${resolved}`).toBe(true);
        expect(resolved.includes('..'), `${bad} resolved to ${resolved}`).toBe(false);
      }
    }
  });

  it('resolves a minted reference to the session directory, then the id', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(resolveArtifactPath(DIR, { sessionId: GOOD, id })).toBe(`${DIR}/${GOOD}/${id}`);
  });
});

describe('an unaddressable reference is reported as itself', () => {
  // resolveArtifactPath refuses a reference whose ids cannot name a path. Callers
  // that fold that refusal into a verdict about the bytes tell the reader the
  // wrong thing: nothing was read, so nothing is known about the bytes.
  const BAD = { id: '..', sessionId: '..', digest: { alg: 'sha-256' as const, value: 'd' } };

  it('does not report a malformed reference as bytes that went missing', async () => {
    await expect(checkIntegrity('/state/artifacts', BAD)).rejects.toThrow(ArtifactError);
  });

  it('leaves discarding a malformed reference a no-op rather than a rejection', async () => {
    // Compensation runs on a path that is already failing; throwing there would
    // replace the original error with this one.
    await expect(discardArtifact('/state/artifacts', BAD)).resolves.toBeUndefined();
  });
});

describe('artifact capture', () => {
  let artifactsDir: string;
  let sourceDir: string;
  const sessionId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'tot-artifacts-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'tot-src-'));
  });
  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  function source(name: string, body: string): string {
    const p = join(sourceDir, name);
    writeFileSync(p, body);
    return p;
  }

  it('copies the bytes verbatim rather than transcribing them', async () => {
    const body = 'line one\nline two\nline three\n';
    const ref = await captureArtifact({ artifactsDir, sessionId, sourcePath: source('build.log', body) });
    expect(readFileSync(resolveArtifactPath(artifactsDir, ref), 'utf-8')).toBe(body);
  });

  it('records a digest that describes the STORED bytes', async () => {
    // Digesting the source of a file still being appended would record a digest
    // for bytes that were never stored, so every later check would report a
    // mismatch on a correctly captured artifact.
    const ref = await captureArtifact({ artifactsDir, sessionId, sourcePath: source('a.log', 'hello\n') });
    expect(ref.digest.alg).toBe('sha-256');
    expect(await checkIntegrity(artifactsDir, ref)).toBe('verified');
  });

  it('reports a mismatch once the stored bytes change', async () => {
    const ref = await captureArtifact({ artifactsDir, sessionId, sourcePath: source('a.log', 'hello\n') });
    writeFileSync(resolveArtifactPath(artifactsDir, ref), 'tampered\n');
    expect(await checkIntegrity(artifactsDir, ref)).toBe('mismatch');
  });

  it('reports missing once the stored bytes are gone', async () => {
    const ref = await captureArtifact({ artifactsDir, sessionId, sourcePath: source('a.log', 'hello\n') });
    rmSync(resolveArtifactPath(artifactsDir, ref));
    expect(await checkIntegrity(artifactsDir, ref)).toBe('missing');
  });

  it('never lets a caller-supplied filename become a path component', async () => {
    // The name arrives from a caller, so a traversal in it must not reach the
    // filesystem at capture time — a read-side check cannot undo a copy already
    // written outside the state root.
    const ref = await captureArtifact({
      artifactsDir, sessionId,
      sourcePath: source('ok.log', 'x\n'),
      filename: '../../escape/etc/passwd',
    });
    const stored = resolveArtifactPath(artifactsDir, ref);
    expect(stored.startsWith(artifactsDir)).toBe(true);
    expect(stored).not.toContain('..');
    // The name survives as metadata for display.
    expect(ref.filename).toBe('../../escape/etc/passwd');
  });

  it('stores each capture under its own id so two captures never collide', async () => {
    const a = await captureArtifact({ artifactsDir, sessionId, sourcePath: source('a.log', 'one\n') });
    const b = await captureArtifact({ artifactsDir, sessionId, sourcePath: source('b.log', 'two\n') });
    expect(a.id).not.toBe(b.id);
    expect(readFileSync(resolveArtifactPath(artifactsDir, a), 'utf-8')).toBe('one\n');
    expect(readFileSync(resolveArtifactPath(artifactsDir, b), 'utf-8')).toBe('two\n');
  });

  it('refuses a file past the size cap instead of copying it', async () => {
    const big = source('big.log', 'x'.repeat(ARTIFACT_MAX_BYTES + 1));
    await expect(captureArtifact({ artifactsDir, sessionId, sourcePath: big })).rejects.toThrow(ArtifactError);
    // Nothing was stored for the refused capture.
    expect(existsSync(join(artifactsDir, sessionId))).toBe(false);
  });

  it('refuses a directory, naming it as not a file rather than failing mid-copy', async () => {
    const dir = join(sourceDir, 'nested');
    mkdirSync(dir);
    await expect(captureArtifact({ artifactsDir, sessionId, sourcePath: dir }))
      .rejects.toThrow(/not a file/i);
  });

  it('refuses a source that does not exist', async () => {
    await expect(captureArtifact({ artifactsDir, sessionId, sourcePath: join(sourceDir, 'ghost.log') }))
      .rejects.toThrow(ArtifactError);
  });

  it('counts lines for a text artifact so a viewer can page it', async () => {
    const ref = await captureArtifact({ artifactsDir, sessionId, sourcePath: source('a.log', 'one\ntwo\nthree\n') });
    expect(ref.lineCount).toBe(3);
  });

  it('leaves no temp file behind after a successful capture', async () => {
    const ref = await captureArtifact({ artifactsDir, sessionId, sourcePath: source('a.log', 'x\n') });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(artifactsDir, sessionId))).toEqual([ref.id]);
  });

  it('captures bytes handed over directly, for output that was never a file', async () => {
    const ref = await captureArtifact({ artifactsDir, sessionId, content: 'stdout line\n', filename: 'stdout.txt' });
    expect(readFileSync(resolveArtifactPath(artifactsDir, ref), 'utf-8')).toBe('stdout line\n');
    expect(await checkIntegrity(artifactsDir, ref)).toBe('verified');
  });
});

describe('sniffMediaType', () => {
  it('classifies by extension for the types a viewer renders differently', () => {
    expect(sniffMediaType('build.log')).toBe('text/plain');
    expect(sniffMediaType('trace.txt')).toBe('text/plain');
    expect(sniffMediaType('payload.json')).toBe('application/json');
    expect(sniffMediaType('change.diff')).toBe('text/x-diff');
    expect(sniffMediaType('change.patch')).toBe('text/x-diff');
  });

  it('falls back to a byte stream for anything unrecognized, so it is offered as a download', () => {
    expect(sniffMediaType('capture.bin')).toBe('application/octet-stream');
    expect(sniffMediaType('noextension')).toBe('application/octet-stream');
  });

  it('ignores case and any directory portion of the name', () => {
    expect(sniffMediaType('/tmp/deep/BUILD.LOG')).toBe('text/plain');
  });
});

describe('readLineWindow', () => {
  const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');

  it('returns the requested inclusive line range', async () => {
    const w = await readLineWindow({ read: async () => body, from: 3, to: 5 });
    expect(w.lines).toEqual(['line 3', 'line 4', 'line 5']);
    expect(w.from).toBe(3);
    expect(w.to).toBe(5);
  });

  it('clamps a range past the end rather than failing', async () => {
    const w = await readLineWindow({ read: async () => body, from: 19, to: 500 });
    expect(w.lines).toEqual(['line 19', 'line 20']);
    expect(w.to).toBe(20);
  });

  it('clamps a range starting below the first line', async () => {
    const w = await readLineWindow({ read: async () => body, from: -5, to: 2 });
    expect(w.from).toBe(1);
    expect(w.lines).toEqual(['line 1', 'line 2']);
  });

  it('caps a window so one request cannot pull an unbounded file into a response', async () => {
    const w = await readLineWindow({ read: async () => body, from: 1, to: 20, maxLines: 4 });
    expect(w.lines).toHaveLength(4);
    expect(w.to).toBe(4);
    expect(w.truncated).toBe(true);
  });

  it('reports the total so a caller can page without a second request', async () => {
    const w = await readLineWindow({ read: async () => body, from: 1, to: 2 });
    expect(w.totalLines).toBe(20);
    expect(w.truncated).toBe(false);
  });

  it('returns an empty window for an empty artifact rather than one blank line', async () => {
    const w = await readLineWindow({ read: async () => '', from: 1, to: 10 });
    expect(w.lines).toEqual([]);
    expect(w.totalLines).toBe(0);
  });
});
