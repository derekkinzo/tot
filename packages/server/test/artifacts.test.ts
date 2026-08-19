import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureArtifact,
  resolveArtifactPath,
  readLineWindow,
  checkIntegrity,
  sniffMediaType,
  ARTIFACT_MAX_BYTES,
  ArtifactError,
} from '../src/artifacts.js';

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
