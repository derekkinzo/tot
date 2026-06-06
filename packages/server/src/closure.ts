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
 * Returns true when the subtree rooted at id contains a corroborated node
 * reachable through non-pruned ancestors.
 *
 * Caller supplies a lookup callback so this walker is independent of the
 * underlying storage. The engine binds it to its in-memory hypothesis Map;
 * replay paths bind it to the per-session Map built from journal entries.
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
