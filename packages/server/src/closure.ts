import type { Hypothesis, HypothesisStatus } from './types.js';

/**
 * Eliminated and out-of-scope are pruning verdicts: descendants of a pruned
 * branch are moot under the closure rule.
 */
export function isPruned(status: HypothesisStatus): boolean {
  return status === 'eliminated' || status === 'out-of-scope';
}

/**
 * A hypothesis is "live" when it can still accept further work or be
 * reopened. Pruning verdicts are the only excluded states.
 */
export function isLive(status: HypothesisStatus): boolean {
  return !isPruned(status);
}

/**
 * Terminal statuses cannot accept new children. Includes corroborated,
 * which is settled (though revisable by refutation on the leaf itself,
 * not by sprouting a new pending child below it).
 */
export function isTerminal(status: HypothesisStatus): boolean {
  return status === 'eliminated' || status === 'corroborated' || status === 'out-of-scope';
}

/**
 * A hypothesis is "open" when it is an unsettled competitor still inviting
 * work — pending or exploring. Distinct from isLive, which also admits a
 * corroborated (settled) verdict. Use this when listing genuine rivals to
 * discriminate against or branches that still block resolution.
 */
export function isOpen(status: HypothesisStatus): boolean {
  return status === 'pending' || status === 'exploring';
}

/**
 * Returns the open (pending/exploring) nodes that still block a session from
 * resolving, mirroring the engine's closure walk: it descends only through
 * non-pruned ancestors, so a node hiding under an eliminated/out-of-scope
 * branch is moot and excluded. Keeps the corroborate formatter's "resolution
 * pending" list in step with allTopLevelBranchesDisposed.
 */
export function undisposedNodes(
  rootId: string,
  lookup: (id: string) => Hypothesis | undefined,
): Hypothesis[] {
  const result: Hypothesis[] = [];
  const stack: string[] = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = lookup(id);
    if (!node) continue;
    if (isPruned(node.status)) continue; // descendants of a pruned branch are moot
    if (isOpen(node.status)) result.push(node);
    for (const childId of node.children) stack.push(childId);
  }
  return result;
}

/**
 * True when the subtree rooted at id contains a corroborated node reachable
 * through non-pruned ancestors. Engine and replay both call this so closure
 * decisions agree across live and persisted views.
 */
export function subtreeContainsCorroborated(
  rootId: string,
  lookup: (id: string) => Hypothesis | undefined,
): boolean {
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = lookup(id);
    if (!node) continue;
    if (isPruned(node.status)) continue;
    if (node.status === 'corroborated') return true;
    for (const childId of node.children) stack.push(childId);
  }
  return false;
}
