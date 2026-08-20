/**
 * Routing for artifact reads.
 *
 * Kept apart from the HTTP server so the two rules that make these reads safe —
 * that both path components are ids, and that only bytes the tree actually cites
 * are servable — are testable without a socket.
 */
import { ARTIFACT_MAX_WINDOW_LINES, isAddressableId } from './artifacts.js';
import { ARTIFACT_ROUTE_PREFIX } from './types.js';
import type { ArtifactRef, Hypothesis } from './types.js';

export { ARTIFACT_ROUTE_PREFIX };

export type ArtifactRoute =
  | { kind: 'meta'; sessionId: string; artifactId: string }
  | { kind: 'raw'; sessionId: string; artifactId: string }
  | { kind: 'lines'; sessionId: string; artifactId: string; from: number; to: number }
  | { kind: 'invalid' };

/**
 * Resolves an artifact request.
 *
 * Returns `null` for a path that is not an artifact route at all, so the caller
 * can go on matching its other routes, and `{ kind: 'invalid' }` for one that is
 * addressed to this handler but malformed — a distinction the caller needs to
 * answer "no such route" and "bad request" differently.
 */
export function parseArtifactRoute(pathname: string, params: URLSearchParams): ArtifactRoute | null {
  if (pathname !== ARTIFACT_ROUTE_PREFIX && !pathname.startsWith(`${ARTIFACT_ROUTE_PREFIX}/`)) return null;

  const rest = pathname.slice(ARTIFACT_ROUTE_PREFIX.length).replace(/^\//, '');
  if (rest === '') return null;

  const parts = rest.split('/');
  if (parts.length !== 3) return { kind: 'invalid' };
  const [sessionId, artifactId, sub] = parts as [string, string, string];

  // Both ids become path components on disk. Answering that here lets a
  // malformed request be a 400 rather than a refusal raised deeper in.
  if (!isAddressableId(sessionId) || !isAddressableId(artifactId)) return { kind: 'invalid' };

  if (sub === 'meta' || sub === 'raw') return { kind: sub, sessionId, artifactId };
  if (sub !== 'lines') return { kind: 'invalid' };

  const from = readLine(params.get('from'), 1);
  const to = readLine(params.get('to'), ARTIFACT_MAX_WINDOW_LINES);
  if (from === null || to === null || to < from) return { kind: 'invalid' };
  return { kind: 'lines', sessionId, artifactId, from, to };
}

function readLine(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The reference a session's evidence records for `artifactId`, or null.
 *
 * A read is authorized by the tree, not by the filesystem: serving whatever sits
 * at a well-formed path would make stored bytes reachable by guessing an id,
 * including bytes from a capture whose mutation was refused. It also yields the
 * digest and media type, which live in the record rather than on disk.
 */
export function findArtifactRef(hypotheses: Iterable<Hypothesis>, artifactId: string): ArtifactRef | null {
  for (const h of hypotheses) {
    for (const e of h.evidence) {
      if (e.artifact?.id === artifactId) return e.artifact;
    }
  }
  return null;
}
