import { describe, it, expect } from 'vitest';
import { parseArtifactRoute, findArtifactRef, ARTIFACT_ROUTE_PREFIX } from '../src/artifact-routes.js';
import type { ArtifactRef, Evidence, Hypothesis } from '../src/types.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const ARTIFACT = '22222222-2222-4222-8222-222222222222';

function route(pathname: string, query = '') {
  return parseArtifactRoute(pathname, new URLSearchParams(query));
}

describe('parseArtifactRoute', () => {
  it('ignores a path that is not an artifact route, so other routes still match', () => {
    expect(route('/api/state')).toBeNull();
    expect(route('/api/artifacts')).toBeNull();
    expect(route('/index.html')).toBeNull();
  });

  it('resolves the metadata route', () => {
    expect(route(`${ARTIFACT_ROUTE_PREFIX}/${SESSION}/${ARTIFACT}/meta`))
      .toEqual({ kind: 'meta', sessionId: SESSION, artifactId: ARTIFACT });
  });

  it('resolves the raw-bytes route', () => {
    expect(route(`${ARTIFACT_ROUTE_PREFIX}/${SESSION}/${ARTIFACT}/raw`))
      .toEqual({ kind: 'raw', sessionId: SESSION, artifactId: ARTIFACT });
  });

  it('resolves a line window from the query', () => {
    expect(route(`${ARTIFACT_ROUTE_PREFIX}/${SESSION}/${ARTIFACT}/lines`, 'from=10&to=25'))
      .toEqual({ kind: 'lines', sessionId: SESSION, artifactId: ARTIFACT, from: 10, to: 25 });
  });

  it('defaults an unbounded line request to the first window rather than the whole file', () => {
    const r = route(`${ARTIFACT_ROUTE_PREFIX}/${SESSION}/${ARTIFACT}/lines`);
    expect(r).toMatchObject({ kind: 'lines', from: 1 });
    expect((r as { to: number }).to).toBeGreaterThan(1);
  });

  it('rejects a non-uuid id in either position instead of resolving a path from it', () => {
    // Both components name a directory and a file on disk, so anything that is
    // not an id must be refused before it reaches the filesystem.
    for (const p of [
      `${ARTIFACT_ROUTE_PREFIX}/../../etc/${ARTIFACT}/raw`,
      `${ARTIFACT_ROUTE_PREFIX}/${SESSION}/..%2f..%2fpasswd/raw`,
      `${ARTIFACT_ROUTE_PREFIX}/${SESSION}/not-an-id/meta`,
      `${ARTIFACT_ROUTE_PREFIX}/nope/${ARTIFACT}/meta`,
    ]) {
      expect(route(p)).toEqual({ kind: 'invalid' });
    }
  });

  it('rejects an unknown sub-resource rather than guessing one', () => {
    expect(route(`${ARTIFACT_ROUTE_PREFIX}/${SESSION}/${ARTIFACT}/delete`)).toEqual({ kind: 'invalid' });
    expect(route(`${ARTIFACT_ROUTE_PREFIX}/${SESSION}/${ARTIFACT}`)).toEqual({ kind: 'invalid' });
  });

  it('rejects a non-numeric or descending line range', () => {
    expect(route(`${ARTIFACT_ROUTE_PREFIX}/${SESSION}/${ARTIFACT}/lines`, 'from=abc&to=9'))
      .toEqual({ kind: 'invalid' });
    expect(route(`${ARTIFACT_ROUTE_PREFIX}/${SESSION}/${ARTIFACT}/lines`, 'from=9&to=2'))
      .toEqual({ kind: 'invalid' });
  });
});

describe('findArtifactRef', () => {
  function ref(id: string): ArtifactRef {
    return {
      id, sessionId: SESSION, filename: 'build.log', mediaType: 'text/plain', bytes: 4,
      digest: { alg: 'sha-256', value: 'abc' }, capturedAt: '2024-01-01T00:00:00.000Z',
    };
  }
  function hyp(evidence: Evidence[]): Hypothesis {
    return {
      id: 'h', parentId: null, sessionId: SESSION, depth: 0, title: 't', status: 'exploring',
      evidence, metadata: { createdAt: 'x', updatedAt: 'x', source: 'agent' }, children: [],
    };
  }
  const ev = (artifact?: ArtifactRef): Evidence => ({
    id: `e-${artifact?.id ?? 'none'}`, type: 'supports', kind: artifact ? 'artifact' : 'transcription',
    content: 'c', timestamp: 'x', ...(artifact ? { artifact } : {}),
  });

  it('finds the reference recorded on any node of the session', () => {
    const found = findArtifactRef([hyp([ev()]), hyp([ev(ref(ARTIFACT))])], ARTIFACT);
    expect(found?.id).toBe(ARTIFACT);
  });

  it('returns null when no record cites that artifact, so an id cannot be probed', () => {
    // Reads are authorized by the tree, not by the filesystem: bytes nothing
    // references must not be servable just because the id was guessed.
    expect(findArtifactRef([hyp([ev(ref('other-id'))])], ARTIFACT)).toBeNull();
    expect(findArtifactRef([], ARTIFACT)).toBeNull();
  });
});
