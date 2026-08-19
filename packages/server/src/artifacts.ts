import { createHash } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { v4 as uuid } from 'uuid';
import type { ArtifactRef } from './types.js';

/**
 * Capture and retrieval of verbatim evidence.
 *
 * The point of an artifact is that nothing paraphrased it: the bytes an agent
 * observed are the bytes stored, and a digest taken from the stored copy lets a
 * later reader confirm they have not changed since.
 */

/** Largest capture accepted. A refusal names the limit; it never truncates,
 *  because a silently shortened log is a paraphrase wearing a digest. */
export const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

/** Default ceiling on a single line window, so one request cannot pull an
 *  arbitrarily large artifact into a response. */
export const ARTIFACT_MAX_WINDOW_LINES = 2000;

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

/** Extensions worth distinguishing because a viewer renders them differently. */
const MEDIA_TYPES: Record<string, string> = {
  '.log': 'text/plain',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.json': 'application/json',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
};

/** Media type for a name, defaulting to a byte stream so an unrecognized
 *  capture is offered as a download rather than rendered as text. */
export function sniffMediaType(filename: string): string {
  return MEDIA_TYPES[extname(basename(filename)).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Where an artifact's bytes live: the session directory, then the artifact id.
 *
 * The caller-supplied filename is never a path component — it could contain a
 * traversal, and a copy already written outside the state root cannot be undone
 * by any check on the read side. Exported so production and tests resolve the
 * layout through one definition.
 */
export function resolveArtifactPath(artifactsDir: string, ref: Pick<ArtifactRef, 'id' | 'sessionId'>): string {
  return join(artifactsDir, ref.sessionId, ref.id);
}

/**
 * Where the artifacts belonging to a set of session journals live: a sibling of
 * the journal directory, so one project directory holds a session and
 * everything it cites, and moving that directory moves both together.
 *
 * The single definition of the layout — {@link getCentralArtifactsDir} and the
 * tool layer both resolve through it, so a reader and a writer cannot disagree
 * about where bytes are.
 */
export function artifactsDirFor(sessionsDir: string): string {
  return resolve(sessionsDir, '..', 'artifacts');
}

export interface CaptureRequest {
  artifactsDir: string;
  sessionId: string;
  /** A file to snapshot. Mutually exclusive with `content`. */
  sourcePath?: string;
  /** Bytes handed over directly, for output that was never a file. */
  content?: string;
  filename?: string;
  command?: string;
  exitCode?: number;
  excerpt?: { startLine: number; endLine: number };
}

/**
 * Snapshots bytes into the artifact store and returns the reference to record.
 *
 * Writes to a temp name, digests the stored copy, then renames into place, so
 * the recorded digest provably describes the bytes a reader will get. Digesting
 * the source instead would describe bytes that were never stored — a log still
 * being appended would then fail every later integrity check.
 */
export async function captureArtifact(req: CaptureRequest): Promise<ArtifactRef> {
  const { artifactsDir, sessionId, sourcePath, content } = req;
  if ((sourcePath === undefined) === (content === undefined)) {
    throw new ArtifactError('Provide exactly one of a source path or inline content to capture');
  }

  if (sourcePath !== undefined) {
    let size: number;
    try {
      const stat = statSync(sourcePath);
      if (!stat.isFile()) throw new ArtifactError(`${sourcePath} is not a file`);
      size = stat.size;
    } catch (err) {
      if (err instanceof ArtifactError) throw err;
      throw new ArtifactError(`Cannot read ${sourcePath}: no such file`);
    }
    if (size > ARTIFACT_MAX_BYTES) {
      throw new ArtifactError(
        `${sourcePath} is ${size} bytes, over the ${ARTIFACT_MAX_BYTES}-byte capture limit. ` +
        'Capture the relevant portion instead of the whole file.',
      );
    }
  } else if (Buffer.byteLength(content!) > ARTIFACT_MAX_BYTES) {
    throw new ArtifactError(
      `Content is ${Buffer.byteLength(content!)} bytes, over the ${ARTIFACT_MAX_BYTES}-byte capture limit.`,
    );
  }

  const id = uuid();
  const filename = req.filename ?? (sourcePath ? basename(sourcePath) : 'capture.txt');
  const sessionDir = join(artifactsDir, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const finalPath = join(sessionDir, id);
  const tempPath = `${finalPath}.partial`;
  try {
    if (sourcePath !== undefined) await copyFile(sourcePath, tempPath);
    else await writeFile(tempPath, content!);

    // Digest and measure the stored copy, not the source.
    const stored = await readFile(tempPath);
    const digest = { alg: 'sha-256' as const, value: createHash('sha256').update(stored).digest('hex') };
    const mediaType = sniffMediaType(filename);
    const lineCount = mediaType.startsWith('text/') || mediaType === 'application/json'
      ? countLines(stored.toString('utf-8'))
      : undefined;

    await rename(tempPath, finalPath);

    return {
      id,
      sessionId,
      filename,
      mediaType,
      bytes: stored.byteLength,
      ...(lineCount === undefined ? {} : { lineCount }),
      digest,
      capturedAt: new Date().toISOString(),
      ...(req.command === undefined ? {} : { command: req.command }),
      ...(req.exitCode === undefined ? {} : { exitCode: req.exitCode }),
      ...(req.excerpt === undefined ? {} : { excerpt: req.excerpt }),
    };
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err instanceof ArtifactError ? err : new ArtifactError(`Capture failed: ${err}`);
  }
}

/** Removes a captured artifact. Used to compensate a capture whose mutation was
 *  not durably recorded, so a refused call leaves no unreferenced bytes. */
export async function discardArtifact(artifactsDir: string, ref: Pick<ArtifactRef, 'id' | 'sessionId'>): Promise<void> {
  await unlink(resolveArtifactPath(artifactsDir, ref)).catch(() => {});
}

/**
 * Whether the stored bytes still match the digest recorded at capture.
 *
 * Recomputed on every read and never stored: a persisted verdict would have
 * replay assert integrity for bytes that may have changed since.
 */
export async function checkIntegrity(
  artifactsDir: string,
  ref: Pick<ArtifactRef, 'id' | 'sessionId' | 'digest'>,
): Promise<'verified' | 'mismatch' | 'missing'> {
  let bytes: Buffer;
  try {
    bytes = await readFile(resolveArtifactPath(artifactsDir, ref));
  } catch {
    return 'missing';
  }
  const alg = ref.digest.alg === 'sha-512' ? 'sha512' : 'sha256';
  const actual = createHash(alg).update(bytes).digest('hex');
  return actual === ref.digest.value ? 'verified' : 'mismatch';
}

export interface LineWindow {
  lines: string[];
  from: number;
  to: number;
  totalLines: number;
  /** True when the requested range was cut to the window cap. */
  truncated: boolean;
}

/**
 * Reads an inclusive, 1-based line range.
 *
 * Takes the read as a parameter so the windowing rules are testable without a
 * filesystem, and clamps rather than failing: a viewer paging near the end of a
 * growing log should get the last lines, not an error.
 */
export async function readLineWindow(req: {
  read: () => Promise<string>;
  from: number;
  to: number;
  maxLines?: number;
}): Promise<LineWindow> {
  const text = await req.read();
  const all = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const maxLines = req.maxLines ?? ARTIFACT_MAX_WINDOW_LINES;

  const from = Math.max(1, Math.min(req.from, Math.max(all.length, 1)));
  const requestedTo = Math.min(req.to, all.length);
  const cappedTo = Math.min(requestedTo, from + maxLines - 1);

  return {
    lines: all.slice(from - 1, cappedTo),
    from,
    to: Math.max(cappedTo, 0),
    totalLines: all.length,
    truncated: cappedTo < requestedTo,
  };
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.replace(/\n$/, '').split('\n').length;
}
