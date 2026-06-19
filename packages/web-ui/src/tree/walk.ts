import type { Hypothesis } from '../types';

/**
 * Yields hypotheses from `startId` up to the root, following parentId.
 *
 * Cycle-guarded: stops on a revisit so a malformed parentId loop (corrupt
 * journal) cannot spin forever. Stops when a parentId points at a node not in
 * the map — the walk yields only nodes that exist, ending the chain there
 * (matching the prior `current = node?.parentId ?? null` termination).
 */
export function* walkToRoot(startId: string, hypotheses: Map<string, Hypothesis>): Generator<Hypothesis> {
  const seen = new Set<string>();
  let current: string | null = startId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = hypotheses.get(current);
    if (!node) return; // dangling/missing parent ends the chain
    yield node;
    current = node.parentId;
  }
}
